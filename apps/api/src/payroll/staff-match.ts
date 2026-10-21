import {
  STAFF_REPORT_LINES,
  type AiFileFacts,
  type HighlightField,
  type PayrollDocumentKind,
  type PayrollSlot,
  type ReportStatus,
  type StatementLine,
  type StatementMark,
  type StubFlag,
} from '@ad/types'
import { highlightsFor } from './highlights'
import { datesOf, personIn } from './match-proof'
import {
  chargedPayOf,
  chargesOf,
  sheetMarks,
  type ChargedPay,
  type PayrollCharge,
} from './payroll-details'
import { payLinesOf } from './pay-lines'
import { reader } from './reading'
import {
  amountsOn,
  debitOfStub,
  netOnRow,
  payRunsOf,
  registerLayout,
  payDateOn,
  payMonthOf,
  payRunOf,
  periodOn,
  runOfLine,
  runsOfLine,
  type PayRun,
  type RegisterLayout,
} from './pay-runs'
import { amountPattern, type PageItem } from './statement-lines'

export { amountsOn, registerLayout, type RegisterLayout } from './pay-runs'

/**
 * The workspace payroll match by the lists (GitHub issue #22; owner's decisions, 2026-10-18): each person on the staff
 * list is found in the files by name (a register row by their full name; a timesheet by name in its text or its file
 * name; a bank line by name, with the register's amount where it can), and their proofs are linked to the staff payroll lines of every engagement they are tagged to.
 * Each pay stub is read for its pay period and pay, the participant it names is found on the engagements' participant
 * lists, and their work-experience payment is made from it. No hours or dollar split is worked out. Pure: the service
 * reads the rows and writes what this answers.
 *
 * Names are matched strictly (`personIn`): the full name's words in order, or "Last, First". A line that fits more than
 * one person is no one's and is flagged; nothing is guessed from a part of a name. No employee number is read or kept
 * (owner's decision, 2026-10-18): two people of one name are one line's "several people", never told apart by a guess.
 */

/** A file as the match reads it: a file of the run, with the document it is (or will be) once saved. */
export interface MatchFile {
  id: string
  documentId: string | null
  kind: PayrollDocumentKind
  fileName: string
  lines: StatementLine[]
  items?: PageItem[]
  /** What AI read from the file when a person asked (every value found in its text). */
  ai?: AiFileFacts | null
  /**
   * A staged file that takes the place of a file of the month's set (the same name and kind, or the same contents
   * under a new name): that file's document, so the payment its pay stub made is changed rather than made twice.
   */
  previousDocumentId?: string | null
}

export interface StaffRow {
  id: string
  name: string
  engagementIds: string[]
}

export interface ParticipantRow {
  id: string
  engagementId: string
  displayName: string
  participantId: string
}

/** One engagement's month for the period, with its staff payroll lines (Staff Salaries, Staff Fringe Benefits). */
export interface MatchMonth {
  reportId: string
  engagementId: string
  engagementName: string
  status: ReportStatus
  /** Its staff payroll lines, each with its date: the runs that paid it are the ones paid on that date (`runsOfLine`). */
  staffItems: { id: string; date?: string }[]
}

/** A work-experience payment already in one of the months. */
export interface MatchWex {
  id: string
  reportId: string
  participantRowId: string
  start: string
  end: string
  amount: number
  stubDocumentId: string | null
  /** Its pay stub leaves the month's set in this change: another stub of the same pay may take the payment over. */
  stubLeaving?: boolean
}

/** One of a person's lines in a file: the line, and the pay on it (a register row) or what it paid (a bank line). */
export interface PersonLine {
  fileId: string
  line: StatementLine | null
  amount: number | null
  /** A bank line that is their pay run's debit (`pay-runs.ts`): everyone paid in the run shares it, so it names no one. */
  run?: boolean
  /** The pay run it is of (its register's file): a register row, a timesheet of the run's period, the run's debit. */
  runId?: string
  /** Where it was found, when not by the rules: AI read it, or the payroll company's payroll details. */
  source?: 'ai' | 'details'
  /** Payroll details: every row of theirs in the run (pay, taxes, benefits), which their copy highlights. */
  lines?: StatementLine[]
}

export interface StaffFound {
  staff: StaffRow
  timesheet: PersonLine[]
  register: PersonLine[]
  /**
   * Their bank lines, sure proof: the debit of the pay run their register row is in (`run`, owner's decision,
   * 2026-10-19); only when no run's debit is found, the lines of a statement that lists people and names them.
   */
  bank: PersonLine[]
  /**
   * With no run debit and no line naming them, a bank line found by the register's amount alone: a guess for the owner
   * to confirm in the reconciliation, never linked by the match.
   */
  bankGuess: PersonLine[]
  /** The pay on their register rows, added up; null when no row was found. */
  pay: number | null
  /** What payroll details charge for them, per run (section 8 of #22): empty when it charges them none, or none was given. */
  charged?: { start: string | null; end: string | null; amount: number }[]
}

const MONEY_ALL = /(?<![\d.,])\$?\s?(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}(?!\d)/g
const round = (n: number) => Math.round(n * 100) / 100
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The number as a word of its own in the text: 1042, never part of 21042 or of an amount (1042.00). */
export function hasNumber(text: string, number: string): boolean {
  const n = number.trim()
  if (!n) return false
  return new RegExp(`(?<![\\p{L}\\p{N}])${escape(n)}(?![\\p{L}\\p{N}]|[.,]\\d)`, 'iu').test(text)
}

// ── A register's layout ────────────────────────────────────────────────────

/** The amounts printed right after a label on the line, up to the next word: "Gross 2,000.00 Net 1,640.22" → [2000]. */
function amountsAfter(text: string, label: RegExp): number[] | null {
  const m = label.exec(text)
  if (!m) return null
  const rest = text.slice(m.index + m[0].length)
  return amountsOn(rest.split(/\p{L}{2,}/u)[0] ?? '')
}

/**
 * A register row's pay for this period, its gross (owner's review, 2026-10-18; never the largest amount, which may be a
 * year-to-date column). In order: the amount right after a gross, total pay or earnings label on the row itself; else,
 * when the register's heading names its money columns and the row prints one amount for each, the one under the first
 * gross column that is not year to date; else the first amount on the row (its first after the name), with `unclear`
 * when the row prints more than one and nothing says which is the gross. Null when the row prints no amount.
 */
export function payOnRow(
  text: string,
  layout: RegisterLayout = { columns: null }
): { amount: number | null; unclear: boolean } {
  const labelled = amountsAfter(text, reader().rowPay)
  if (labelled && labelled.length === 1) return { amount: labelled[0]!, unclear: false }
  const all = amountsOn(text)
  if (!all.length) return { amount: null, unclear: false }
  if (layout.columns && all.length === layout.columns.length)
    return { amount: all[layout.columns.indexOf('gross')]!, unclear: false }
  return { amount: all[0]!, unclear: all.length > 1 }
}

/**
 * The name the payroll files print for a person on the staff list: their name without a note in brackets at its end.
 * Two people of one name are told apart on the list by such a note ("Morgan Lee (Adult IT)"); the files print "Morgan
 * Lee" for both, so a line naming them fits both and is flagged (`several-people`), never filed to a guess.
 */
export const printedName = (name: string) => name.replace(/\s*\([^()]*\)\s*$/, '').trim() || name

/** The rows of every register that pay someone, with their file and its layout. */
function registerRows(files: MatchFile[]) {
  return files
    .filter((f) => f.kind === 'payroll-register')
    .flatMap((f) => {
      const layout = registerLayout(f.lines)
      return payLinesOf(f)
        .filter((l): l is StatementLine => !!l)
        .map((line) => ({ file: f, line, layout }))
    })
}

type Row = ReturnType<typeof registerRows>[number]

/**
 * How many people on the lists a text names: each person on the staff list by the name the files print, and each
 * participant name once.
 */
function fitting(staff: StaffRow[], participants: ParticipantRow[]) {
  const names = [
    ...staff.map((s) => printedName(s.name)),
    ...new Set(participants.map((p) => p.displayName.trim().toLowerCase())),
  ]
  return (text: string) => names.filter((n) => personIn(text, n)).length
}

/**
 * Each register row's person on the staff list: the one whose full name it prints (`personIn`), when no one else on the
 * lists fits it. A row more than one person fits (two people of one name, or a staff member and a participant) is no
 * one's, and is listed in `several` for the reconciliation.
 */
function rowOwners(staff: StaffRow[], rows: Row[], participants: ParticipantRow[]) {
  const owner = new Map<StatementLine, StaffRow>()
  const several = new Set<StatementLine>()
  const fits = fitting(staff, participants)
  for (const r of rows) {
    const pick = staff.filter((s) => personIn(r.line.text, printedName(s.name)))
    if (!pick.length) continue
    if (pick.length === 1 && fits(r.line.text) === 1) owner.set(r.line, pick[0]!)
    else several.add(r.line)
  }
  return { owner, several }
}

/**
 * What each person on the staff list has in the files: their register rows (and the pay on them), the timesheets that
 * name them, and the bank lines that paid them. Their bank line is the debit of the pay run of each register their row
 * is on (`payRunsOf`). Only when no such debit is found, a statement that lists people is read the old way: a line that
 * names them, the one with their register's amount first; with no line naming them, the one line of all the statements
 * with that amount (the row's net and gross) is a guess (`bankGuess`), when there is exactly one: an amount alone is
 * never sure proof.
 */
export function findStaff(
  staff: StaffRow[],
  files: MatchFile[],
  participants: ParticipantRow[] = [],
  runs: PayRun[] = payRunsOf(files)
): StaffFound[] {
  const rows = registerRows(files)
  const { owner } = rowOwners(staff, rows, participants)
  const fits = fitting(staff, participants)
  // Lines and file names more than one person fits are no one's: never filed to a guess.
  const bankLines = files
    .filter((f) => f.kind === 'bank-statement')
    .flatMap((f) =>
      payLinesOf(f)
        .filter((l): l is StatementLine => !!l)
        .map((line) => ({ file: f, line }))
    )
    .filter((b) => fits(b.line.text) <= 1)
  return staff.map((s) => {
    const only = (text: string) => personIn(text, printedName(s.name)) && fits(text) === 1
    const mine = rows.filter((r) => owner.get(r.line) === s)
    const register: PersonLine[] = mine.map((r) => ({
      fileId: r.file.id,
      line: r.line,
      amount: payOnRow(r.line.text, r.layout).amount,
      runId: r.file.id,
    }))
    const timesheet: PersonLine[] = []
    for (const f of files.filter((x) => x.kind === 'timesheet')) {
      // One line per payroll run the timesheet shows them in (a report of the whole month prints each run's pay date).
      const seen = new Set<string>()
      for (const line of f.lines.filter((l) => only(l.text))) {
        const runId = runOfLine(runs, f, line)?.fileId
        const key = runId ?? ''
        if (seen.has(key)) continue
        seen.add(key)
        timesheet.push({ fileId: f.id, line, amount: null, ...(runId ? { runId } : {}) })
      }
    }
    // The amounts a bank line may show for them: each row's net and gross (by the heading), else its two largest.
    const paid = mine.flatMap((r) => {
      const gross = payOnRow(r.line.text, r.layout).amount
      const net = netOnRow(r.line.text, r.layout)
      if (net !== null) return [net, ...(gross !== null ? [gross] : [])]
      return amountsOn(r.line.text)
        .sort((a, b) => b - a)
        .slice(0, 2)
    })
    const shows = (text: string) => paid.find((a) => amountPattern(a).test(text)) ?? null
    // The debit of each pay run whose register pays them.
    const debits: PersonLine[] = runs
      .filter((r) => r.debit && mine.some((m) => m.file.id === r.fileId))
      .map((r) => ({
        fileId: r.debit!.fileId,
        line: r.debit!.line,
        amount: r.debit!.amount,
        run: true,
        runId: r.fileId,
      }))
    const named = debits.length ? [] : bankLines.filter((b) => only(b.line.text))
    const agreeing = named.filter((b) => shows(b.line.text) !== null)
    const bank: PersonLine[] = debits.length
      ? debits
      : (agreeing.length ? agreeing : named).map((b) => ({
          fileId: b.file.id,
          line: b.line,
          amount: shows(b.line.text) ?? amountsOn(b.line.text)[0] ?? null,
        }))
    const bankGuess: PersonLine[] = []
    if (!bank.length)
      for (const a of new Set(paid)) {
        const re = amountPattern(a)
        const at = bankLines.filter((b) => re.test(b.line.text))
        if (at.length === 1 && !bankGuess.some((g) => g.line === at[0]!.line))
          bankGuess.push({ fileId: at[0]!.file.id, line: at[0]!.line, amount: a })
      }
    const amounts = register.map((r) => r.amount).filter((a): a is number => a !== null)
    return {
      staff: s,
      timesheet,
      register,
      bank: bank.filter((b, i) => bank.findIndex((x) => x.line === b.line) === i),
      bankGuess,
      pay: amounts.length ? round(amounts.reduce((t, a) => t + a, 0)) : null,
    }
  })
}

/**
 * The register rows and bank lines that more than one person on the lists (staff and participants) fits by name: no
 * one's, flagged for the owner.
 */
export function severalPeopleLines(
  files: MatchFile[],
  staff: StaffRow[],
  participants: ParticipantRow[]
): Set<StatementLine> {
  const out = new Set<StatementLine>()
  const fits = fitting(staff, participants)
  const rows = registerRows(files)
  const { owner, several } = rowOwners(staff, rows, participants)
  for (const l of several) out.add(l)
  const lines = [
    ...rows.filter((r) => !owner.has(r.line)).map((r) => r.line),
    ...files
      .filter((f) => f.kind === 'bank-statement')
      .flatMap((f) => payLinesOf(f).filter((l): l is StatementLine => !!l)),
  ]
  for (const l of lines) if (fits(l.text) > 1) out.add(l)
  return out
}

/** The register rows whose pay this period cannot be told apart from the row's other amounts (`payOnRow`). */
export function payUnclearLines(file: MatchFile): Set<StatementLine> {
  const out = new Set<StatementLine>()
  if (file.kind !== 'payroll-register') return out
  const layout = registerLayout(file.lines)
  for (const l of payLinesOf(file)) if (l && payOnRow(l.text, layout).unclear) out.add(l)
  return out
}

/** What a pay stub says: its pay period, its gross and net pay, and the line its pay is on. */
export interface StubReading {
  start: string | null
  end: string | null
  /** The pay date it prints, yyyy-mm-dd: the month it is paid in is its month (owner's decision, 2026-10-19). */
  payDate: string | null
  gross: number | null
  net: number | null
  payLine: StatementLine | null
  /** Its gross could not be told for sure: several amounts after the label, or lines that disagree. */
  grossUnclear: boolean
  /** Where its pay was read, when not by the rules: AI read it. */
  source?: 'ai'
}

/**
 * The amount after a label on a stub's lines (owner's review, 2026-10-18): the one amount printed right after the
 * label, on each line that has it and is not a year-to-date line. Several amounts after the label are this period's and
 * the year to date: the first is taken only when a column heading on the stub says "Current" before "YTD". Lines that
 * disagree, or several amounts with no such heading, are `unclear` and give no amount: never a guess.
 */
function stubAmount(
  lines: StatementLine[],
  label: RegExp,
  currentFirst: boolean
): { line: StatementLine; amount: number } | 'unclear' | null {
  const found: { line: StatementLine; amount: number }[] = []
  const ytdBefore = reader().ytdBefore
  for (const l of lines) {
    const m = label.exec(l.text)
    if (!m || ytdBefore.test(l.text.slice(0, m.index))) continue
    const after = amountsAfter(l.text, label) ?? []
    if (!after.length) continue
    if (after.length > 1 && !currentFirst) return 'unclear'
    found.push({ line: l, amount: after[0]! })
  }
  if (!found.length) return null
  if (new Set(found.map((f) => round(f.amount))).size > 1) return 'unclear'
  return found[0]!
}

/**
 * A pay stub's pay period and pay, as its text prints them: the dates on its lines with a pay period word (the earliest
 * and the latest), its gross pay (after a gross label, or else a total pay label: `stubAmount`), and its net pay, by the
 * admin's reading words. A period a person gave the stub wins over what it prints. What it does not print, or prints so
 * it cannot be told, is null, never guessed: a stub with no gross pay or no pay period is flagged for the owner.
 */
export function readStub(lines: StatementLine[], ai?: AiFileFacts | null): StubReading {
  const read = reader()
  const currentFirst = lines.some((l) => read.currentFirst.test(l.text))
  const byGross = stubAmount(lines, read.gross, currentFirst)
  const gross = byGross ?? stubAmount(lines, read.totalPay, currentFirst)
  const net = stubAmount(lines, read.net, currentFirst)
  const g = gross && gross !== 'unclear' ? gross : null
  const n = net && net !== 'unclear' ? net : null
  const p = periodOn({ lines, ai })
  const dates = p ? [p.start, p.end] : []
  const two = dates.length >= 2
  // What AI read of the person the stub pays, when a person asked: their gross and its line, found in the stub's text.
  const fact = ai?.people.find((x) => x.gross !== null)
  if (fact)
    return {
      start: two ? dates[0]! : null,
      end: two ? dates[dates.length - 1]! : null,
      payDate: ai!.payDate ?? payDateOn(lines),
      gross: fact.gross,
      net: n?.amount ?? null,
      payLine: fact.line,
      grossUnclear: false,
      source: 'ai',
    }
  return {
    start: two ? dates[0]! : null,
    end: two ? dates[dates.length - 1]! : null,
    payDate: ai?.payDate ?? payDateOn(lines),
    gross: g?.amount ?? null,
    net: n?.amount ?? null,
    payLine: g?.line ?? n?.line ?? null,
    grossUnclear: gross === 'unclear',
  }
}

/**
 * The participant a pay stub names: by name on its lines, then by their participant id among several. Never by its file
 * name, which nothing enforces (owner's decision, 2026-10-19).
 */
export function participantOf(
  file: MatchFile,
  participants: ParticipantRow[]
): { participant: ParticipantRow | null; flag: StubFlag | null } {
  const named = participants.filter((p) => file.lines.some((l) => personIn(l.text, p.displayName)))
  if (!named.length) return { participant: null, flag: 'no-participant' }
  if (named.length === 1) return { participant: named[0]!, flag: null }
  const byId = named.filter(
    (p) =>
      p.participantId.trim().length >= 3 &&
      file.lines.some((l) => hasNumber(l.text, p.participantId))
  )
  if (byId.length === 1) return { participant: byId[0]!, flag: null }
  return { participant: null, flag: 'several-participants' }
}

/** One proof link the match will make, or change: a file of the run to an item, with that item's highlights. */
export interface PlannedLink {
  target: 'expense' | 'wex'
  /** The item; null for the payment a pay stub makes (`stubFileId` says which). */
  itemId: string | null
  stubFileId: string | null
  fileId: string
  purpose: 'timesheet' | 'register' | 'payment'
  slot: PayrollSlot
  mark: StatementMark | null
  marks: StatementMark[]
  reportId: string
  /** The bank line is the debit of the pay run that paid the item. */
  payRun?: boolean
}

/** What the match does with one pay stub. */
export interface StubPlan {
  fileId: string
  documentId: string | null
  reading: StubReading
  participant: ParticipantRow | null
  month: MatchMonth | null
  flags: StubFlag[]
  action: 'create' | 'update' | 'same' | 'none'
  /** The payment it is (to change, or unchanged); null for a new one or none. */
  wexId: string | null
  /** The payment it changes was typed by hand: it is taken over, and kept if the stub ever leaves the set. */
  takesOverTyped: boolean
  /** The debit of the pay run it was paid in, linked to its payment as its bank line; null when none was found. */
  debit: PersonLine | null
  /** Their timesheet line of the stub's pay period, and their register row, else the run's register total; null: none. */
  timesheet: PersonLine | null
  register: PersonLine | null
  /** The name the stub prints for whom it pays ("Employee: Alex Rivera"), when it can be read; never a guess. */
  named: string | null
}

export interface Plan {
  staff: StaffFound[]
  stubs: StubPlan[]
  links: PlannedLink[]
}

/**
 * Whether a participant's register rows disagree with their pay stub: rows that name them, on a register of the stub's
 * pay period (when both say it), none of which pays the stub's gross (or, when a row's gross can't be read, its net).
 * No row, or a stub whose pay can't be read: nothing to compare, no flag.
 */
function registerDisagrees(
  reading: StubReading,
  rows: Row[],
  owned: Set<StatementLine | null>,
  name: string
): boolean {
  if (reading.gross === null && reading.net === null) return false
  const mine = rows.filter((r) => {
    if (owned.has(r.line) || !personIn(r.line.text, name)) return false
    const run = payRunOf(r.file)
    return !run.start || !reading.start || (run.start === reading.start && run.end === reading.end)
  })
  if (!mine.length) return false
  const same = (a: number | null, b: number | null) =>
    a !== null && b !== null && round(a) === round(b)
  return !mine.some((r) => {
    const gross = payOnRow(r.line.text, r.layout)
    if (gross.amount !== null && !gross.unclear) return same(gross.amount, reading.gross)
    return same(netOnRow(r.line.text, r.layout), reading.net) || same(gross.amount, reading.gross)
  })
}

/** The name a pay stub prints after its "Employee:" (or "Paid to:") label, as a register row's name is read. */
export function stubName(lines: StatementLine[]): string | null {
  const label = reader().nameLabel
  for (let i = 0; i < lines.length; i++) {
    const m = label.exec(lines[i]!.text)
    if (!m) continue
    // The name beside the label, else on the line under it ("PAID TO:", then the name).
    const beside = lines[i]!.text.slice(m[0].length).trim()
    if (beside) return registerPerson(beside)?.name ?? null
    // On its own line under the label, the whole line is the name.
    const below = lines[i + 1]?.page === lines[i]!.page ? lines[i + 1]!.text.trim() : ''
    return below || null
  }
  return null
}

const MAX_MARKS = 20
const BLOCKING: StubFlag[] = [
  'stub-unreadable',
  'no-participant',
  'several-participants',
  'no-month',
  'other-month',
  'duplicate',
]

/** A person's highlights on one file, as the platform's settings ask for that kind of proof; no amount when none was read. */
function personMarks(
  file: MatchFile | undefined,
  name: string,
  amount: number | null,
  start: string,
  end: string,
  fields: readonly HighlightField[],
  line: StatementLine | null
): StatementLine[] {
  if (!file?.items?.length) return line ? [line] : []
  const use = amount === null ? fields.filter((f) => f !== 'amount') : fields
  return highlightsFor({ name, amount: amount ?? 0, start, end }, use, file.items, line)
}

/**
 * The whole plan for the period: every person's proofs linked to every engagement they are tagged to (on each staff
 * payroll line of its month), and every pay stub's payment, made or changed, with its proofs. A link two people share
 * (one register, one engagement line) carries both people's highlights; its `mark` is the first person's line.
 *
 * One payment per participant and pay period in a month: before a stub makes one, a payment for the same participant
 * and pay period already in that month is looked for. One typed by hand is taken over; one made from another stub of
 * the set (or by another stub of this plan) is a `duplicate`, and nothing is changed for it. One whose stub leaves the
 * set in this change is taken over too, so a stub uploaded again changes its payment rather than making a second one.
 *
 * Each pay belongs to the month it was paid in, by its pay date (owner's decision, 2026-10-19; the period's end only
 * when no pay date is printed): a run or a pay stub paid in another month than `period` is not this month's, and is
 * flagged (`other-month`). Matching is per run: a staff line gets the register row, timesheet and debit of the run that
 * paid it (`runsOfLine`), and a payment those of its pay stub's run.
 */
export function planMatch(input: {
  files: MatchFile[]
  /** The month matched, yyyy-mm; with none, every run counts. */
  period?: string
  staff: StaffRow[]
  participants: ParticipantRow[]
  months: MatchMonth[]
  wex: MatchWex[]
  highlight: Record<PayrollDocumentKind, readonly HighlightField[]>
}): Plan {
  const { files, highlight } = input
  const fileById = new Map(files.map((f) => [f.id, f]))
  const monthOf = new Map(input.months.map((m) => [m.engagementId, m]))
  const links = new Map<string, PlannedLink>()
  const add = (l: Omit<PlannedLink, 'marks'> & { marks: StatementLine[] }) => {
    const key = `${l.target}:${l.itemId ?? `stub-${l.stubFileId}`}:${l.fileId}`
    const had = links.get(key)
    if (!had) {
      links.set(key, { ...l, marks: l.marks.slice(0, MAX_MARKS) })
      return
    }
    had.mark = had.mark ?? l.mark
    for (const m of l.marks)
      if (
        had.marks.length < MAX_MARKS &&
        !had.marks.some((x) => JSON.stringify(x) === JSON.stringify(m))
      )
        had.marks.push(m)
  }

  // Staff: each person's proofs on the staff payroll lines of each engagement they are tagged to, from the runs paid in
  // the month only.
  const period = input.period ?? null
  const allRuns = payRunsOf(files)
  const away = new Set(
    allRuns.filter((r) => period && payMonthOf(r) && payMonthOf(r) !== period).map((r) => r.fileId)
  )
  const runs = allRuns.filter((r) => !away.has(r.fileId))
  const staff = findStaff(
    input.staff,
    files.filter((f) => !away.has(f.id)),
    input.participants,
    runs
  )
  // What AI read, when a person asked: each staff member's lines on a timesheet or register, with their pay.
  for (const found of staff) {
    // Their pay: the register's rows when AI found any, else the timesheet's (never both: one pay, two files).
    const fromAi = { register: 0, timesheet: 0 }
    let any = false
    for (const f of files) {
      if (away.has(f.id) || (f.kind !== 'timesheet' && f.kind !== 'payroll-register')) continue
      const key = f.kind === 'timesheet' ? 'timesheet' : 'register'
      for (const fact of f.ai?.people ?? []) {
        if (fact.name !== found.staff.name) continue
        const run = f.kind === 'payroll-register' ? f.id : runOfLine(runs, f, fact.line)?.fileId
        any = true
        fromAi[key] += fact.gross ?? 0
        // The same printed line the rules found already (AI's copy of it is kept apart, so compared by its words).
        const had = found[key].find(
          (x) =>
            x.fileId === f.id &&
            !!x.line &&
            x.line.page === fact.line.page &&
            x.line.text === fact.line.text
        )
        if (had) had.amount = had.amount ?? fact.gross
        else
          found[key].push({
            fileId: f.id,
            line: fact.line,
            amount: fact.gross,
            source: 'ai',
            ...(run ? { runId: run } : {}),
          })
      }
    }
    if (any && found.pay === null) found.pay = round(fromAi.register || fromAi.timesheet)
  }
  // Payroll details (#22, section 8): each person's pay per run as the payroll company charges it, their register proof
  // of that run, and that run's debit their bank line.
  const details = files.filter((f) => f.kind === 'payroll-details' && !away.has(f.id))
  const charges: { file: MatchFile; charge: PayrollCharge }[] = details.flatMap((file) =>
    chargesOf(file.lines).map((charge) => ({ file, charge }))
  )
  // By the rules where the export's wording is known; else what AI read of its rows, when the person ticked it (✨).
  const chargedFor = (name: string) =>
    details.flatMap((file) => {
      const known = charges.filter((c) => c.file === file).map((c) => c.charge)
      if (known.length) return chargedPayOf(known, name).map((c) => ({ ...c, file, ai: false }))
      const byRun = new Map<string, ChargedPay>()
      for (const fact of file.ai?.people ?? []) {
        if (fact.gross === null || !personIn(fact.name, name)) continue
        const start = fact.start ?? file.ai!.start
        const end = fact.end ?? file.ai!.end
        const had = byRun.get(`${start}|${end}`)
        if (had) {
          had.amount = round(had.amount + fact.gross)
          had.lines.push(fact.line)
        } else
          byRun.set(`${start}|${end}`, {
            start,
            end,
            amount: fact.gross,
            line: fact.line,
            lines: [fact.line],
          })
      }
      return [...byRun.values()].map((c) => ({ ...c, file, ai: true }))
    })
  for (const found of staff) {
    const mine = chargedFor(printedName(found.staff.name))
    found.charged = mine.map(({ start, end, amount }) => ({ start, end, amount }))
    if (mine.length && found.pay === null) found.pay = round(mine.reduce((t, c) => t + c.amount, 0))
    for (const c of mine) {
      const run = runs.find((r) => r.start === c.start && r.end === c.end)
      found.register.push({
        fileId: c.file.id,
        line: c.line,
        lines: c.lines,
        amount: c.amount,
        source: c.ai ? 'ai' : 'details',
        ...(run ? { runId: run.fileId } : {}),
      })
      if (run?.debit && !found.bank.some((x) => x.line === run.debit!.line))
        found.bank.push({
          fileId: run.debit.fileId,
          line: run.debit.line,
          amount: run.debit.amount,
          run: true,
          runId: run.fileId,
        })
    }
  }
  // A register that names no one (company totals only) proves a run, not a person (owner's decision, 2026-10-19): a
  // staff member's time-report row in a run gives them that run's register, at its stated total, and its one debit.
  for (const found of staff)
    for (const runId of new Set(
      found.timesheet.map((t) => t.runId).filter((r): r is string => !!r)
    )) {
      const run = runs.find((r) => r.fileId === runId)
      if (!run || found.register.some((r) => r.runId === runId)) continue
      const total = runTotalLine(fileById.get(run.fileId), run)
      if (total)
        found.register.push({ fileId: run.fileId, line: total, amount: null, run: true, runId })
      if (run.debit && !found.bank.some((x) => x.line === run.debit!.line))
        found.bank.push({
          fileId: run.debit.fileId,
          line: run.debit.line,
          amount: run.debit.amount,
          run: true,
          runId,
        })
    }
  const proofs: [PayrollDocumentKind, 'timesheet' | 'register' | 'bank', keyof StaffFound][] = [
    ['timesheet', 'timesheet', 'timesheet'],
    ['payroll-register', 'register', 'register'],
    ['bank-statement', 'bank', 'bank'],
  ]
  for (const found of staff)
    for (const engagementId of found.staff.engagementIds) {
      const month = monthOf.get(engagementId)
      if (!month) continue
      for (const [kind, slot, key] of proofs)
        for (const p of found[key] as PersonLine[]) {
          // A spreadsheet (payroll details) is never marked: its row is quoted on the screen instead.
          // Payroll details (a spreadsheet): their rows of the run, by its own highlights in force.
          const sheet = fileById.get(p.fileId)?.kind === 'payroll-details'
          const marks = sheet
            ? sheetMarks(
                p.lines ?? (p.line ? [p.line] : []),
                printedName(found.staff.name),
                highlight['payroll-details']
              )
            : personMarks(
                fileById.get(p.fileId),
                printedName(found.staff.name),
                p.amount,
                '',
                '',
                highlight[kind],
                p.line
              )
          for (const item of month.staffItems) {
            // The run that paid the line: its own register row, timesheet and debit only.
            const paid = item.date ? runsOfLine(runs, item.date, period).map((r) => r.fileId) : null
            if (paid && p.runId && !paid.includes(p.runId)) continue
            add({
              target: 'expense',
              itemId: item.id,
              stubFileId: null,
              fileId: p.fileId,
              purpose: slot === 'bank' ? 'payment' : slot,
              slot,
              mark: p.line,
              marks,
              reportId: month.reportId,
              ...(p.run ? { payRun: true } : {}),
            })
          }
        }
    }

  // Participants: each pay stub's payment, from its pay period and pay, on the month of the engagement whose list names them.
  const owned = new Set(staff.flatMap((s) => s.register.map((r) => r.line)))
  const rows = registerRows(files)
  const stubs: StubPlan[] = []
  // The payments this plan already makes or takes, so two stubs of one pay period never make two.
  const claimed = new Set<string>()
  const payKey = (reportId: string, participantId: string, start: string, end: string) =>
    `${reportId}|${participantId}|${start}|${end}`
  for (const f of files.filter((x) => x.kind === 'paystub')) {
    const reading = readStub(f.lines, f.ai)
    const flags: StubFlag[] = []
    let { participant, flag } = participantOf(f, input.participants)
    // The name rule found nobody: AI may have named one of the participants, for the owner to confirm.
    if (!participant && flag === 'no-participant' && f.ai?.people.length) {
      const named = input.participants.filter((x) => x.displayName === f.ai!.people[0]!.name)
      if (named.length === 1) {
        participant = named[0]!
        flag = 'named-by-ai'
      }
    }
    if (reading.gross === null || reading.start === null) flags.push('stub-unreadable')
    if (flag) flags.push(flag)
    const month = participant ? (monthOf.get(participant.engagementId) ?? null) : null
    if (participant && !month) flags.push('no-month')
    // Paid in another month (by its pay date, else its period's end): not this month's pay.
    const paidIn = (reading.payDate ?? reading.end)?.slice(0, 7) ?? null
    if (period && paidIn && paidIn !== period) flags.push('other-month')
    // Flagged only: the stub's pay is not what the register pays them (its gross, else its net).
    if (participant && registerDisagrees(reading, rows, owned, participant.displayName))
      flags.push('register-disagrees')
    const run = debitOfStub(runs, {
      start: reading.start,
      end: reading.end,
      dates: f.lines.flatMap((l) => datesOf(l.text)),
    })
    const debit: PersonLine | null = run
      ? { fileId: run.fileId, line: run.line, amount: run.amount, run: true }
      : null
    const mineIds = [f.documentId, f.previousDocumentId].filter((d): d is string => !!d)
    const existing = input.wex.find((w) => !!w.stubDocumentId && mineIds.includes(w.stubDocumentId))
    let action: StubPlan['action'] = 'none'
    let wexId: string | null = existing?.id ?? null
    let takesOverTyped = false
    if (!flags.some((x) => BLOCKING.includes(x)) && participant && month) {
      const start = reading.start!
      const end = reading.end!
      const key = payKey(month.reportId, participant.id, start, end)
      const same = (w: MatchWex) =>
        w.participantRowId === participant.id &&
        w.start === start &&
        w.end === end &&
        round(w.amount) === round(reading.gross!)
      // Another payment of this participant and pay period in the month, not this stub's own.
      const other = input.wex.find(
        (w) =>
          w.id !== existing?.id &&
          w.reportId === month.reportId &&
          w.participantRowId === participant.id &&
          w.start === start &&
          w.end === end
      )
      if (existing && existing.reportId !== month.reportId) {
        // Its payment is on another engagement's month: it is never moved; the owner sorts it out.
        flags.push('several-participants')
      } else if (claimed.has(key) || (other && other.stubDocumentId && !other.stubLeaving)) {
        // A second pay stub of the same pay: nothing is changed, the owner looks at it.
        flags.push('duplicate')
      } else if (existing) {
        action = same(existing) ? 'same' : 'update'
      } else if (other) {
        // Typed by hand, or made from a stub that leaves the set now: this stub's payment, taken over, not doubled.
        wexId = other.id
        takesOverTyped = !other.stubDocumentId
        action = 'update'
      } else action = 'create'
      if (action !== 'none') claimed.add(key)
    }
    stubs.push({
      fileId: f.id,
      documentId: f.documentId,
      reading,
      participant,
      month,
      flags,
      action,
      wexId,
      takesOverTyped,
      debit,
      timesheet: null,
      register: null,
      named: participant ? participant.displayName : stubName(f.lines),
    })
    const plan = stubs[stubs.length - 1]!
    if (action === 'none' || !participant || !month) continue
    const name = participant.displayName
    const item = {
      target: 'wex' as const,
      itemId: wexId,
      stubFileId: wexId ? null : f.id,
      reportId: month.reportId,
    }
    const start = reading.start!
    const end = reading.end!
    add({
      ...item,
      fileId: f.id,
      purpose: 'payment',
      slot: 'stub',
      mark: reading.payLine,
      marks: personMarks(f, name, reading.gross, start, end, highlight.paystub, reading.payLine),
    })
    // Their timesheet and register row too, by name, of the stub's pay period (its run's), so their pay in those files is
    // accounted for.
    const samePeriod = (p: { start: string; end: string } | null) =>
      !p || (p.start === start && p.end === end)
    // The timesheet shown is the one of the stub's pay period (owner's decision, 2026-10-19): a report of that period
    // first; a file of the whole month (daily hours) last, and then only their days inside the period, never a day the
    // stub does not pay.
    const inPeriod = (l: StatementLine) => datesOf(l.text).some((d) => d >= start && d <= end)
    // A report whose period reads as the stub's first; then a file where every line naming them is in the period (a
    // report whose period wasn't read); a file of the whole month last.
    const sheets = files
      .filter((x) => x.kind === 'timesheet')
      .map((t) => {
        const period = periodOn(t)
        const theirs = t.lines.filter((l) => personIn(l.text, name))
        const rank = period ? 0 : theirs.length && theirs.every(inPeriod) ? 1 : 2
        return { t, period, theirs, rank }
      })
      .filter((x) => samePeriod(x.period))
      .sort((a, b) => a.rank - b.rank)
    for (const { t, theirs, rank } of sheets) {
      const lines = rank < 2 ? theirs.slice(0, 1) : theirs.filter(inPeriod)
      const line = lines[0] ?? null
      if (!line) continue
      if (!plan.timesheet) plan.timesheet = { fileId: t.id, line, amount: null }
      add({
        ...item,
        fileId: t.id,
        purpose: 'timesheet',
        slot: 'timesheet',
        mark: line,
        marks: lines
          .flatMap((l) => personMarks(t, name, null, start, end, highlight.timesheet, l))
          .slice(0, MAX_MARKS),
      })
    }
    for (const r of rows)
      if (
        !owned.has(r.line) &&
        !away.has(r.file.id) &&
        samePeriod(periodOn(r.file)) &&
        personIn(r.line.text, name)
      ) {
        plan.register = plan.register ?? { fileId: r.file.id, line: r.line, amount: null }
        add({
          ...item,
          fileId: r.file.id,
          purpose: 'register',
          slot: 'register',
          mark: r.line,
          marks: personMarks(
            r.file,
            name,
            payOnRow(r.line.text, r.layout).amount,
            start,
            end,
            highlight['payroll-register'],
            r.line
          ),
        })
      }
    // Payroll details: the participant's pay for the stub's pay period, as the payroll company charges it.
    const charged = plan.register
      ? undefined
      : chargedFor(name).find((c) => c.start === start && c.end === end)
    if (charged) {
      plan.register = {
        fileId: charged.file.id,
        line: charged.line,
        amount: charged.amount,
        source: charged.ai ? 'ai' : 'details',
      }
      add({
        ...item,
        fileId: charged.file.id,
        purpose: 'register',
        slot: 'register',
        mark: charged.line,
        marks: sheetMarks(charged.lines, name, highlight['payroll-details']),
      })
    }
    // A register that names no one: the run's, at its stated total (owner's decision, 2026-10-19).
    const stubRun =
      runs.find((r) => r.start === start && r.end === end) ??
      runs.find((r) => !!debit && r.debit?.line === debit.line)
    const total =
      !plan.register && stubRun ? runTotalLine(fileById.get(stubRun.fileId), stubRun) : null
    if (total && stubRun) {
      plan.register = { fileId: stubRun.fileId, line: total, amount: null, run: true }
      add({
        ...item,
        fileId: stubRun.fileId,
        purpose: 'register',
        slot: 'register',
        mark: total,
        marks: [total],
      })
    }
    // The pay run's debit, their bank line too: the run paid them with everyone else.
    if (debit)
      add({
        ...item,
        fileId: debit.fileId,
        purpose: 'payment',
        slot: 'bank',
        payRun: true,
        mark: debit.line,
        marks: personMarks(
          fileById.get(debit.fileId),
          name,
          debit.amount,
          start,
          end,
          highlight['bank-statement'],
          debit.line
        ),
      })
  }
  return { staff, stubs, links: [...links.values()] }
}

/** Whether a report line is one a staff member's pay is charged on. */
export const isStaffLine = (line: string | null | undefined) =>
  (STAFF_REPORT_LINES as readonly string[]).includes(line ?? '')

/**
 * Who a register row of the files names, from the row itself: the longest run of words on it (a label such as "Emp" or
 * "ID" and every number left out). Nothing else is read from the row: no employee number is kept.
 */
export function registerPerson(text: string): { name: string } | null {
  const plain = text.replace(MONEY_ALL, ' ').replace(/\b(?:emp(?:loyee)?|id)\b\.?/gi, ' ')
  const tokens = plain.split(/\s+/).filter(Boolean)
  const isWord = (t: string) => /^[\p{L}][\p{L}'.,-]*$/u.test(t) && /\p{L}{2,}/u.test(t)
  let best: string[] = []
  let run: string[] = []
  for (const t of tokens) {
    if (isWord(t)) run.push(t)
    else {
      if (run.length > best.length) best = run
      run = []
    }
  }
  if (run.length > best.length) best = run
  if (!best.length) return null
  const words = best.slice(0, 4).map((w) => w.replace(/[.,]+$/, ''))
  // "Lee, Morgan" as the register prints it is Morgan Lee.
  const comma = best[0]!.endsWith(',')
  const name = (comma ? [...words.slice(1), words[0]!] : words).join(' ').trim()
  return name.length >= 3 ? { name } : null
}

/** The register's line of the run's stated total ("Total Direct Deposits"), the line a run-level register proof marks. */
function runTotalLine(
  file: { lines: StatementLine[] } | undefined,
  run: PayRun
): StatementLine | null {
  if (!file) return null
  for (const t of run.totals) {
    const re = amountPattern(t)
    const line = file.lines.find((l) => re.test(l.text))
    if (line) return line
  }
  return null
}
