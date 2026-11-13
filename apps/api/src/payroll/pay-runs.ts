import type { AiFileFacts, PayrollRunEntry, StatementLine } from '@ad/types'
import { payLinesOf } from './pay-lines'
import { reader } from './reading'
import { amountPattern } from './statement-lines'

/**
 * A pay run's bank debit (owner's decision, 2026-10-19): a bank statement shows payroll leaving as one debit per pay run
 * (and the payroll taxes as another), never one line per person; each person is on the payroll register. So the bank
 * line that proves a run's pay is the one whose amount is what the register says the run debits, on a date near its pay
 * date, and it proves every payroll item paid in that run. Both payroll match screens read it from here: the owner's
 * workspace match (`staff-match.ts`) and the bookkeeper's per-engagement Auto-Match (`match-proof.ts`).
 */

const MONEY_ALL = /(?<![\d.,])\$?\s?(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}(?!\d)/g
const round = (n: number) => Math.round(n * 100) / 100

/** Every amount the text prints, in order: 1,640.22, $280.00 and 2000.00. */
export function amountsOn(text: string): number[] {
  return [...text.matchAll(MONEY_ALL)]
    .map((m) => Number(m[0].replace(/[$,\s]/g, '')))
    .filter((n) => Number.isFinite(n))
}

const iso = (y: number, m: number, d: number) =>
  m >= 1 && m <= 12 && d >= 1 && d <= 31
    ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    : null

const MONTH_WORDS = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
]
const MONTH = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?'
/** "Oct 6, 2026", "September 16th 2026", and a range in one month or two: "Sep 16 – 30, 2026", "Sep 28 – Oct 3, 2026". */
const NAMED = new RegExp(
  `(?<![A-Za-z0-9])${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*[-–—]\\s*(?:${MONTH}\\s+)?(\\d{1,2})(?:st|nd|rd|th)?)?,?\\s+((?:19|20)\\d{2})(?!\\d)`,
  'gi'
)

/** The dates a month written in words gives, each with where it starts: one, or a range's two. */
function namedDates(text: string): { at: number; date: string }[] {
  const out: { at: number; date: string }[] = []
  for (const m of text.matchAll(NAMED)) {
    const year = +m[5]!
    const first = MONTH_WORDS.indexOf(m[1]!.slice(0, 3).toLowerCase()) + 1
    const a = iso(year, first, +m[2]!)
    if (a) out.push({ at: m.index ?? 0, date: a })
    if (m[4]) {
      const second = m[3] ? MONTH_WORDS.indexOf(m[3].slice(0, 3).toLowerCase()) + 1 : first
      // A range across the new year ("Dec 28 – Jan 10, 2027") starts in the year before.
      if (a && second < first) out[out.length - 1]!.date = iso(year - 1, first, +m[2]!)!
      const b = iso(year, second, +m[4])
      if (b) out.push({ at: (m.index ?? 0) + 1, date: b })
    }
  }
  return out
}

/**
 * Every date written in the text, as yyyy-mm-dd, in reading order: 09/07/2026, 9.7.26, 2026-09-07, 20260907, and a
 * month in words ("Oct 6, 2026"; a range "Sep 16 – 30, 2026" gives both).
 */
export function datesOf(text: string): string[] {
  return datesInOrder(text)
}

/** A bank line's dates: full dates, or a month and day alone (09/24) in the given year, as statements often print. */
function bankDates(text: string, year: number): string[] {
  const full = datesOf(text)
  if (full.length) return full
  return [...text.matchAll(/(?<![\d/.])(\d{1,2})\/(\d{1,2})(?![\d/])/g)]
    .map((m) => iso(year, +m[1]!, +m[2]!))
    .filter((d): d is string => !!d)
}

export const daysBetween = (a: string, b: string) =>
  Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000

// ── A register's layout ────────────────────────────────────────────────────

/** A register's column labels, in the order a heading prints them. YTD columns are told apart from this period's. */
const COLUMN =
  /\b(?:(ytd|year[- ]to[- ]date)(?:\s+(?:gross|net|pay|earnings|total))?|(gross)(?:\s+(?:pay|wages|earnings))?|(total\s+(?:pay|earnings|wages))|(net)(?:\s+pay)?|(pay\s+rate|hourly\s+rate|rate)|(hours(?:\s+worked)?|hrs)|(earnings)|(taxes|tax|fica|medicare|deductions?|withholding))\b/gi
export type Column = 'ytd' | 'gross' | 'net' | 'rate' | 'hours' | 'other'

/** What a register's heading row says of its columns. */
export interface RegisterLayout {
  /** The money columns in order (each row prints one amount per column), when a heading names them. */
  columns: Column[] | null
}

const HEADING_WORDS = /\b(name|gross|net|hours|pay|earnings)\b/i

/** A register's layout from its heading row (a line with no amount that names its columns); none when it has none. */
export function registerLayout(lines: StatementLine[]): RegisterLayout {
  const headings = lines.filter((l) => !amountsOn(l.text).length && HEADING_WORDS.test(l.text))
  const pay = headings.find((l) => /\bgross\b|\btotal\s+pay\b|\bearnings\b/i.test(l.text))
  let columns: Column[] | null = null
  if (pay) {
    columns = [...pay.text.matchAll(COLUMN)].map((m) =>
      m[1]
        ? 'ytd'
        : m[2] || m[3] || m[7]
          ? 'gross'
          : m[4]
            ? 'net'
            : m[5]
              ? 'rate'
              : m[6]
                ? 'hours'
                : 'other'
    )
    if (!columns.includes('gross')) columns = null
  }
  return { columns }
}

/** The row's net, when the register's heading names a net column the row has an amount for. */
export function netOnRow(text: string, layout: RegisterLayout): number | null {
  const all = amountsOn(text)
  if (!layout.columns || all.length !== layout.columns.length) return null
  const i = layout.columns.indexOf('net')
  return i >= 0 ? all[i]! : null
}

// ── Pay runs ───────────────────────────────────────────────────────────────

// The labels a register states its run's bank debit under, and how far the debit may be from the pay date (or after the
// period ends, with no pay date), are the admin's reading words (`reader()`): Admin tools → Payroll reading.

/** One pay run as its register states it, and the bank line that debited it (null when none was found). */
export interface PayRun {
  /** The register's file. */
  fileId: string
  /** yyyy-mm-dd, as the register prints them; null when it does not. */
  payDate: string | null
  start: string | null
  end: string | null
  /** What the register says the run debits, best first (its stated totals, else its net column added up). */
  totals: number[]
  debit: { fileId: string; line: StatementLine; amount: number } | null
}

interface RunFile {
  id: string
  kind: string
  lines: StatementLine[]
  /** What AI read from the file when a person asked, every value found in its text: it wins over the rules' reading. */
  ai?: AiFileFacts | null
}

/** The amount right after a label on the line. */
function amountAfter(text: string, label: RegExp): number | null {
  const m = label.exec(text)
  if (!m) return null
  const [first] = amountsOn(text.slice(m.index + m[0].length))
  return first ?? null
}

/** A register's pay run: its pay date, pay period and stated totals. */
export function payRunOf(file: RunFile): Omit<PayRun, 'debit'> {
  const lines = Array.isArray(file.lines) ? file.lines : []
  const read = reader()
  const payDate = file.ai?.payDate ?? payDateOn(lines)
  const p = periodOn({ lines, ai: file.ai })
  const period = p ? [p.start, p.end] : []
  // The totals AI found first (each shown on a line of the file), then the rules' own.
  const totals: number[] = [...(file.ai?.totals ?? [])]
  for (const label of read.debitTotals)
    for (const l of lines) {
      const a = amountAfter(l.text, label)
      if (a !== null && a > 0 && !totals.includes(a)) totals.push(a)
    }
  if (!totals.length) {
    // No stated total: the net column added up, row by row, when the heading names one.
    const layout = registerLayout(lines)
    const nets = payLinesOf(file)
      .map((l) => (l ? netOnRow(l.text, layout) : null))
      .filter((n): n is number => n !== null)
    if (nets.length) totals.push(round(nets.reduce((t, n) => t + n, 0)))
  }
  return {
    fileId: file.id,
    payDate,
    start: period.length >= 2 ? period[0]! : null,
    end: period.length >= 2 ? period[period.length - 1]! : null,
    totals,
  }
}

/**
 * Every register's pay run, with its bank debit: among the statements' payments out (`payLinesOf`), the one line of the
 * register's stated total on a date near its pay date (within the admin's days; with no pay date, within their days
 * after the pay period ends). Two such lines the same distance away are no one's: never a guess.
 */
export function payRunsOf(files: RunFile[]): PayRun[] {
  const { debitDaysFromPayDate, debitDaysAfterPeriod } = reader().words
  const bank = files
    .filter((f) => f.kind === 'bank-statement')
    .flatMap((f) =>
      payLinesOf(f)
        .filter((l): l is StatementLine => !!l)
        .map((line) => ({ fileId: f.id, line }))
    )
  const runs = files
    .filter((f) => f.kind === 'payroll-register')
    .map((f) => {
      const run = payRunOf(f)
      const anchor = run.payDate ?? run.end
      let debit: PayRun['debit'] = null
      if (anchor)
        for (const total of run.totals) {
          const re = amountPattern(total)
          const year = Number(anchor.slice(0, 4))
          const near = bank
            .map((b) => {
              const ds = bankDates(b.line.text, year).filter((d) =>
                run.payDate
                  ? daysBetween(d, anchor) <= debitDaysFromPayDate
                  : Date.parse(d) >= Date.parse(anchor) &&
                    daysBetween(d, anchor) <= debitDaysAfterPeriod
              )
              return {
                ...b,
                away: ds.length ? Math.min(...ds.map((d) => daysBetween(d, anchor))) : null,
              }
            })
            .filter((b) => b.away !== null && re.test(b.line.text))
            .sort((a, b) => a.away! - b.away!)
          if (near[0] && (!near[1] || near[1].away! > near[0].away!)) {
            debit = { fileId: near[0].fileId, line: near[0].line, amount: total }
            break
          }
        }
      return { ...run, debit }
    })
  // Two files of one run (the same pay date and period: a payments report and its per-person register) share the one
  // debit either found: a register whose total misreads, or that states none, is still that run's.
  const sameRun = (a: PayRun, b: PayRun) =>
    !!a.payDate &&
    !!a.start &&
    !!a.end &&
    a.payDate === b.payDate &&
    a.start === b.start &&
    a.end === b.end
  return runs.map((r) => {
    if (r.debit) return r
    const found = runs
      .filter((o) => o.debit && sameRun(r, o))
      .map((o) => o.debit!)
      .filter((d, i, all) => all.findIndex((x) => x.line === d.line) === i)
    return found.length === 1 ? { ...r, debit: found[0]! } : r
  })
}

/**
 * The bank debit of the pay run a pay stub's pay is in: of the runs whose pay period is the stub's (else those whose pay
 * date the stub prints), the one debit they were paid by. Null when none was found, or when they were paid by several.
 */
export function debitOfStub(
  runs: PayRun[],
  stub: { start: string | null; end: string | null; dates: string[] }
): PayRun['debit'] {
  const one = (rs: PayRun[]) => {
    const debits = rs
      .map((r) => r.debit)
      .filter((d): d is NonNullable<PayRun['debit']> => !!d)
      .filter((d, i, all) => all.findIndex((x) => x.line === d.line) === i)
    return debits.length === 1 ? debits[0]! : null
  }
  const byPeriod = runs.filter((r) => !!stub.start && r.start === stub.start && r.end === stub.end)
  if (byPeriod.length) return one(byPeriod)
  return one(runs.filter((r) => !!r.payDate && stub.dates.includes(r.payDate)))
}

// ── Which month a pay is in ────────────────────────────────────────────────

/**
 * The month a pay run counts in, yyyy-mm: the month the work was done, its pay period's end (owner's decision,
 * 2026-11-01, replacing the pay date's month of 2026-10-19 until the accountant answers), so the second half of
 * September, paid on October 6th, is September's, as the books accrue it. With no period printed, its pay date's.
 */
export const payMonthOf = (run: { payDate: string | null; end: string | null }): string | null =>
  (run.end ?? run.payDate)?.slice(0, 7) ?? null

/** How many lines below a label its value may be printed (a label on its own line, the value under it). */
const BELOW_LABEL = 3

/**
 * The first of the label's own line and the lines just under it (on its page) that gives a value: a file may print a
 * label with its value beside it ("Pay date 01/30/2026") or alone on a line with the value under it ("PAY DATE:", then
 * the date a line or two down).
 */
export function valueAtLabel<T>(
  lines: StatementLine[],
  i: number,
  read: (text: string) => T | null
): T | null {
  for (let k = i; k <= i + BELOW_LABEL && k < lines.length; k++) {
    if (lines[k]!.page !== lines[i]!.page) break
    const v = read(lines[k]!.text)
    if (v !== null) return v
  }
  return null
}

/** Every date written in the text with where it starts, in reading order. */
function datesInOrder(text: string): string[] {
  const found: { at: number; date: string }[] = []
  const add = (m: RegExpMatchArray, date: string | null) =>
    date && found.push({ at: m.index ?? 0, date })
  for (const m of text.matchAll(/(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g))
    add(m, iso(+m[1]!, +m[2]!, +m[3]!))
  for (const m of text.matchAll(/(?<![\d-])(\d{1,2})[/.](\d{1,2})[/.](\d{4}|\d{2})(?!\d)/g))
    add(m, iso(m[3]!.length === 2 ? 2000 + +m[3]! : +m[3]!, +m[1]!, +m[2]!))
  for (const m of text.matchAll(/(?<!\d)(20\d{2})(\d{2})(\d{2})(?!\d)/g))
    add(m, iso(+m[1]!, +m[2]!, +m[3]!))
  found.push(...namedDates(text))
  return found.sort((a, b) => a.at - b.at).map((x) => x.date)
}

/**
 * The pay period on one line: the first "from – to" pair in reading order, two dates in a row, the second 5 to 31 days
 * after the first (January test, 2026-10-19: a time report's row prints its pay date before the period, which a
 * lowest-and-highest reading took as the period's end). Null when the line prints no such pair.
 */
const twoDates = (text: string): [string, string] | null => {
  const ds = datesInOrder(text)
  for (let i = 0; i + 1 < ds.length; i++) {
    const days = (Date.parse(ds[i + 1]!) - Date.parse(ds[i]!)) / 86_400_000
    if (days >= 5 && days <= 31) return [ds[i]!, ds[i + 1]!]
  }
  return null
}

/**
 * The pay date a file prints beside a pay date label (the admin's: "Pay date", "Check date"), yyyy-mm-dd; null when it
 * prints none.
 */
export function payDateOn(lines: StatementLine[]): string | null {
  const label = reader().payDate
  const all = Array.isArray(lines) ? lines : []
  for (let i = 0; i < all.length; i++)
    if (label.test(all[i]!.text)) {
      const d = valueAtLabel(all, i, (t) => datesOf(t)[0] ?? null)
      if (d) return d
    }
  return null
}

/**
 * A file's pay period, as its lines with a pay period word print it (or the lines just under such a line), the earliest
 * and latest date; what AI read of it wins. Never its file name, which nothing enforces.
 */
export function periodOn(file: {
  lines: StatementLine[]
  ai?: AiFileFacts | null
}): { start: string; end: string } | null {
  if (file.ai?.start && file.ai.end) return { start: file.ai.start, end: file.ai.end }
  const lines = Array.isArray(file.lines) ? file.lines : []
  const word = reader().period
  // The pair most labelled lines print (a file of one period prints it on every row).
  const count = new Map<string, number>()
  for (let i = 0; i < lines.length; i++) {
    if (!word.test(lines[i]!.text)) continue
    const pair = valueAtLabel(lines, i, twoDates)
    if (pair) count.set(pair.join('|'), (count.get(pair.join('|')) ?? 0) + 1)
  }
  const best = [...count.entries()].sort((a, b) => b[1] - a[1])[0]
  if (!best) return null
  const [start, end] = best[0].split('|') as [string, string]
  return { start, end }
}

/**
 * One run of these, when they are one: the same pay date and period printed by two of its files (a payroll company's
 * payments report and its register), the first of them; null when none, or when they are different runs.
 */
const oneRun = (rs: PayRun[]): PayRun | null => {
  const distinct = new Set(rs.map((r) => `${r.payDate}|${r.start}|${r.end}`))
  return rs.length && distinct.size === 1 ? rs[0]! : null
}

/** The run a file of that pay period belongs to (a timesheet, a pay stub), by its period; null when none or several. */
export function runOfPeriod(runs: PayRun[], period: { start: string; end: string } | null) {
  if (!period) return null
  return oneRun(runs.filter((r) => r.start === period.start && r.end === period.end))
}

/**
 * The runs that paid a staff payroll line of a month (owner's decision, 2026-10-19): of the runs of that month (`payMonthOf`),
 * the one whose pay date is the line's date (within the admin's days, `chargeDaysFromPayDate`); a line dated otherwise
 * (a month-end charge) is paid by every run of the month.
 */
export function runsOfLine(runs: PayRun[], date: string, month: string | null): PayRun[] {
  const days = reader().words.chargeDaysFromPayDate
  const inMonth = month ? runs.filter((r) => payMonthOf(r) === month) : runs
  const exact = inMonth.filter((r) => {
    const anchor = r.payDate ?? r.end
    return !!anchor && daysBetween(anchor, date) <= days
  })
  return exact.length ? exact : inMonth
}

// ── The month's payroll runs ──────────────────────────────────────────────

/** The runs' pay dates the text prints. */
const payDatesOn = (runs: PayRun[], text: string) => {
  const ds = new Set(datesOf(text))
  return runs.filter((r) => !!r.payDate && ds.has(r.payDate))
}

/**
 * The run a file is of: a register's own; else the one run whose pay date the file prints (on any line, or as AI read
 * it), else the one run whose period it prints. Null when it prints none of them, or more than one (a file of the whole
 * month: each of its lines is placed by `runOfLine`).
 */
export function runOfFile(
  runs: PayRun[],
  file: { id: string; kind: string; lines: StatementLine[]; ai?: AiFileFacts | null }
): PayRun | null {
  if (file.kind === 'payroll-register') return runs.find((r) => r.fileId === file.id) ?? null
  const lines = Array.isArray(file.lines) ? file.lines : []
  const paid = new Set(lines.flatMap((l) => payDatesOn(runs, l.text)))
  if (file.ai?.payDate) for (const r of runs) if (r.payDate === file.ai.payDate) paid.add(r)
  if (paid.size >= 1) return oneRun([...paid])
  return runOfPeriod(runs, periodOn(file))
}

/** The run a line of a file is of: the one run whose pay date it prints, else its file's. */
export function runOfLine(
  runs: PayRun[],
  file: { id: string; kind: string; lines: StatementLine[]; ai?: AiFileFacts | null },
  line: StatementLine | null
): PayRun | null {
  const on = line ? payDatesOn(runs, line.text) : []
  return oneRun(on) ?? runOfFile(runs, file)
}

/** The month's runs as the registers print them: each register's pay date and period, when it prints both. */
export function suggestedRuns(runs: PayRun[]): PayrollRunEntry[] {
  return runs
    .filter(
      (r): r is PayRun & { payDate: string; start: string; end: string } =>
        !!r.payDate && !!r.start && !!r.end
    )
    .filter((r, i, all) => all.findIndex((x) => x.payDate === r.payDate) === i)
    .map((r) => ({ payDate: r.payDate, start: r.start, end: r.end }))
    .sort((a, b) => a.payDate.localeCompare(b.payDate))
}
