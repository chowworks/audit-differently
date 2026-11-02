import type { PayrollBudgetKind } from '@ad/types'
import { personIn } from './match-proof'
import { payMonthOf } from './pay-runs'
import { engagementOfCharge, type PayrollCharge } from './payroll-details'

export { engagementOfCharge }
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
  /**
   * Every name the engagement goes by in payroll and accounting files: its own, and the program names (the workspace's
   * list, `programNamesOf`) of its program. Its name alone when left out.
   */
  names?: string[]
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
  why: 'no-engagement' | 'other-program' | 'other-month' | 'no-month' | 'no-line' | 'entered'
}

const cents = (n: number) => Math.round(n * 100) / 100

/** The line ticked for a kind on an engagement's month; null when no line holds it. */
const lineFor = (m: LineMonth, kind: PayrollBudgetKind) =>
  m.lines.find((l) => l.payroll.includes(kind))?.id ?? null

export function payrollLinesOf(input: {
  charges: PayrollCharge[]
  staff: StaffRow[]
  participants: ParticipantRow[]
  months: LineMonth[]
  /** The month matched, yyyy-mm: a charge of a run of another month (`payMonthOf`) is that month's, never this one's. */
  period?: string
}): { writes: PayrollLineWrite[]; skipped: PayrollLineSkip[] } {
  const names = new Map(
    input.months.map((m) => [m.engagementId, [m.engagementName, ...(m.names ?? [])]])
  )
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
    const otherMonth =
      !!input.period && payMonthOf({ payDate: c.date, end: c.end }) !== input.period
    if (!c.wex) {
      const person = input.staff.find((s) => personIn(c.name, printedName(s.name)))
      if (!person) continue
      const { id, why } = engagementOfCharge(c, person.engagementIds, names)
      if (!id) {
        skip({ who: person.name, end: c.end, why: why ?? 'no-engagement' })
        continue
      }
      if (otherMonth) {
        skip({ who: person.name, end: c.end, why: 'other-month' })
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
    const { id, why } = engagementOfCharge(c, [...new Set(rows.map((x) => x.engagementId))], names)
    if (!id) {
      skip({ who: rows[0]!.displayName, end: c.end, why: why ?? 'no-engagement' })
      continue
    }
    if (otherMonth) {
      skip({ who: 'Participants', end: c.end, why: 'other-month' })
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
    // A run booked and reversed in the same file (an accrual and its reversal) nets to nothing: no line of $0.00.
    writes: [...writes.values()]
      .filter((w) => w.amount !== 0)
      .sort((a, b) => a.reportId.localeCompare(b.reportId) || a.key.localeCompare(b.key)),
    skipped,
  }
}

/**
 * The line's item number, short and unique on its engagement: PR-<run end>-<whose>, with T for taxes. By the run's
 * end, the line's key, never its date: one journal entry may book two runs on one day.
 */
export function payrollItemNumber(w: PayrollLineWrite): string {
  const whose = w.staffId ? w.staffId.replace(/-/g, '').slice(0, 6).toUpperCase() : 'PART'
  return `PR-${w.end.replace(/-/g, '')}-${whose}${w.kind.endsWith('taxes') ? '-T' : ''}`
}
