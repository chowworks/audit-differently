import {
  DOCUMENT_KIND_LABELS,
  PAYROLL_REPORT_LINES,
  type CheckCode,
  type CheckSeverity,
  type DocumentKind,
  type DocumentPurpose,
  type HighlightField,
  type ReportLine,
} from '@ad/types'
import { dateSpans } from '../payroll/highlights'
import { amountPattern } from '../payroll/statement-lines'

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
  /** The engagement's budget line it is spent against; null: none chosen yet. */
  budgetLineId?: string | null
  /** Written by the payroll match from payroll details: a payroll line whatever its budget line. */
  fromPayroll?: boolean
  /**
   * A payroll line entered on the month whose kind of payroll the match counts there too (report-lines.ts): the same
   * pay counted twice, as its kind's words say ("participant pay").
   */
  countedTwice?: string | null
  /** Purposes of the documents attached to this expense. */
  documents: DocumentPurpose[]
  /** Its payroll proofs with the words highlighted on each, for the mismatch rule; none on other lines. */
  proofs?: RuleProof[]
}

/** A payroll proof as linked: what it is for, what kind of file, and the words highlighted on it for its item. */
export interface RuleProof {
  purpose: DocumentPurpose
  kind: string
  words: string[]
  /** A bank line matched as the debit of the pay run that paid the item (owner's decision, 2026-10-19). */
  payRun?: boolean
}

/** A participant's pay for work experience: what proves it, and the words its proofs show. */
export interface RuleWex {
  id: string
  /** Who and when, as the check says it: "Jordan Sample, 09/07/2026 to 09/20/2026". */
  label: string
  grossAmount: number
  /** YYYY-MM-DD */
  start: string
  end: string
  proofs: RuleProof[]
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
  /** The engagement's budget lines: approved, and spent against each on earlier reports. */
  budgetLines?: {
    id: string
    name: string
    amount: number
    previouslyBilled: number
    /** Spent on it this month besides the month's lines: the participants' pay, on the line that holds it. */
    alsoNow?: number
  }[]
  expenses: RuleExpense[]
  /** The month's work-experience payments. */
  wexPayments?: RuleWex[]
  /** What the platform highlights on each kind of payroll proof (HighlightSetting): the mismatch rule checks those. */
  highlights?: Partial<Record<string, HighlightField[]>>
  /** ISO date-time of submission, when submitted. */
  submittedAt?: string | null
  /** Expenses from earlier months of the same contract, for duplicate detection. */
  earlierExpenses?: Pick<RuleExpense, 'id' | 'vendor' | 'totalCost' | 'date'>[]
}

export interface Finding {
  code: CheckCode
  severity: CheckSeverity
  expenseId?: string
  wexPaymentId?: string
  participantId?: string
  message: string
}

const kindWords = (kind: string) => DOCUMENT_KIND_LABELS[kind as DocumentKind] ?? 'proof'

/**
 * Where a highlighted proof does not show what it proves: the amount (on evidence of payment or a timesheet) or the
 * pay period (a participant's proofs). Only proofs the matcher highlighted are read, and only for what the platform
 * highlights on that kind of proof, so a field nobody asked for is never reported missing. A register for a
 * participant is a company summary that rarely names their pay: its amount is not asked for. A bank line passes when
 * it shows the item's amount, or when it was matched as the one debit of the pay run that paid the item (owner's
 * decision, 2026-10-19): that line shows the run's total, never the item's.
 */
function mismatches(
  item: { amount: number; start?: string; end?: string; participant: boolean },
  proofs: RuleProof[],
  highlights: Partial<Record<string, HighlightField[]>>
): string[] {
  const out: string[] = []
  const amount = new RegExp(amountPattern(item.amount).source)
  for (const p of proofs) {
    if (!p.words.length) continue
    const fields = highlights[p.kind] ?? []
    const words = p.words.join(' ')
    const asksAmount =
      fields.includes('amount') &&
      (p.purpose === 'payment' || (p.purpose === 'timesheet' && item.participant))
    const runDebit = p.kind === 'bank-statement' && p.payRun === true
    if (asksAmount && !amount.test(words) && !runDebit)
      out.push(`${money(item.amount)} was not found on its ${kindWords(p.kind)}`)
    if (item.participant && item.start && fields.includes('payPeriod')) {
      const dates = new Set(dateSpans(words).map((d) => d.iso))
      if (!dates.has(item.start) || !dates.has(item.end!))
        out.push(`the pay period was not found on its ${kindWords(p.kind)}`)
    }
  }
  return out
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

    if (PAYROLL_REPORT_LINES.has(e.reportLine) || e.fromPayroll) {
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

    if ((PAYROLL_REPORT_LINES.has(e.reportLine) || e.fromPayroll) && e.proofs)
      for (const what of mismatches(
        { amount: e.totalCost, participant: false },
        e.proofs,
        month.highlights ?? {}
      ))
        findings.push({
          code: 'proof-mismatch',
          severity: 'attention',
          expenseId: e.id,
          message: `${label}: ${what}. Check the proof is this payment's.`,
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

  // A participant's pay needs the same three proofs as a staff payroll line, and they must show its pay.
  for (const w of month.wexPayments ?? []) {
    const has = (p: DocumentPurpose) => w.proofs.some((d) => d.purpose === p)
    const label = `${w.label} (${money(w.grossAmount)})`
    if (!has('timesheet'))
      findings.push({
        code: 'missing-timesheet',
        severity: 'blocker',
        wexPaymentId: w.id,
        message: `${label}: no timesheet attached.`,
      })
    if (!has('register'))
      findings.push({
        code: 'missing-register',
        severity: 'blocker',
        wexPaymentId: w.id,
        message: `${label}: no payroll register attached.`,
      })
    if (!has('payment'))
      findings.push({
        code: 'missing-proof-of-payment',
        severity: 'blocker',
        wexPaymentId: w.id,
        message: `${label}: no pay stub or deposit advice attached.`,
      })
    for (const what of mismatches(
      { amount: w.grossAmount, start: w.start, end: w.end, participant: true },
      w.proofs,
      month.highlights ?? {}
    ))
      findings.push({
        code: 'proof-mismatch',
        severity: 'attention',
        wexPaymentId: w.id,
        message: `${label}: ${what}. Check the proof is this payment's.`,
      })
  }

  // A payroll line typed or imported whose pay the payroll match counts too: matching the month again keeps it for
  // payroll reconciliation only (owner's decision, 2026-10-20).
  for (const e of month.expenses)
    if (e.countedTwice)
      findings.push({
        code: 'payroll-counted-twice',
        severity: 'attention',
        expenseId: e.id,
        message: `${e.itemNumber} (${e.vendor}, ${money(e.allocatedAmount)}): the payroll match already counts this ${e.countedTwice} on the month, so it is counted twice. Match the month's payroll again to keep this line for reconciliation only.`,
      })

  // Every expense is spent against one of the engagement's budget lines: the auditor compares each line with the
  // approved budget, so an expense on no line blocks the month.
  for (const e of month.expenses)
    if (!e.budgetLineId)
      findings.push({
        code: 'no-budget-line',
        severity: 'blocker',
        expenseId: e.id,
        message: `${e.itemNumber} (${e.vendor}, ${money(e.allocatedAmount)}): choose the budget line it is spent against.`,
      })

  // Budget overrun per budget line, as the contract approved it.
  for (const line of month.budgetLines ?? []) {
    const now =
      month.expenses
        .filter((e) => e.budgetLineId === line.id)
        .reduce((t, e) => t + e.allocatedAmount, 0) + (line.alsoNow ?? 0)
    if (!now) continue
    const cumulative = line.previouslyBilled + now
    if (cumulative > line.amount + 0.005)
      findings.push({
        code: 'budget-overrun',
        severity: 'attention',
        message: `${line.name}: spent ${money(cumulative)} to date, over the approved ${money(line.amount)} by ${money(cumulative - line.amount)}.`,
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
