import { programKey, type PayrollSplitDto, type StatementLine } from '@ad/types'
import { personIn } from './match-proof'
import { periodOn } from './pay-runs'
import { programIn, type PayrollCharge } from './payroll-details'

/**
 * Why a staff payroll line is less than the pay stub shows: the person's pay in the run is charged to several programs
 * (payroll details), each by the hours worked on it (the time report). Save keeps the split on the line, and its pay
 * stub opens with a note of it. Pure.
 */

/** Between cells of a spreadsheet or CSV row read as a line (`sheetLines`, `csvLines`). */
const CELL = ' | '
/** A time report's program column, as its header names it (as `programColumnOf`). */
const PROGRAM_HEADERS = new Set([
  'client projects',
  'client project',
  'project',
  'projects',
  'program',
  'job',
  'class',
  'class full name',
])
const NAME_HEADERS = new Set(['employee', 'employee name', 'name', 'worker', 'full name'])

/** Hours a time report shows one person on one program in one pay period. */
export interface ProgramHours {
  name: string
  program: string
  end: string | null
  hours: number
}

const header = (c: string) => c.trim().toLowerCase().replace(/\s+/g, ' ')
const num = (c: string | undefined) => {
  const n = Number((c ?? '').replace(/[$,\s]/g, ''))
  return Number.isFinite(n) ? n : 0
}

/**
 * A time report's hours by person and program: its header row names a program column and one or more columns of hours
 * ("Salary Hours", "Holiday Hours Hours"; never "… Amount"), and each row with a program adds up its hours. None for a
 * file without such a header (a PDF, a register).
 */
export function hoursOf(
  file: { lines: StatementLine[] },
  /** The run a row is of, by its pay period's end: the run the match ties the file to (its period has no year). */
  endOf: (line: StatementLine) => string | null = () => periodOn(file)?.end ?? null
): ProgramHours[] {
  const lines = Array.isArray(file.lines) ? file.lines : []
  const at = lines.findIndex((l) => {
    const keys = l.text.split(CELL).map(header)
    return keys.some((k) => PROGRAM_HEADERS.has(k)) && keys.some((k) => /\bhours$/.test(k))
  })
  if (at < 0) return []
  const keys = lines[at]!.text.split(CELL).map(header)
  const program = keys.findIndex((k) => PROGRAM_HEADERS.has(k))
  const named = keys.findIndex((k) => NAME_HEADERS.has(k))
  const name = named >= 0 ? named : 0
  const hourCols = keys.flatMap((k, i) => (/\bhours$/.test(k) ? [i] : []))
  const out: ProgramHours[] = []
  for (const l of lines.slice(at + 1)) {
    const cells = l.text.split(CELL)
    const p = (cells[program] ?? '').trim()
    const who = (cells[name] ?? '').trim()
    if (!p || !who) continue
    out.push({
      name: who,
      program: p,
      end: endOf(l),
      hours: Math.round(hourCols.reduce((t, i) => t + num(cells[i]), 0) * 100) / 100,
    })
  }
  return out
}

const cents = (n: number) => Math.round(n * 100) / 100

/**
 * A staff line's run split: every charge of the person in the run of the line's kind (pay, or taxes and benefits),
 * by the program each names, the line's own marked; with each program's hours when the time report shows them for
 * every program. Null when the pay is all one program's: then the stub shows the line's pay and needs no note.
 */
export function splitOf(input: {
  who: string
  /** The name as printed on payroll's files ("Samantha Eve Kooman" prints as found by `personIn`). */
  printed: string
  end: string
  start: string | null
  pay: boolean
  charges: PayrollCharge[]
  /** The charges that make up the line itself. */
  mine: Set<PayrollCharge>
  hours: ProgramHours[]
  /** The workspace's programs, each by every name it goes by: a program's rows are one row, whatever name each uses. */
  programs?: string[][]
}): PayrollSplitDto | null {
  const groups = (input.programs ?? []).map((names, id) => ({ id, names }))
  // A charge's program: its group in the program names (an employer tax "for ARPA Adult Program …" is that program's),
  // else its own text.
  const groupOf = (text: string) => {
    const g = programIn(text, groups)
    return typeof g === 'number' ? `#${g}` : programKey(text) || text
  }
  const nameOf = (key: string, texts: string[]) => {
    const g = key.startsWith('#') ? groups[Number(key.slice(1))] : undefined
    const own = texts.find((t) => g?.names.some((n) => programKey(n) === programKey(t)))
    return own ?? (g ? g.names[0]! : texts[0]!)
  }
  const theirs = input.charges.filter(
    (c) => !c.wex && c.end === input.end && c.pay === input.pay && personIn(c.name, input.printed)
  )
  const rows = new Map<string, { key: string; texts: string[]; amount: number; mine: boolean }>()
  for (const c of theirs) {
    const text = (c.job ?? c.program ?? '').trim() || 'No program named'
    const key = groupOf(text)
    const row = rows.get(key) ?? { key, texts: [], amount: 0, mine: false }
    row.amount = cents(row.amount + c.amount)
    row.texts.push(text)
    if (input.mine.has(c)) row.mine = true
    rows.set(key, row)
  }
  // The time report's project names come first: the plainest name of a program.
  const reported = input.hours.filter((h) => personIn(h.name, input.printed)).map((h) => h.program)
  const list = [...rows.values()]
    .filter((r) => r.amount !== 0)
    .map((r) => ({
      key: r.key,
      program: nameOf(r.key, [...reported.filter((t) => groupOf(t) === r.key), ...r.texts]),
      amount: r.amount,
      mine: r.mine,
    }))
  if (list.length < 2 || !list.some((r) => r.mine)) return null
  const hoursOfRow = (key: string) => {
    const found = input.hours.filter(
      (h) => h.end === input.end && groupOf(h.program) === key && personIn(h.name, input.printed)
    )
    return found.length ? cents(found.reduce((t, h) => t + h.hours, 0)) : null
  }
  const hours = list.map((r) => hoursOfRow(r.key))
  // Hours on every row, or on none: a split shown by hours must add up.
  const shown = hours.every((h) => h !== null && h > 0)
  return {
    kind: input.pay ? 'pay' : 'taxes',
    who: input.who,
    start: input.start,
    end: input.end,
    rows: list
      .map((r, i) => ({
        program: r.program,
        hours: shown ? hours[i]! : null,
        amount: r.amount,
        mine: r.mine,
      }))
      .sort((a, b) => b.amount - a.amount),
  }
}
