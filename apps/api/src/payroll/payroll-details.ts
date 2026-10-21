import type { StatementLine } from '@ad/types'
import * as ExcelJS from 'exceljs'
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
  /** Pay itself (a salaries account), not the employer's taxes or benefits. */
  pay: boolean
  /** A work-experience participant's pay or cost (the account says so). */
  wex: boolean
  line: StatementLine
}

const DESCRIPTION =
  /\[[^\]]+\]\s+(.+?)\s+for\s+(?:(.+?)\s+jobs?\s+for\s+)?(.+?)\.\s+Payroll run:\s*([A-Za-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?)\s*[-–]\s*([A-Za-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?)/i
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** "Dec 28th" with the row's date (yyyy-mm-dd): the day, in the year that puts it on or before that date. */
function dayOf(words: string, rowDate: string | null): string | null {
  const m = /([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{1,2})/.exec(words)
  const month = m ? MONTHS.indexOf(m[1]!.toLowerCase()) : -1
  if (!m || month < 0 || !rowDate) return null
  let year = Number(rowDate.slice(0, 4))
  const day = `${String(month + 1).padStart(2, '0')}-${m[2]!.padStart(2, '0')}`
  if (`${year}-${day}` > rowDate) year -= 1
  return `${year}-${day}`
}

/** The charges payroll details shows: every row whose description names the person and the run, with its amount. */
export function chargesOf(lines: StatementLine[]): PayrollCharge[] {
  const out: PayrollCharge[] = []
  for (const line of lines) {
    const cells = line.text.split(CELL)
    const described = cells.map((c) => DESCRIPTION.exec(c)).find((m) => !!m)
    if (!described) continue
    const date = cells.find((c) => /^\d{4}-\d{2}-\d{2}$/.test(c)) ?? null
    const amount = [...cells]
      .reverse()
      .map((c) => Number(c.replace(/[$,\s]/g, '')))
      .find((n) => Number.isFinite(n) && /\d/.test(String(n)) && n !== 0)
    if (amount === undefined) continue
    const account =
      cells.find((c) => !DESCRIPTION.test(c) && /[A-Za-z]/.test(c) && c.includes(':')) ?? ''
    const words = `${account} ${described[1]}`
    const end = dayOf(described[5]!, date)
    out.push({
      name: described[3]!.trim(),
      type: described[1]!.trim(),
      job: described[2]?.trim() ?? null,
      account: account.split(':').pop()!.trim(),
      amount: Math.round(amount * 100) / 100,
      date,
      start: end ? dayOf(described[4]!, end) : null,
      end,
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
    if (m.x > 0) row.getCell(m.x).fill = YELLOW
    else row.eachCell({ includeEmpty: true }, (cell) => (cell.fill = YELLOW))
  }
  return Buffer.from(await book.xlsx.writeBuffer())
}
