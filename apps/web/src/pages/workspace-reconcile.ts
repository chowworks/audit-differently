// The month end's reconciliation as two grids, Expenses & Proof and Payroll & Proof, laid out like the month page's
// (owner's decision, 2026-11-14): each row is red (something missing), yellow (an alert) or green (complete), grouped by
// engagement, with what is on no engagement yet last. The tiles count both grids and filter them.
import {
  type CheckDto,
  type DocumentPurpose,
  type ExpenseDto,
  type ReportDetail,
  type BooksLineDto,
  type BooksLineStatus,
  type BooksReceiptDto,
  type BooksRunDto,
  type DroppedDecisionDto,
  type PayLineDto,
  type PayrollReconciliationDto,
  type TwoProofsDto,
  type WorkspaceExpensesDto,
} from '@ad/types'
import {
  checksOfExpense,
  expensesOf,
  missingOf,
  payFacts,
  payRowsOf,
  requiredPurposes,
  type PayRow as MonthPayRow,
} from './report-layouts/proof-rows'

export type Tone = 'red' | 'yellow' | 'green'
export const TONES: Tone[] = ['red', 'yellow', 'green']

/** The group of what is on no engagement yet: listed last in each grid. */
export const NO_ENGAGEMENT = ''

type Staff = PayrollReconciliationDto['staffOnNoEngagement'][number]

export type PayRow =
  | {
      kind: 'month'
      key: string
      tone: Tone
      group: string
      r: ReportDetail
      row: MonthPayRow
      missing: DocumentPurpose[]
    }
  | { kind: 'pay'; key: string; tone: Tone; group: string; p: PayLineDto }
  | { kind: 'staff'; key: string; tone: Tone; group: string; s: Staff }
  | { kind: 'two'; key: string; tone: Tone; group: string; t: TwoProofsDto }
  | { kind: 'dropped'; key: string; tone: Tone; group: string; d: DroppedDecisionDto }
  | { kind: 'run'; key: string; tone: Tone; group: string; r: BooksRunDto }

export type ExpenseRow =
  | {
      kind: 'month'
      key: string
      tone: Tone
      group: string
      r: ReportDetail
      e: ExpenseDto
      missing: DocumentPurpose[]
    }
  | { kind: 'receipt'; key: string; tone: Tone; group: string; r: BooksReceiptDto }
  | { kind: 'off'; key: string; tone: Tone; group: string; l: BooksLineDto }

/** A run's payroll the books and the payroll files both have, for the same amount. */
export const agrees = (r: BooksRunDto) =>
  r.books !== null && r.files !== null && Math.abs(r.books - r.files) < 0.005

const itemKey = (target: string, id: string) => `${target}:${id}`

/**
 * A month row's tone, as the month page's tiles count it: red while a proof is missing or a check blocks, yellow while
 * a check needs attention, green when neither.
 */
export function monthTone(missing: DocumentPurpose[], checks: CheckDto[]): Tone {
  if (missing.length || checks.some((k) => k.severity === 'blocker')) return 'red'
  if (checks.some((k) => k.severity === 'attention')) return 'yellow'
  return 'green'
}

/**
 * The payroll grid's rows: each engagement month's payroll rows as its month page shows them, then two files that
 * disagree on an item (yellow, in its engagement), each pay in the files not on an item (yellow to place; green once
 * marked not grant-funded), the staff charged or paid on no engagement, the decisions dropped with their files, and
 * each run whose expenses differ from the payroll files (yellow, in its engagement). People with neither a charge nor
 * a pay this month have no row.
 */
export function payrollRows(d: PayrollReconciliationDto, months: ReportDetail[]): PayRow[] {
  const rows: PayRow[] = []
  for (const r of months)
    for (const row of payRowsOf(r)) {
      const f = payFacts(r, row)
      const missing = missingOf(f.needed, f.docs)
      rows.push({
        kind: 'month',
        key: `m-${row.kind}:${row.id}`,
        tone: monthTone(missing, f.checks),
        group: r.engagement.id,
        r,
        row,
        missing,
      })
    }
  const ofReport = new Map(months.map((r) => [r.id, r.engagement.id] as [string, string]))
  for (const t of d.twoProofs)
    rows.push({
      kind: 'two',
      key: `t-${itemKey(t.target, t.id)}-${t.slot}`,
      tone: 'yellow',
      group: ofReport.get(t.reportId) ?? engagementOfReport(d, t.reportId) ?? NO_ENGAGEMENT,
      t,
    })
  for (const p of d.pays)
    if (p.state !== 'matched')
      rows.push({
        kind: 'pay',
        key: `p-${p.id}`,
        tone: p.state === 'not-funded' && !p.flags.length ? 'green' : 'yellow',
        group: NO_ENGAGEMENT,
        p,
      })
  for (const s of d.staffOnNoEngagement)
    if (s.inFiles && (s.charged !== null || s.paid !== null))
      rows.push({
        kind: 'staff',
        key: `s-${s.id}`,
        // Charged to the grant but on no engagement is to fix; paid with no charge is not grant-funded, nothing to do.
        tone: s.charged !== null ? 'yellow' : 'green',
        group: NO_ENGAGEMENT,
        s,
      })
  d.dropped.forEach((x, n) =>
    rows.push({
      kind: 'dropped',
      key: `d-${x.id ?? n}`,
      tone: 'yellow',
      group: NO_ENGAGEMENT,
      d: x,
    })
  )
  for (const r of d.books)
    if (!agrees(r))
      rows.push({
        kind: 'run',
        key: `r-${r.reportId}-${r.date}-${r.kind}`,
        tone: 'yellow',
        group: r.engagementId,
        r,
      })
  return rows
}

function engagementOfReport(d: PayrollReconciliationDto, reportId: string) {
  return d.items.find((i) => i.item.reportId === reportId)?.item.engagementId ?? null
}

/** The books' reasons for a line on no engagement that leave grant spending unbilled: an owner should look. */
const OFF_TO_LOOK_AT = new Set<BooksLineStatus>(['no-program', 'no-mapping', 'no-budget-line'])

/**
 * The expenses grid's rows: each engagement month's expenses as its month page shows them (red while a proof is
 * missing or a check blocks, yellow while one needs attention), then each receipt matched to no bill (yellow), and the
 * books' lines on no engagement (green, the books' choice; yellow when the reason is a missing program name, mapping
 * or budget line). A books line not saved to its month yet is not a row: Actions lists what is to save.
 */
export function expenseRows(
  d: Pick<WorkspaceExpensesDto, 'lines' | 'receipts'> | null,
  months: ReportDetail[]
): ExpenseRow[] {
  const rows: ExpenseRow[] = []
  for (const r of months)
    for (const e of expensesOf(r)) {
      const missing = missingOf(requiredPurposes(e), e.documents)
      rows.push({
        kind: 'month',
        key: `m-${e.id}`,
        tone: monthTone(missing, checksOfExpense(r, e)),
        group: r.engagement.id,
        r,
        e,
        missing,
      })
    }
  for (const r of d?.receipts ?? [])
    if (!r.transactionIds.length)
      rows.push({
        kind: 'receipt',
        key: `r-${r.documentId}`,
        tone: 'yellow',
        group: NO_ENGAGEMENT,
        r,
      })
  for (const l of d?.lines ?? [])
    if (l.status !== 'billed' && l.status !== 'already-entered')
      rows.push({
        kind: 'off',
        key: `o-${l.key}`,
        tone: OFF_TO_LOOK_AT.has(l.status) ? 'yellow' : 'green',
        group: NO_ENGAGEMENT,
        l,
      })
  return rows
}

/** How many rows of each tone, over both grids. */
export function toneCounts(...grids: { tone: Tone }[][]): Record<Tone, number> {
  const out: Record<Tone, number> = { red: 0, yellow: 0, green: 0 }
  for (const g of grids) for (const r of g) out[r.tone] += 1
  return out
}

/**
 * Rows in their groups: the engagements by name, then what is on no engagement yet. Each group keeps its rows in tone
 * order (red, yellow, green), so what needs work comes first.
 */
export function grouped<R extends { tone: Tone; group: string }>(
  rows: R[],
  names: Map<string, string>
): { id: string; name: string; rows: R[] }[] {
  const by = new Map<string, R[]>()
  for (const r of rows) by.set(r.group, [...(by.get(r.group) ?? []), r])
  return [...by.entries()]
    .map(([id, rs]) => ({
      id,
      name: id === NO_ENGAGEMENT ? 'Not on an engagement yet' : (names.get(id) ?? 'Engagement'),
      rows: [...rs].sort((a, b) => TONES.indexOf(a.tone) - TONES.indexOf(b.tone)),
    }))
    .sort((a, b) =>
      a.id === NO_ENGAGEMENT ? 1 : b.id === NO_ENGAGEMENT ? -1 : a.name.localeCompare(b.name)
    )
}
