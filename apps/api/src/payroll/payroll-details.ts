import type { StatementLine } from '@ad/types'
import * as ExcelJS from 'exceljs'
import { csvText, parseCsv } from '../imports/table'
import { programKey } from '@ad/types'
import { personIn } from './match-proof'

/**
 * Payroll details (GitHub issue #22, section 8; owner's decisions, 2026-10-19): the payroll company's per-person export,
 * one row per person, payroll run, pay type and job, with the account it is booked to, e.g.
 *
 *   2026-09-11 | [PayPeople] Salary for Youth Coding Program jobs for Morgan Lee. Payroll run: Aug 24th - Sep 6th | … | 612.50
 *
 * It is a spreadsheet: each row is read as one line (`sheetLines`), its cells joined by " | " (column A first, empty cells
 * kept), so the match keeps the row's own words as its proof, and each item's copy fills that person's cells yellow
 * (`sheetCopy`). A row is a charge when its description names the person and the run.
 */

/** Between cells of a row read as a line. */
const CELL = ' | '

/** Every row of every sheet as a line: the sheet is its page, the row its place on it; cells joined by " | ". */
export async function sheetLines(bytes: Buffer): Promise<StatementLine[]> {
  const book = new ExcelJS.Workbook()
  await book.xlsx.load(bytes as unknown as ArrayBuffer)
  const lines: StatementLine[] = []
  book.worksheets.forEach((sheet, i) =>
    sheet.eachRow((row, n) => {
      // Every cell from column A, empty ones kept, so the n-th cell of the text is column n (a copy fills that cell).
      const values = row.values as unknown[]
      const cells = Array.from({ length: Math.max(0, values.length - 1) }, (_, c) =>
        cellText(values[c + 1])
      )
      while (cells.length && cells[cells.length - 1] === '') cells.pop()
      if (cells.some((c) => c !== ''))
        lines.push({ page: i + 1, x: 0, y: n, width: 1, height: 1, text: cells.join(CELL) })
    })
  )
  return lines
}

/** A payroll CSV is stored like any upload (up to 25 MB): a company-wide export has far more rows than an import. */
const PAYROLL_CSV_LIMITS = { rows: 500_000, columns: 1_000 }

/**
 * A CSV's rows as lines, as `sheetLines` reads a spreadsheet's (one page, cells joined by " | "): payroll companies
 * export their journals and job reports as CSV. The bytes must be UTF-8 text with no NUL byte.
 */
export function csvLines(bytes: Buffer): StatementLine[] {
  const lines: StatementLine[] = []
  parseCsv(csvText(bytes), PAYROLL_CSV_LIMITS).forEach((row, i) => {
    const cells = row.map((c) => c.trim())
    while (cells.length && cells[cells.length - 1] === '') cells.pop()
    if (cells.length)
      lines.push({ page: 1, x: 0, y: i + 1, width: 1, height: 1, text: cells.join(CELL) })
  })
  return lines
}

/** A cell as text: a date as yyyy-mm-dd, a formula or link as its value, a number as it is. */
function cellText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'object') {
    const o = v as { result?: unknown; text?: unknown; richText?: { text: string }[] }
    if (o.richText)
      return o.richText
        .map((r) => r.text)
        .join('')
        .trim()
    return cellText(o.result ?? o.text ?? '')
  }
  return String(v).trim()
}

/** One row of payroll details: whose pay, of which run and job, booked to which account, and how much. */
export interface PayrollCharge {
  /** The name as the row prints it. */
  name: string
  /** "Salary", "Base Pay", "Employer Medicare Tax", … */
  type: string
  /** The job it is charged to, when the row names one. */
  job: string | null
  account: string
  amount: number
  /** The row's date (yyyy-mm-dd): the run's pay date, as payroll details prints it; null when the row has none. */
  date: string | null
  /** The run's pay period, yyyy-mm-dd, read from "Payroll run: Dec 28th - Jan 10th" and the row's date. */
  start: string | null
  end: string | null
  /** The program the row is booked to, as its class or project column names it (null without such a column). */
  program: string | null
  /** Pay itself (a salaries account), not the employer's taxes or benefits. */
  pay: boolean
  /** A work-experience participant's pay or cost (the account says so). */
  wex: boolean
  line: StatementLine
}

const DESCRIPTION =
  /\[[^\]]+\]\s+(.+?)\s+for\s+(?:(.+?)\s+jobs?\s+for\s+)?(.+?)\.\s+Payroll run:\s*([A-Za-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?)\s*[-–]\s*([A-Za-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?)/i
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/**
 * "Dec 28th" with a date (yyyy-mm-dd): the day, in the year that puts it on or before that date; or, `nearest`, up to a
 * month after it (a run's end beside the row's date, which may be a few days before it: a reversal booked on the 1st of
 * the month for the run ending on the 11th).
 */
function dayOf(words: string, near: string | null, nearest = false): string | null {
  const m = /([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{1,2})/.exec(words)
  const month = m ? MONTHS.indexOf(m[1]!.toLowerCase()) : -1
  if (!m || month < 0 || !near) return null
  const year = Number(near.slice(0, 4))
  const day = `${String(month + 1).padStart(2, '0')}-${m[2]!.padStart(2, '0')}`
  // On or before the date; with `nearest`, up to a month after it too.
  if (nearest && Date.parse(`${year}-${day}`) - Date.parse(near) <= 31 * 86_400_000)
    return `${year}-${day}`
  return `${`${year}-${day}` > near ? year - 1 : year}-${day}`
}

/** How a header cell reads for matching: lower case, single spaces. */
const headerKey = (h: string) => h.trim().toLowerCase().replace(/\s+/g, ' ')

/** The header words of the columns a charge is read from, in the order they are tried. */
const HEADERS = {
  amount: (k: string) => k === 'amount' || / amount$/.test(k),
  date: (k: string) =>
    ['date', 'transaction date', 'txn date', 'posting date', 'pay date', 'check date'].includes(k),
  account: (k: string) =>
    ['account', 'account name', 'account full name', 'gl account', 'distribution account'].includes(
      k
    ),
  description: (k: string) =>
    ['description', 'memo/description', 'memo', 'memo / description'].includes(k),
  program: (k: string) =>
    [
      'class',
      'class full name',
      'class name',
      'project',
      'projects',
      'client projects',
      'job',
    ].includes(k),
} as const
type Column = keyof typeof HEADERS

/**
 * A sheet's header row (an accounting export puts its title, company and dates above it): the first row with an amount
 * column and at least one other column named, and the column number of each. Null when the sheet has none: each row is
 * then read by its cells alone.
 */
function headerOf(lines: StatementLine[]): Partial<Record<Column, number>> | null {
  for (const line of lines) {
    const keys = line.text.split(CELL).map(headerKey)
    if (keys.some((k) => /\d/.test(k))) continue
    const at: Partial<Record<Column, number>> = {}
    for (const col of Object.keys(HEADERS) as Column[]) {
      // An exact "Amount" wins over "Allocated amount"; otherwise the first column the words fit.
      const exact = col === 'amount' ? keys.indexOf('amount') : -1
      const i = exact >= 0 ? exact : keys.findIndex(HEADERS[col])
      if (i >= 0) at[col] = i
    }
    if (at.amount !== undefined && Object.keys(at).length >= 2) return at
  }
  return null
}

/** A date cell as yyyy-mm-dd: 2026-09-17, or 09/17/2026 and 9/17/26 as US accounting exports write them as text. */
function dateCell(cell: string | undefined): string | null {
  const t = (cell ?? '').trim()
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t)
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})$/.exec(t)
  const [y, m, d] = iso
    ? [+iso[1]!, +iso[2]!, +iso[3]!]
    : us
      ? [us[3]!.length === 2 ? 2000 + +us[3]! : +us[3]!, +us[1]!, +us[2]!]
      : [0, 0, 0]
  if (!y) return null
  const date = new Date(Date.UTC(y, m - 1, d))
  if (date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null
  return date.toISOString().slice(0, 10)
}

const amountCell = (c: string | undefined) => {
  const n = Number((c ?? '').replace(/[$,\s]/g, ''))
  return (c ?? '').trim() !== '' && Number.isFinite(n) ? n : null
}

/**
 * An account on the balance sheet, not an expense: a ledger that books a payroll journal entry lists its liabilities
 * (the employee's deductions, taxes owed) and the bank beside the expense rows, with the same description. Told by the
 * account's words, or by its number where the chart of accounts is numbered the usual way (1 assets, 2 liabilities,
 * 3 equity).
 */
export const balanceSheetAccount = (account: string) => {
  const top = account.split(':')[0] ?? ''
  if (/liabilit|payable|receivable|accrued|\bassets?\b|equity|\bbank\b|checking|savings/i.test(top))
    return true
  // A number alone says so only when the words do not name a cost ("1099 Contract Labor" is an expense).
  return (
    /^\s*[123]\d{3,}\b/.test(top) &&
    !/expense|salar|wage|payroll|labor|contract|benefit|tax|cost|fee/i.test(account)
  )
}

/**
 * The charges payroll details shows: every row whose description names the person and the run, with its amount. A sheet
 * with a header row is read by its columns (the amount, date, account and class or project columns named there, as an
 * accounting export lays them out); one without, by its cells (the date cell, the account with a ":", the last amount).
 * A row booked to a balance-sheet account is not a cost of the program and is left out.
 */
export function chargesOf(lines: StatementLine[]): PayrollCharge[] {
  const out: PayrollCharge[] = []
  const headers = new Map<number, Partial<Record<Column, number>> | null>()
  for (const line of lines) {
    if (!headers.has(line.page))
      headers.set(line.page, headerOf(lines.filter((l) => l.page === line.page)))
    const header = headers.get(line.page)!
    const cells = line.text.split(CELL)
    const described = cells.map((c) => DESCRIPTION.exec(c)).find((m) => !!m)
    if (!described) continue
    const at = (col: Column) => (header?.[col] !== undefined ? cells[header[col]!] : undefined)
    // By the header's columns; a row too short to reach its amount column, or with no date in its date column (a sheet
    // whose header does not line up with its rows), is read by its cells, as a sheet without a header is. A row that
    // reaches the amount column is read there only: its other numbers (a transaction's id) are never its amount.
    const date = dateCell(at('date')) ?? cells.map(dateCell).find((d) => !!d) ?? null
    // A row lines up with the header when its description is in the header's description column (or the row reaches
    // the amount column): then a blank amount there is no amount, never another number of the row.
    const lined =
      header?.amount !== undefined &&
      (header.description !== undefined
        ? !!DESCRIPTION.exec(cells[header.description] ?? '')
        : cells.length > header.amount)
    const inColumn = lined
    const amount = inColumn
      ? (amountCell(at('amount')) ?? undefined)
      : [...cells]
          .reverse()
          .map((c) => Number(c.replace(/[$,\s]/g, '')))
          .find((n) => Number.isFinite(n) && /\d/.test(String(n)) && n !== 0)
    if (amount === undefined || amount === 0) continue
    const byHeader = (at('account') ?? '').trim()
    const account =
      byHeader && /[A-Za-z]/.test(byHeader)
        ? byHeader
        : (cells.find((c) => !DESCRIPTION.test(c) && /[A-Za-z]/.test(c) && c.includes(':')) ?? '')
    if (balanceSheetAccount(account)) continue
    const words = `${account} ${described[1]}`
    const end = dayOf(described[5]!, date, true)
    out.push({
      name: described[3]!.trim(),
      type: described[1]!.trim(),
      job: described[2]?.trim() ?? null,
      account: account.split(':').pop()!.trim(),
      amount: Math.round(amount * 100) / 100,
      date,
      start: end ? dayOf(described[4]!, end) : null,
      end,
      program: at('program')?.trim() || null,
      pay: /salar|wage/i.test(account) && !/tax|benefit|deduction|contribution/i.test(words),
      wex: /work experience|\bwex\b/i.test(account),
      line,
    })
  }
  return out
}

/** One person's pay in one run, as payroll details charges it: the pay rows added up, the first row, and every row of theirs
 * in that run (pay, the employer's taxes and benefits), which their copy highlights. */
export interface ChargedPay {
  start: string | null
  end: string | null
  amount: number
  line: StatementLine
  lines: StatementLine[]
}

/** A person's pay per run in payroll details, by the name on our list; [] when it charges them no pay. */
export function chargedPayOf(charges: PayrollCharge[], name: string): ChargedPay[] {
  const byRun = new Map<string, ChargedPay>()
  for (const c of charges) {
    if (!personIn(c.name, name)) continue
    const key = `${c.start}|${c.end}`
    const had = byRun.get(key)
    const pay = c.pay ? c.amount : 0
    if (had) {
      had.amount = Math.round((had.amount + pay) * 100) / 100
      had.lines.push(c.line)
      if (c.pay && !had.line) had.line = c.line
    } else
      byRun.set(key, { start: c.start, end: c.end, amount: pay, line: c.line, lines: [c.line] })
  }
  return [...byRun.values()].filter((r) => r.amount > 0)
}

/** At most this many highlights on one item's copy (the database keeps 20). */
const MAX_SHEET_MARKS = 20

/**
 * What to fill on an item's copy of payroll details, from the highlights a platform admin picked for it: each row
 * whole (x 0), or its cells with the name, the amount and the pay period (x the column, from 1). The row's words are kept.
 */
export function sheetMarks(
  lines: StatementLine[],
  name: string,
  fields: readonly string[]
): StatementLine[] {
  const out: StatementLine[] = []
  const add = (l: StatementLine, x: number, text: string) =>
    out.length < MAX_SHEET_MARKS &&
    out.push({ page: l.page, x, y: l.y, width: 1, height: 1, text: text.slice(0, 300) })
  for (const l of lines) {
    if (fields.includes('row')) {
      add(l, 0, l.text)
      continue
    }
    const cells = l.text.split(CELL)
    const col = (test: (c: string) => boolean) => cells.findIndex(test) + 1
    const picks = new Set<number>()
    if (fields.includes('name')) picks.add(col((c) => personIn(c, name)))
    if (fields.includes('payPeriod') || fields.includes('payDate'))
      picks.add(col((c) => /payroll run:|\d{4}-\d{2}-\d{2}/i.test(c)))
    if (fields.includes('amount')) {
      const last = [...cells]
        .reverse()
        .findIndex((c) => /\d/.test(c) && Number.isFinite(Number(c.replace(/[$,\s]/g, ''))))
      if (last >= 0) picks.add(cells.length - last)
    }
    for (const x of picks) if (x > 0) add(l, x, cells[x - 1]!)
  }
  return out
}

const YELLOW = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF176' } } as const

/**
 * Fills one cell yellow. A loaded workbook's cells share one style object among all cells of the same format, so the
 * fill goes on a copy of this cell's style: set on the shared one (`cell.fill = …`), it filled every row of that format.
 */
const fill = (cell: ExcelJS.Cell) => {
  cell.style = { ...cell.style, fill: YELLOW }
}

/** An item's own copy of payroll details: the original, untouched but for its highlights filled yellow. */
export async function sheetCopy(
  bytes: Uint8Array,
  marks: { page: number; x: number; y: number }[]
): Promise<Buffer> {
  const book = new ExcelJS.Workbook()
  await book.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer)
  for (const m of marks) {
    const sheet = book.worksheets[m.page - 1]
    if (!sheet) continue
    const row = sheet.getRow(m.y)
    if (m.x > 0) fill(row.getCell(m.x))
    else row.eachCell({ includeEmpty: true }, fill)
  }
  return Buffer.from(await book.xlsx.writeBuffer())
}

/**
 * Which program a text names (a charge's job or class, a job report's project cell): the one with a name that is the
 * text; else the one whose longest name the text holds as whole words. Undefined when it names none of them; null when
 * two tie (never a guess).
 */
export function programIn<K>(
  text: string,
  programs: readonly { id: K; names: readonly string[] }[]
): K | null | undefined {
  const t = programKey(text)
  if (!t) return undefined
  const exact = [
    ...new Set(programs.filter((p) => p.names.some((n) => programKey(n) === t)).map((p) => p.id)),
  ]
  if (exact.length) return exact.length === 1 ? exact[0]! : null
  const padded = ` ${t} `
  let best = 0
  let hits: K[] = []
  for (const p of programs)
    for (const n of p.names) {
      const k = programKey(n)
      if (!k || !padded.includes(` ${k} `)) continue
      if (k.length > best) {
        best = k.length
        hits = [p.id]
      } else if (k.length === best && !hits.includes(p.id)) hits.push(p.id)
    }
  return hits.length ? (hits.length === 1 ? hits[0]! : null) : undefined
}

/**
 * The engagement a charge is for. A charge that names its program (the job in its description, else its class or project
 * column) is for the engagement that goes by that name (`programIn`). It must be one of the person's own: a program that
 * is another engagement, or none here, is not theirs to carry, whatever list they are on. A charge that names no program
 * is the person's only engagement's; on several, no one's.
 */
export function engagementOfCharge(
  charge: { job: string | null; program?: string | null },
  ids: string[],
  names: Map<string, string[]>
): { id: string | null; why?: 'no-engagement' | 'other-program' } {
  const texts = [charge.job, charge.program ?? null].filter(
    (t): t is string => !!programKey(t ?? '')
  )
  if (!texts.length) return ids.length === 1 ? { id: ids[0]! } : { id: null, why: 'no-engagement' }
  const programs = [...names.entries()].map(([id, ns]) => ({ id, names: ns }))
  for (const t of texts) {
    const hit = programIn(t, programs)
    if (hit === null) return { id: null, why: 'no-engagement' }
    if (hit !== undefined)
      return ids.includes(hit) ? { id: hit } : { id: null, why: 'other-program' }
  }
  return { id: null, why: 'other-program' }
}
