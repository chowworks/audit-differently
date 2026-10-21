import {
  REPORT_LINES,
  REPORT_LINE_LABELS,
  type BudgetLineRow,
  type LineRow,
  type ReportLine,
} from '@ad/types'

interface Amount {
  reportLine: string
  amount: number
}

/** The seven lines of the monthly financial report, computed from the approved budget and the ledger. */
export function computeLines(
  budget: Amount[],
  previouslyBilled: Amount[],
  billedThisPeriod: Amount[]
): LineRow[] {
  const sum = (rows: Amount[], line: ReportLine) =>
    rows.filter((r) => r.reportLine === line).reduce((t, r) => t + r.amount, 0)
  return REPORT_LINES.map((line) => {
    const b = sum(budget, line)
    const prev = sum(previouslyBilled, line)
    const now = sum(billedThisPeriod, line)
    return {
      line,
      label: REPORT_LINE_LABELS[line],
      budget: b,
      previouslyBilled: prev,
      billedThisPeriod: now,
      cumulative: prev + now,
      remaining: b - prev - now,
    }
  })
}

/** The payroll the match covers on a month, by kind: then the books' payroll transactions of that kind stop counting. */
export interface PayrollCover {
  staffPay: boolean
  staffTaxes: boolean
  participantPay: boolean
  participantTaxes: boolean
}

/** A books' payroll transaction's kind, from its account and description: work experience or staff, pay or taxes. */
export function payrollRowKind(e: {
  account?: string | null
  memo?: string | null
  vendor?: string
}) {
  const words = `${e.account ?? ''} ${e.memo ?? ''}`
  const wex = /work experience|\bwex\b/i.test(words)
  const taxes = /tax|benefit|contribution/i.test(words)
  return wex ? (taxes ? 'participantTaxes' : 'participantPay') : taxes ? 'staffTaxes' : 'staffPay'
}

/** The cover a stored payroll kind is counted against. */
const COVER_OF = {
  'staff-pay': 'staffPay',
  'staff-taxes': 'staffTaxes',
  'participant-pay': 'participantPay',
  'participant-taxes': 'participantTaxes',
} as const satisfies Record<string, keyof PayrollCover>

/** Whether a budget line of the engagement holds this kind of payroll from the match. */
export const holdsPayroll = (lines: { payroll?: string[] }[], kind: string) =>
  lines.some((l) => l.payroll?.includes(kind))

/**
 * Each month's cover, from its lines (the match's own, by key) and how many participants' payments it has (payments are
 * the participants' pay, owner's decision, 2026-10-20). The payments cover the participants' pay only on a month whose
 * engagement has a budget line holding it (`paysOnBudget`): otherwise they count nowhere, so the books' rows still do.
 * The match's own lines need no such test: the match writes one only onto a line that holds its kind.
 */
export function payrollCovers(
  lines: { monthlyReportId: string; payrollKey?: string | null }[],
  payments: Map<string, number>,
  paysOnBudget: (monthlyReportId: string) => boolean
): Map<string, PayrollCover> {
  const out = new Map<string, PayrollCover>()
  const of = (id: string) => {
    let c = out.get(id)
    if (!c) {
      c = {
        staffPay: false,
        staffTaxes: false,
        participantPay: (payments.get(id) ?? 0) > 0 && paysOnBudget(id),
        participantTaxes: false,
      }
      out.set(id, c)
    }
    return c
  }
  for (const [id, n] of payments) if (n > 0) of(id)
  for (const l of lines) {
    const c = of(l.monthlyReportId)
    const k = l.payrollKey
    if (!k) continue
    if (k.startsWith('staff:')) {
      if (k.endsWith(':taxes')) c.staffTaxes = true
      else c.staffPay = true
    } else if (k.startsWith('participants:')) c.participantTaxes = true
  }
  return out
}

/** Payroll by its words: salaries, wages, payroll taxes, benefits or work-experience pay (the import's rule). */
export const looksLikePayroll = (e: { account?: string | null; memo?: string | null }) =>
  /\bsalar|\bwages?\b|payroll tax|employee benefit|work experience|\bwex\b/i.test(
    `${e.account ?? ''} ${e.memo ?? ''}`
  )

/** The stored kind of a books' payroll transaction, from its kind of payroll as the cover names it. */
export const PAYROLL_KIND_OF_COVER = {
  staffPay: 'staff-pay',
  staffTaxes: 'staff-taxes',
  participantPay: 'participant-pay',
  participantTaxes: 'participant-taxes',
} as const satisfies Record<keyof PayrollCover, string>

/**
 * A payroll line entered on the month (typed, or imported before the month was matched) whose kind of payroll the
 * match covers on that month: the same pay is counted twice until it is kept for reconciliation only (the match does
 * that on Save; the month's checks say so meanwhile). A line the match wrote, or one already marked, never is.
 */
export function countedTwice(
  e: {
    payrollKey?: string | null
    payrollKind?: string | null
    account?: string | null
    memo?: string | null
  },
  cover: PayrollCover | undefined
): boolean {
  if (e.payrollKey || e.payrollKind || !cover || !looksLikePayroll(e)) return false
  return cover[payrollRowKind(e)]
}

/**
 * Whether a line counts on the budget (and the funder's form): every line does, except a books' payroll transaction
 * whose kind of payroll the match covers on its month, which is kept for payroll reconciliation instead.
 */
export function countsOnBudget(
  e: { payrollKind?: string | null },
  cover: PayrollCover | undefined
): boolean {
  if (!e.payrollKind || !cover) return true
  return !cover[COVER_OF[e.payrollKind as keyof typeof COVER_OF]]
}

/**
 * The participants' pay as spending on the budget line ticked "Participant pay" (owner's decision, 2026-10-20): their
 * payments are the pay, so they count on that line like the lines of the month do. None when no line holds it.
 */
export function participantPaySpend(
  lines: { id: string; reportLine: string; payroll?: string[] }[],
  amount: number
): { budgetLineId: string; reportLine: string; allocatedAmount: number }[] {
  const line = lines.find((l) => holdsPayroll([l], 'participant-pay'))
  return line && amount
    ? [{ budgetLineId: line.id, reportLine: line.reportLine, allocatedAmount: amount }]
    : []
}

/**
 * The engagement's budget lines in a month, as the auditor compares them: approved, spent before this month, spent this
 * month, and what is left. An expense counts on the line it is spent against; one without a line counts on none.
 */
export function computeBudgetLines(
  lines: { id: string; name: string; reportLine: string; amount: unknown }[],
  previouslyBilled: { budgetLineId: string | null; allocatedAmount: unknown }[],
  billedThisPeriod: { budgetLineId: string | null; allocatedAmount: unknown }[]
): BudgetLineRow[] {
  const sum = (rows: typeof previouslyBilled, id: string) =>
    rows.filter((r) => r.budgetLineId === id).reduce((t, r) => t + Number(r.allocatedAmount), 0)
  return lines.map((l) => {
    const budget = Number(l.amount)
    const prev = sum(previouslyBilled, l.id)
    const now = sum(billedThisPeriod, l.id)
    return {
      id: l.id,
      name: l.name,
      reportLine: l.reportLine as ReportLine,
      budget,
      previouslyBilled: prev,
      billedThisPeriod: now,
      cumulative: prev + now,
      remaining: budget - prev - now,
    }
  })
}
