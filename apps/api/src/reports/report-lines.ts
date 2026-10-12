import { REPORT_LINES, REPORT_LINE_LABELS, type LineRow, type ReportLine } from '@ad/types'

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
