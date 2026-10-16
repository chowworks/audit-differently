import type { PrismaClient } from '@prisma/client'
import {
  PAYROLL_SLOT_KIND,
  type HighlightField,
  type PayrollDocumentKind,
  type PayrollSlot,
  type StatementMark,
} from '@ad/types'
import { highlightsNow } from '../src/checks/checks.service'
import { matchSlot, type ProofItem } from '../src/payroll/match-proof'
import { readStatement, type StatementText } from '../src/payroll/statement-lines'
import { layoutPdf } from './pdf'

/**
 * The demo's payroll proof: one pay run a month (a program coordinator and the work-experience youth), drawn as the
 * payroll company and the bank would print it, and the highlights each proof carries for each item. The highlights are
 * never typed here: each file is read with the API's own reader and matched with the API's own matcher, as "Match
 * payroll & timecards" does on Save, so the boxes sit on the words of the PDFs below. Fictional names and amounts only.
 */

export interface PayLine {
  name: string
  empNo: string
  group: 'Staff' | 'Work experience'
  hours: number
  gross: number
}

export interface PayRun {
  runId: string
  /** yyyy-mm-dd */
  start: string
  end: string
  payDate: string
  /** The day the payroll company debits the bank account. */
  debitDate: string
  lines: PayLine[]
  employerTaxes: number
  fees: number
}

/** 09/07/2026, as the payroll company and the bank print a date. */
export const us = (iso: string) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`
export const money = (n: number) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const sum = (ns: number[]) => Math.round(ns.reduce((a, b) => a + b, 0) * 100) / 100
export const staffTotal = (run: PayRun) =>
  sum(run.lines.filter((l) => l.group === 'Staff').map((l) => l.gross))
export const youthTotal = (run: PayRun) =>
  sum(run.lines.filter((l) => l.group === 'Work experience').map((l) => l.gross))

const COMPANY = 'Riverbend Youth Services'
const TABLE = [48, 150, 235, 300, 365, 420, 480]

/** The payroll company's time report for the run: one row per person, with the pay period and gross pay. */
export function timesheetPdf(run: PayRun): Promise<Buffer> {
  const at = TABLE
  return layoutPdf('Time & jobs report', [
    [COMPANY, '·', 'pay period', us(run.start), '-', us(run.end)],
    'PayPeople Payroll (fictional)',
    null,
    { at, cells: ['Employee', 'Pay run', 'Start date', 'End date', 'Gross pay', 'Hours', 'Group'] },
    ...run.lines.map((l) => ({
      at,
      cells: [
        l.name,
        run.runId,
        us(run.start),
        us(run.end),
        money(l.gross),
        l.hours.toFixed(1),
        l.group === 'Staff' ? 'Staff' : 'WEX',
      ],
    })),
    null,
    { at, cells: ['Staff total', '', '', '', money(staffTotal(run))] },
    { at, cells: ['Work experience total', '', '', '', money(youthTotal(run))] },
    'Hours approved by the site supervisor for each pay period.',
  ])
}

/** The payroll register: the pay period, the pay date, each person's gross, and what the bank is debited. */
export function registerPdf(run: PayRun): Promise<Buffer> {
  const at = [48, 200, 330, 420]
  const wages = sum(run.lines.map((l) => l.gross))
  return layoutPdf('Payments report', [
    [`Pay run ${run.runId}:`, COMPANY],
    ['Pay period', us(run.start), '-', us(run.end)],
    ['Pay date', us(run.payDate)],
    'Provider: PayPeople Payroll (fictional)',
    null,
    { at, cells: ['Employee', 'Group', 'Hours', 'Gross pay'] },
    ...run.lines.map((l) => ({
      at,
      cells: [`${l.name} (no. ${l.empNo})`, l.group, l.hours.toFixed(1), money(l.gross)],
    })),
    null,
    { at, cells: ['Staff wages debit', '', '', money(staffTotal(run))] },
    { at, cells: ['Work experience wages debit', '', '', money(youthTotal(run))] },
    { at, cells: ['Employer taxes debit', '', '', money(run.employerTaxes)] },
    { at, cells: ['Payroll fees', '', '', money(run.fees)] },
    { at, cells: ['Total cost', '', '', money(sum([wages, run.employerTaxes, run.fees]))] },
  ])
}

/** One person's earnings statement (a personal document): who, the pay period, the pay date and the pay. */
export function stubPdf(run: PayRun, l: PayLine): Promise<Buffer> {
  const withheld = Math.round(l.gross * 0.0765 * 100) / 100
  return layoutPdf('Earnings statement', [
    [`Worksite employer: ${COMPANY}`, '·', 'paid through PayPeople Payroll (fictional)'],
    // Each part of the name its own run, so a name highlight covers exactly that word.
    ['Paid to:', ...l.name.split(' '), `(employee no. ${l.empNo})`],
    ['Pay period', us(run.start), '-', us(run.end), '·', 'Pay date', us(run.payDate)],
    null,
    ['Base pay', `${l.hours.toFixed(2)} hours`, '=', money(l.gross)],
    ['Social Security and Medicare', money(withheld)],
    ['Net pay', money(Math.round((l.gross - withheld) * 100) / 100)],
    'Direct deposit to account ending 0000',
  ])
}

/** A statement row: the day, what the bank calls it, and the amount out (or in, for a deposit). */
export interface BankRow {
  date: string
  description: string
  out?: number
  in?: number
}

/** The month's bank statement, one row per transaction, date first. */
export function bankStatementPdf(
  company: string,
  period: string,
  rows: BankRow[]
): Promise<Buffer> {
  const at = [48, 120, 430, 510]
  const [y, m] = period.split('-').map(Number) as [number, number]
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return layoutPdf('Lakeside Community Bank (fictional)', [
    [`Business checking statement · ${company} · account ending 0000`],
    ['Statement period', `${period.slice(5)}/01/${y}`, '-', `${period.slice(5)}/${last}/${y}`],
    null,
    { at, cells: ['Date', 'Description', 'Withdrawals', 'Deposits'] },
    ...[...rows]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((r) => ({
        at,
        cells: [
          us(r.date),
          r.description,
          r.out != null ? money(r.out) : '',
          r.in != null ? money(r.in) : '',
        ],
      })),
  ])
}

/** What the platform highlights on each kind of proof: the newest setting per kind, else the defaults (as the API). */
export const highlightFields = (prisma: PrismaClient) =>
  highlightsNow(prisma) as Promise<Record<PayrollDocumentKind, HighlightField[]>>

const box = (m: StatementMark): StatementMark => ({
  page: m.page,
  x: m.x,
  y: m.y,
  width: m.width,
  height: m.height,
  ...(m.text?.trim() ? { text: m.text.replace(/\s+/g, ' ').trim().slice(0, 300) } : {}),
})

/** A proof file as the seed knows it: its kind, name and bytes, read once. */
export class ProofReader {
  private read = new Map<Buffer, Promise<StatementText>>()
  constructor(private readonly fields: Record<PayrollDocumentKind, HighlightField[]>) {}

  /**
   * The line and the exact words one proof shows for one item, worked out as Save does (`payroll-match.service.ts`):
   * the matcher's best line on this one file, and the highlights the platform asks for on its kind of proof.
   */
  async marks(
    item: ProofItem,
    slot: PayrollSlot,
    file: { fileName: string; bytes: Buffer }
  ): Promise<{ mark: StatementMark | null; marks: StatementMark[] }> {
    if (!this.read.has(file.bytes)) this.read.set(file.bytes, readStatement(file.bytes))
    const text = await this.read.get(file.bytes)!
    const kind = PAYROLL_SLOT_KIND[slot]
    const found = matchSlot(
      item,
      slot,
      [{ id: 'seed', kind, fileName: file.fileName, lines: text.lines, items: text.items }],
      this.fields[kind]
    ).candidates[0]
    return {
      mark: found?.mark ? box(found.mark) : null,
      marks: (found?.marks ?? []).slice(0, 20).map(box),
    }
  }
}
