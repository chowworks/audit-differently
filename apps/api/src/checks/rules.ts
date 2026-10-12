import {
  PAYROLL_REPORT_LINES,
  REQUIRED_ELIGIBILITY_ITEMS,
  type CheckCode,
  type CheckSeverity,
  type DocumentPurpose,
  type ReportLine,
} from '@ad/types'

/**
 * The compliance rules, as pure functions over one month of a contract. No database, no I/O: the service
 * that saves an expense builds a RuleMonth and writes the findings as Check rows; the web app can run the
 * same function for instant feedback. Each rule is one entry in the product brief's table (section 8).
 */

export interface RuleExpense {
  id: string
  itemNumber: string
  /** YYYY-MM-DD */
  date: string
  vendor: string
  memo?: string | null
  totalCost: number
  allocatedAmount: number
  allocationType: 'direct' | 'payroll' | 'usage'
  reportLine: ReportLine
  /** Purposes of the documents attached to this expense. */
  documents: DocumentPurpose[]
}

export interface RuleParticipant {
  id: string
  participantId: string
  displayName: string
  /** Items of the eligibility checklist that have a document on file. */
  eligibilityItems: string[]
  /** Whether this month pays the participant for work experience. */
  paidThisMonth: boolean
}

export interface RuleMonth {
  /** YYYY-MM */
  period: string
  /** YYYY-MM-DD */
  contractStart: string
  /** YYYY-MM-DD */
  contractEnd: string
  /** Day of the following month the report is due. */
  dueDay: number
  /** Approved budget per report line. Lines absent here have no budget. */
  budget: Partial<Record<ReportLine, number>>
  /** Cumulative billed on earlier reports, per line. */
  previouslyBilled: Partial<Record<ReportLine, number>>
  expenses: RuleExpense[]
  /** ISO date-time of submission, when submitted. */
  submittedAt?: string | null
  /** Expenses from earlier months of the same contract, for duplicate detection. */
  earlierExpenses?: Pick<RuleExpense, 'id' | 'vendor' | 'totalCost' | 'date'>[]
  /** The engagement's participants, for the eligibility-file rule. */
  participants?: RuleParticipant[]
  /** The keys a participant's file must hold for this program; the defaults when absent. */
  requiredEligibilityItems?: string[]
}

export interface Finding {
  code: CheckCode
  severity: CheckSeverity
  expenseId?: string
  participantId?: string
  message: string
}

const INDIRECT_WORDS = /\b(g\s*&\s*a|general\s*(&|and)\s*administrative|indirect|overhead)\b/i

/** Days before the report month an expense may be dated and still count as an accrual of that month. */
const ACCRUAL_WINDOW_DAYS = 60

const money = (n: number) => `$${n.toFixed(2)}`

function monthBounds(period: string): { start: string; end: string; dueBase: Date } {
  const [y, m] = period.split('-').map(Number)
  const start = new Date(Date.UTC(y, m - 1, 1))
  const end = new Date(Date.UTC(y, m, 0))
  return { start: isoDate(start), end: isoDate(end), dueBase: new Date(Date.UTC(y, m, 1)) }
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return isoDate(d)
}

/** The report's due date: `dueDay` of the month after `period`, end of day UTC. */
export function dueDate(period: string, dueDay: number): Date {
  const { dueBase } = monthBounds(period)
  return new Date(Date.UTC(dueBase.getUTCFullYear(), dueBase.getUTCMonth(), dueDay, 23, 59, 59))
}

export function runRules(month: RuleMonth): Finding[] {
  const findings: Finding[] = []
  const bounds = monthBounds(month.period)
  const earliest = addDays(bounds.start, -ACCRUAL_WINDOW_DAYS)
  const indirectBudget = month.budget.indirect ?? 0

  for (const e of month.expenses) {
    const has = (p: DocumentPurpose) => e.documents.includes(p)
    const label = `${e.itemNumber} (${e.vendor}, ${money(e.allocatedAmount)})`

    if (PAYROLL_REPORT_LINES.has(e.reportLine)) {
      if (!has('timesheet'))
        findings.push({
          code: 'missing-timesheet',
          severity: 'blocker',
          expenseId: e.id,
          message: `${label}: no timesheet attached.`,
        })
      if (!has('register'))
        findings.push({
          code: 'missing-register',
          severity: 'blocker',
          expenseId: e.id,
          message: `${label}: no payroll register attached.`,
        })
    } else if (!has('invoice')) {
      findings.push({
        code: 'missing-invoice',
        severity: 'blocker',
        expenseId: e.id,
        message: `${label}: no invoice, receipt or purchase order attached.`,
      })
    }

    if (!has('payment'))
      findings.push({
        code: 'missing-proof-of-payment',
        severity: 'blocker',
        expenseId: e.id,
        message: `${label}: no bank or card statement, cancelled check or EFT confirmation attached.`,
      })

    if (e.allocationType !== 'direct' && !has('allocation'))
      findings.push({
        code: 'missing-allocation',
        severity: 'blocker',
        expenseId: e.id,
        message: `${label}: allocated ${e.allocationType === 'payroll' ? 'by payroll hours' : 'by usage'} but no calculation attached.`,
      })

    if (e.allocatedAmount > e.totalCost + 0.005)
      findings.push({
        code: 'allocation-exceeds-total',
        severity: 'blocker',
        expenseId: e.id,
        message: `${label}: allocated amount is more than the expense total of ${money(e.totalCost)}.`,
      })

    if (e.date < month.contractStart || e.date > month.contractEnd)
      findings.push({
        code: 'date-outside-contract',
        severity: 'blocker',
        expenseId: e.id,
        message: `${label}: dated ${e.date}, outside the contract period ${month.contractStart} to ${month.contractEnd}.`,
      })
    else if (e.date < earliest || e.date > bounds.end)
      findings.push({
        code: 'date-far-from-period',
        severity: 'attention',
        expenseId: e.id,
        message: `${label}: dated ${e.date}, more than ${ACCRUAL_WINDOW_DAYS} days before ${month.period} or after it.`,
      })

    if (
      e.reportLine !== 'indirect' &&
      indirectBudget === 0 &&
      INDIRECT_WORDS.test(`${e.vendor} ${e.memo ?? ''}`)
    )
      findings.push({
        code: 'indirect-as-direct',
        severity: 'attention',
        expenseId: e.id,
        message: `${label}: looks like an indirect or overhead cost on a direct line while the contract's Indirect line is zero. Confirm against the contract's indirect terms.`,
      })
  }

  // Budget overrun per line.
  const billedNow: Partial<Record<ReportLine, number>> = {}
  for (const e of month.expenses)
    billedNow[e.reportLine] = (billedNow[e.reportLine] ?? 0) + e.allocatedAmount
  for (const [line, amount] of Object.entries(billedNow) as [ReportLine, number][]) {
    const cumulative = (month.previouslyBilled[line] ?? 0) + amount
    const budget = month.budget[line] ?? 0
    if (cumulative > budget + 0.005)
      findings.push({
        code: 'budget-overrun',
        severity: 'attention',
        message: `${line}: cumulative ${money(cumulative)} exceeds the budget of ${money(budget)} by ${money(cumulative - budget)}.`,
      })
  }

  // Duplicates: same vendor, amount and date, in this month or an earlier one.
  const key = (x: Pick<RuleExpense, 'vendor' | 'totalCost' | 'date'>) =>
    `${x.vendor.trim().toLowerCase()}|${x.totalCost.toFixed(2)}|${x.date}`
  const seen = new Map<string, string>()
  for (const x of month.earlierExpenses ?? []) seen.set(key(x), x.id)
  for (const e of month.expenses) {
    const k = key(e)
    const other = seen.get(k)
    if (other && other !== e.id)
      findings.push({
        code: 'duplicate-item',
        severity: 'attention',
        expenseId: e.id,
        message: `${e.itemNumber}: same vendor, amount and date as another expense (${e.vendor}, ${money(e.totalCost)}, ${e.date}).`,
      })
    else seen.set(k, e.id)
  }

  // A participant paid for work experience this month must have an eligibility file the auditor can open.
  const required: readonly string[] = month.requiredEligibilityItems ?? REQUIRED_ELIGIBILITY_ITEMS
  for (const p of month.participants ?? []) {
    if (!p.paidThisMonth) continue
    const missing = required.filter((item) => !p.eligibilityItems.includes(item))
    if (missing.length === 0) continue
    const attested = p.eligibilityItems.includes('self-attestation')
    findings.push({
      code: 'participant-file-incomplete',
      severity: attested ? 'info' : 'attention',
      participantId: p.id,
      message: `${p.displayName} (${p.participantId}) is paid this month but the eligibility file lacks: ${missing.join(', ')}${attested ? ' (covered by a self-attestation for now).' : '.'}`,
    })
  }

  if (month.submittedAt) {
    const due = dueDate(month.period, month.dueDay)
    if (new Date(month.submittedAt) > due)
      findings.push({
        code: 'late-submission',
        severity: 'info',
        message: `Submitted ${month.submittedAt.slice(0, 10)}, after the due date of ${isoDate(due)}.`,
      })
  }

  return findings
}
