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
