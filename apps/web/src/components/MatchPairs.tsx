/**
 * Matching the month's unmatched receipts as suggested pairs (the owner's choice, 2026-10-16): each receipt beside
 * its best-fit expense, to match, change or set aside; then the receipts nothing fits, to choose for or leave.
 */
import { useState } from 'react'
import {
  RECEIPT_READ_BY_LABELS,
  type ExpenseDto,
  type MatchSuggestion,
  type ReceiptDto,
  type ReportDetail,
} from '@ad/types'
import { money, shortDate } from '@/lib/format'
import { DocumentLink } from '@/components/DocumentLink'
import { Button, Empty } from '@/components/ui'
import './match-pairs.css'

/** What the pairs need from the screen: the receipts left, the expenses still without one, and the actions. */
export interface MatchKit {
  r: ReportDetail
  unmatched: ReceiptDto[]
  /** Expenses without an invoice or receipt yet: the only ones a receipt can go to. */
  open: ExpenseDto[]
  suggestions: MatchSuggestion[]
  busy: boolean
  match: (x: ReceiptDto, expenseId: string) => void
  dismiss: (x: ReceiptDto) => void
  edit: (x: ReceiptDto) => void
  readLine: (x: ReceiptDto) => string
  why: (s: MatchSuggestion) => string
}

/** A receipt's candidates: the suggested fits first, best first, then every other open expense. */
function candidates(k: MatchKit, x: ReceiptDto) {
  const mine = k.suggestions.filter((s) => s.documentId === x.document.id)
  const fits = mine
    .map((s) => ({ e: k.open.find((e) => e.id === s.expenseId), s }))
    .filter((c): c is { e: ExpenseDto; s: MatchSuggestion } => !!c.e)
  const others = k.open.filter((e) => !fits.some((c) => c.e.id === e.id)).map((e) => ({ e }))
  return [...fits, ...others] as { e: ExpenseDto; s?: MatchSuggestion }[]
}

const expenseLine = (e: ExpenseDto) => `${e.vendor} · ${money(e.totalCost)} · ${shortDate(e.date)}`

function ReceiptFacts({ k, x }: { k: MatchKit; x: ReceiptDto }) {
  return (
    <div className="mx-receipt">
      <span className="mx-receipt-icon" aria-hidden="true">
        🧾
      </span>
      <div>
        <DocumentLink doc={x.document} />
        <span className="ad-table-sub">{k.readLine(x)}</span>
        {x.readBy && <span className="ad-table-sub">{RECEIPT_READ_BY_LABELS[x.readBy]}</span>}
        {k.r.can.edit && (
          <button type="button" className="mx-link" onClick={() => k.edit(x)}>
            correct what was read
          </button>
        )}
      </div>
    </div>
  )
}

const LEAVE_NOTE =
  'Leave it unmatched when its expense is not in the ledger yet: add or import the transaction, then match it.'

/** C · Suggested pairs: each receipt beside its best fit, to accept, change or leave; then the ones nothing fits. */
export function MatchPairs({ k }: { k: MatchKit }) {
  const [pick, setPick] = useState<Record<string, string>>({})
  if (!k.unmatched.length) return <Empty>Auto-matching, matched every receipt.</Empty>
  const rows = k.unmatched.map((x) => ({ x, options: candidates(k, x) }))
  const paired = rows.filter((row) => row.options[0]?.s)
  const lone = rows.filter((row) => !row.options[0]?.s)
  const row = ({ x, options }: (typeof rows)[number]) => {
    const chosen = pick[x.document.id] ?? (options[0]?.s ? options[0].e.id : '')
    const c = options.find((o) => o.e.id === chosen)
    return (
      <li key={x.document.id} className="mx-pair">
        <ReceiptFacts k={k} x={x} />
        <span className="mx-arrow" aria-hidden="true">
          →
        </span>
        <div>
          {options.length ? (
            <select
              className="ad-input"
              value={chosen}
              onChange={(ev) => setPick({ ...pick, [x.document.id]: ev.target.value })}
              aria-label="Expense to match"
              disabled={!k.r.can.edit}
            >
              {!chosen && <option value="">Choose an expense</option>}
              {options.map(({ e }) => (
                <option key={e.id} value={e.id}>
                  {e.itemNumber} {expenseLine(e)}
                </option>
              ))}
            </select>
          ) : (
            <span className="text-sm text-soft">No expense is waiting for a receipt.</span>
          )}
          {c?.s && <span className="ad-table-sub">{k.why(c.s)}</span>}
        </div>
        {k.r.can.edit && (
          <div className="mx-pair-actions">
            <Button
              kind="primary"
              size="sm"
              disabled={k.busy || !chosen}
              onClick={() => k.match(x, chosen)}
            >
              Match
            </Button>
            <Button kind="ghost" size="sm" onClick={() => k.dismiss(x)} disabled={k.busy}>
              Not for this grant
            </Button>
          </div>
        )}
      </li>
    )
  }
  return (
    <div className="grid gap-4">
      {paired.length > 0 && (
        <section>
          <h3 className="ad-group-title">
            <span aria-hidden="true">⚡</span> Auto-Match pre-filled our suggestions
          </h3>
          <ul className="mx-list">{paired.map(row)}</ul>
        </section>
      )}
      {lone.length > 0 && (
        <section>
          <h3 className="ad-group-title">
            Auto-matching failed. Match to an expense, or leave unmatched.
          </h3>
          <p className="text-sm text-soft">{LEAVE_NOTE}</p>
          <ul className="mx-list">{lone.map(row)}</ul>
        </section>
      )}
    </div>
  )
}
