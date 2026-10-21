import type { PayrollBudgetKind } from '@ad/types'
import { personIn } from './match-proof'
import type { PayrollCharge } from './payroll-details'
import { printedName, type ParticipantRow, type StaffRow } from './staff-match'

/**
 * The payroll lines Save puts on each engagement's month from payroll details (owner's decision, 2026-10-20, #22): the
 * pay the match proves is the engagement's payroll on its budget. Each staff member's pay in each run is one line on the
 * budget line ticked "Staff pay", their employer taxes and benefits one on "Staff taxes and benefits"; the participants'
 * employer taxes in each run one line on "Participant taxes" (their pay counts from their payments, not from a line). A
 * line carries its key, so saving again changes it rather than adding a second. Pure: Save reads the rows and writes.
 */

/** An engagement month the lines may land on, with its budget lines' ticks and the staff lines a person entered. */
export interface LineMonth {
  reportId: string
  engagementId: string
  engagementName: string
  /** Its budget lines: the payroll each holds. */
  lines: { id: string; payroll: string[] }[]
  /** The pay dates (yyyy-mm-dd) of the staff payroll lines already on the month that the match did not write. */
  enteredStaffDates: string[]
}

export interface PayrollLineWrite {
  /** `staff:<staffId>:<run end>:pay|taxes` or `participants:<run end>:taxes`: unique on its month. */
  key: string
  kind: PayrollBudgetKind
  reportId: string
  engagementId: string
  budgetLineId: string
  /** The run's pay date (yyyy-mm-dd), the line's date. */
  date: string
  start: string | null
  end: string
  amount: number
  /** Whose pay: the staff member's id, or null for a run's participants together. */
  staffId: string | null
  /** As the line's description says it: the person's name, or "Participants". */
  who: string
  account: string
}

/** Why a charge reached no line, said once per person and run on the plan. */
export interface PayrollLineSkip {
  who: string
  end: string
  why: 'no-engagement' | 'no-month' | 'no-line' | 'entered'
}

const cents = (n: number) => Math.round(n * 100) / 100
const plain = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

/**
 * The engagement a charge is for: the person's own when they are on one; on several, the one the charge's job names
 * ("Salary for Demo Workforce Board (In-School Youth Coding Pathway) jobs for …"); null when it names none of theirs.
 */
export function engagementOfCharge(
  job: string | null,
  ids: string[],
  names: Map<string, string>
): string | null {
  if (ids.length === 1) return ids[0]!
  const j = plain(job ?? '')
  if (!j) return null
  const hits = ids.filter((id) => {
    const n = plain(names.get(id) ?? '')
    return !!n && j.includes(n)
  })
  return hits.length === 1 ? hits[0]! : null
}

/** The line ticked for a kind on an engagement's month; null when no line holds it. */
const lineFor = (m: LineMonth, kind: PayrollBudgetKind) =>
  m.lines.find((l) => l.payroll.includes(kind))?.id ?? null

export function payrollLinesOf(input: {
  charges: PayrollCharge[]
  staff: StaffRow[]
  participants: ParticipantRow[]
  months: LineMonth[]
}): { writes: PayrollLineWrite[]; skipped: PayrollLineSkip[] } {
  const names = new Map(input.months.map((m) => [m.engagementId, m.engagementName]))
  const monthOf = new Map(input.months.map((m) => [m.engagementId, m]))
  const writes = new Map<string, PayrollLineWrite>()
  const skipped: PayrollLineSkip[] = []
  const skip = (s: PayrollLineSkip) => {
    if (!skipped.some((x) => x.who === s.who && x.end === s.end && x.why === s.why)) skipped.push(s)
  }
  const add = (w: Omit<PayrollLineWrite, 'amount'>, amount: number) => {
    const had = writes.get(`${w.reportId}|${w.key}`)
    if (had) had.amount = cents(had.amount + amount)
    else writes.set(`${w.reportId}|${w.key}`, { ...w, amount: cents(amount) })
  }

  for (const c of input.charges) {
    if (!c.end || !c.amount) continue
    const date = c.date ?? c.end
    if (!c.wex) {
      const person = input.staff.find((s) => personIn(c.name, printedName(s.name)))
      if (!person) continue
      const id = engagementOfCharge(c.job, person.engagementIds, names)
      if (!id) {
        skip({ who: person.name, end: c.end, why: 'no-engagement' })
        continue
      }
      const m = monthOf.get(id)
      if (!m) {
        skip({ who: person.name, end: c.end, why: 'no-month' })
        continue
      }
      // A run whose staff pay a person already entered on the month is proved as it is, never counted twice.
      if (m.enteredStaffDates.includes(date)) {
        skip({ who: person.name, end: c.end, why: 'entered' })
        continue
      }
      const kind: PayrollBudgetKind = c.pay ? 'staff-pay' : 'staff-taxes'
      const budgetLineId = lineFor(m, kind)
      if (!budgetLineId) {
        skip({ who: person.name, end: c.end, why: 'no-line' })
        continue
      }
      add(
        {
          key: `staff:${person.id}:${c.end}:${c.pay ? 'pay' : 'taxes'}`,
          kind,
          reportId: m.reportId,
          engagementId: m.engagementId,
          budgetLineId,
          date,
          start: c.start,
          end: c.end,
          staffId: person.id,
          who: person.name,
          account: c.account,
        },
        c.amount
      )
      continue
    }
    // A participant's pay counts from their payment; their employer taxes, the run's together, are a line.
    if (c.pay) continue
    // A name on several engagements goes by the charge's job, as a staff member's does; never the first row found.
    const rows = input.participants.filter((x) => personIn(c.name, printedName(x.displayName)))
    if (!rows.length) continue
    const id = engagementOfCharge(c.job, [...new Set(rows.map((x) => x.engagementId))], names)
    if (!id) {
      skip({ who: rows[0]!.displayName, end: c.end, why: 'no-engagement' })
      continue
    }
    const m = monthOf.get(id)
    if (!m) continue
    const budgetLineId = lineFor(m, 'participant-taxes')
    if (!budgetLineId) {
      skip({ who: 'Participants', end: c.end, why: 'no-line' })
      continue
    }
    add(
      {
        key: `participants:${c.end}:taxes`,
        kind: 'participant-taxes',
        reportId: m.reportId,
        engagementId: m.engagementId,
        budgetLineId,
        date,
        start: c.start,
        end: c.end,
        staffId: null,
        who: 'Participants',
        account: c.account,
      },
      c.amount
    )
  }
  return {
    writes: [...writes.values()].sort(
      (a, b) => a.reportId.localeCompare(b.reportId) || a.key.localeCompare(b.key)
    ),
    skipped,
  }
}

/** The line's item number, short and unique on its engagement: PR-<pay date>-<whose>, with T for taxes. */
export function payrollItemNumber(w: PayrollLineWrite): string {
  const whose = w.staffId ? w.staffId.replace(/-/g, '').slice(0, 6).toUpperCase() : 'PART'
  return `PR-${w.date.replace(/-/g, '')}-${whose}${w.kind.endsWith('taxes') ? '-T' : ''}`
}
