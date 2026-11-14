/*
 * The rows of the month page's Expenses & Proof and Payroll & Proof grids, shared with the month end page so the two
 * show the same row the same way (owner's decision, 2026-11-14: "rows and row features identical"). A row here is
 * one table row; each page keeps its own filters, grouping and dialogs.
 */
import { useState, type ReactNode } from 'react'
import {
  ALLOCATION_TYPE_LABELS,
  DOCUMENT_KIND_LABELS,
  DOCUMENT_PURPOSE_LABELS,
  isPayrollLine,
  type CheckDto,
  type DocumentPurpose,
  type ExpenseDto,
  type ReportDetail,
  type WexPaymentDto,
} from '@ad/types'
import { money, payPeriodWords, shortDate } from '@/lib/format'
import { Button, Chip, severityTone } from '@/components/ui'
import { DocumentLink } from '@/components/DocumentLink'
import { TagChips } from '@/components/Tags'
import { plural } from './shared'

export const PAYROLL_PURPOSES: DocumentPurpose[] = ['timesheet', 'register', 'payment']

/** The proof each expense needs (the same rule as ReportPage's ledger). */
export function requiredPurposes(e: ExpenseDto): DocumentPurpose[] {
  const base: DocumentPurpose[] = isPayrollLine(e)
    ? ['timesheet', 'register', 'payment']
    : ['invoice', 'payment']
  return e.allocationType === 'direct' ? base : [...base, 'allocation']
}

export const missingOf = (needed: DocumentPurpose[], docs: { purpose: DocumentPurpose }[]) =>
  needed.filter((p) => !docs.some((d) => d.purpose === p))

export const checksOfExpense = (r: ReportDetail, e: ExpenseDto) =>
  r.checks.filter((k) => k.expenseId === e.id)
export const checksOfPayment = (r: ReportDetail, w: WexPaymentDto) =>
  r.checks.filter(
    (k) =>
      k.wexPaymentId === w.id ||
      (!k.expenseId && !k.wexPaymentId && k.participantId === w.participantId)
  )

export const cautionOf = (k: CheckDto) =>
  k.severity === 'attention' ? 'rl-c-chip-caution' : undefined

/** A row's checks, folded behind "see checks" unless the grid is filtered to them. */
export function RowChecks({ checks, open }: { checks: CheckDto[]; open: boolean }) {
  return (
    <ul className="rl-c-rowchecks" hidden={!open}>
      {checks.map((k) => (
        <li key={k.id}>
          <Chip tone={severityTone[k.severity]} fill className={cautionOf(k)}>
            {k.severity === 'blocker' ? 'blocking' : k.severity}
          </Chip>
          <span>{k.message}</span>
        </li>
      ))}
    </ul>
  )
}

export function useOpenChecks() {
  const [open, setOpen] = useState<Set<string>>(new Set())
  const toggle = (id: string) =>
    setOpen((o) => {
      const n = new Set(o)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  return [open, toggle] as const
}

export function SeeChecks({
  checks,
  open,
  onToggle,
}: {
  checks: CheckDto[]
  open: boolean
  onToggle: () => void
}) {
  if (!checks.length) return null
  const worst = checks.some((k) => k.severity === 'blocker')
    ? 'blocker'
    : checks.some((k) => k.severity === 'attention')
      ? 'attention'
      : 'info'
  return (
    <button
      type="button"
      className={`rl-c-seechecks rl-c-seechecks-${worst}`}
      aria-expanded={open}
      onClick={onToggle}
    >
      {open ? 'hide' : 'see'} {plural(checks.length, 'check')}
    </button>
  )
}

/**
 * The page an attached proof opens at: its highlight's. A split line's pay stub opens at its first page, the note of
 * the split the API puts before the stub.
 */
export function firstPage(
  d: ExpenseDto['documents'][number],
  noteFirst = false
): number | undefined {
  if (noteFirst && d.document.kind === 'paystub') return undefined
  return d.mark?.page ?? d.marks?.[0]?.page
}

/**
 * The proof a chip shows for each needed purpose, and the rest. Evidence of payment is the pay stub whenever one is
 * attached, so every payroll line shows the same kind of proof; a bank debit attached as well is shown beside it.
 */
export function proofsShown<D extends { purpose: DocumentPurpose; document: { kind: string } }>(
  needed: DocumentPurpose[],
  docs: D[]
): { have: Map<DocumentPurpose, D>; extra: D[] } {
  const have = new Map<DocumentPurpose, D>()
  for (const purpose of needed) {
    const of = docs.filter((d) => d.purpose === purpose)
    const pick = (purpose === 'payment' && of.find((d) => d.document.kind === 'paystub')) || of[0]
    if (pick) have.set(purpose, pick)
  }
  const shown = new Set(have.values())
  return { have, extra: docs.filter((d) => !shown.has(d)) }
}

export function ProofChips({
  can,
  needed,
  docs,
  testId,
  onAdd,
  proofOf,
  files = true,
  noteFirst = false,
}: {
  can: boolean
  needed: DocumentPurpose[]
  docs: ExpenseDto['documents']
  testId: string
  onAdd: (purpose: DocumentPurpose) => void
  /** A payroll or books line: its proofs open as its own highlighted copies. */
  proofOf?: { target: 'expense' | 'wex'; id: string }
  /** False: "Bookkeepers see staff payroll" is off, so the proofs show as labels that open nothing. */
  files?: boolean
  /** A split staff line: its pay stub's copy opens with the note of the split. */
  noteFirst?: boolean
}) {
  const { have, extra } = proofsShown(needed, docs)
  return (
    <div className="flex flex-wrap gap-1">
      {needed.map((purpose) => {
        const d = have.get(purpose)
        return d ? (
          <Chip key={purpose} tone="ok" fill title={files ? d.document.fileName : undefined}>
            {files ? (
              <DocumentLink doc={d.document} proofOf={proofOf} page={firstPage(d, noteFirst)}>
                ✓ {DOCUMENT_PURPOSE_LABELS[purpose]}
              </DocumentLink>
            ) : (
              <>✓ {DOCUMENT_PURPOSE_LABELS[purpose]}</>
            )}
          </Chip>
        ) : can ? (
          <button
            key={purpose}
            type="button"
            className="ad-chip ad-chip-missing"
            onClick={() => onAdd(purpose)}
            data-testid={`attach-${testId}-${purpose}`}
          >
            + {DOCUMENT_PURPOSE_LABELS[purpose]}
          </button>
        ) : (
          <Chip key={purpose} tone="danger" fill>
            missing {DOCUMENT_PURPOSE_LABELS[purpose]}
          </Chip>
        )
      })}
      {extra.map((d) => {
        // A second proof of a needed purpose (a staff line's bank debit beside its pay stub) is named by its kind.
        const word = needed.includes(d.purpose)
          ? DOCUMENT_KIND_LABELS[d.document.kind].replace(/^./, (c) => c.toUpperCase())
          : DOCUMENT_PURPOSE_LABELS[d.purpose]
        return (
          <Chip key={d.document.id} tone="muted" title={files ? d.document.fileName : undefined}>
            {files ? (
              <DocumentLink
                doc={d.document}
                proofOf={needed.includes(d.purpose) ? proofOf : undefined}
                page={firstPage(d, noteFirst)}
              >
                {word}
              </DocumentLink>
            ) : (
              word
            )}
          </Chip>
        )
      })}
    </div>
  )
}

export type PayRow =
  { kind: 'expense'; id: string; e: ExpenseDto } | { kind: 'wex'; id: string; w: WexPaymentDto }

/** What a row can do on the page that shows it: the month page passes its own actions; absent, the row only shows. */
export interface RowActions {
  editExpense?: (e: ExpenseDto) => void
  deleteExpense?: (e: ExpenseDto) => void
  editPayment?: (w: WexPaymentDto) => void
  deletePayment?: (w: WexPaymentDto) => void
}

/**
 * Adding a payroll row's missing proof, as the month page does: a staff line's evidence of payment is its bank line,
 * found for this row alone when the month has a statement and its files show; the rest open the attach dialog.
 */
export function addPayrollProof(
  r: ReportDetail,
  act: {
    attach: (e: ExpenseDto, purpose: DocumentPurpose) => void
    attachPayment: (w: WexPaymentDto, purpose: DocumentPurpose) => void
    findBankLine: (e: ExpenseDto) => void
  },
  row: PayRow,
  purpose: DocumentPurpose
) {
  const files = r.can.seeStaffPayroll !== false
  const hasStatements = r.payrollDocuments.some((d) => d.kind === 'bank-statement')
  if (purpose === 'payment' && row.kind === 'expense' && hasStatements && files)
    return act.findBankLine(row.e)
  if (row.kind === 'expense') act.attach(row.e, purpose)
  else act.attachPayment(row.w, purpose)
}

/** The month's payroll rows: its payroll lines the match does not cover, then each participant paid. */
export function payRowsOf(r: ReportDetail): PayRow[] {
  return [
    ...r.expenses
      // A books' payroll transaction the match covers is no longer the month's pay: it shows in the reconciliation only.
      .filter((e) => isPayrollLine(e) && e.counts)
      .map((e) => ({ kind: 'expense' as const, id: e.id, e })),
    ...r.wexPayments.map((w) => ({ kind: 'wex' as const, id: w.id, w })),
  ]
}

/** A payroll row's checks, the proof it needs and its documents. */
export function payFacts(r: ReportDetail, row: PayRow) {
  return row.kind === 'expense'
    ? {
        checks: checksOfExpense(r, row.e),
        needed: requiredPurposes(row.e),
        docs: row.e.documents,
        tags: row.e.tags,
      }
    : {
        checks: checksOfPayment(r, row.w),
        needed: PAYROLL_PURPOSES,
        docs: row.w.documents,
        tags: row.w.tags,
      }
}

/** The month's expenses grid holds its expenses that are not payroll. */
export const expensesOf = (r: ReportDetail) => r.expenses.filter((e) => !isPayrollLine(e))

export function ExpenseHead({ actions }: { actions: boolean }) {
  return (
    <tr>
      <th>Item</th>
      <th>Vendor</th>
      <th>Budget line</th>
      <th className="ad-num">Total</th>
      <th className="ad-num">Charged</th>
      <th className="rl-c-proofcol">Proof</th>
      {actions && <th></th>}
    </tr>
  )
}

/** One expense, as the month page's Expenses & Proof grid shows it. */
export function ExpenseRow({
  r,
  e,
  checksOpen,
  onToggleChecks,
  onAdd,
  act,
  actions,
  highlight,
  end,
}: {
  r: ReportDetail
  e: ExpenseDto
  checksOpen: boolean
  onToggleChecks: () => void
  onAdd: (purpose: DocumentPurpose) => void
  act?: RowActions
  /** The last column is there: the month's editors see it. */
  actions: boolean
  highlight?: boolean
  /** What the last column shows in place of edit and remove (the month end's link to the month). */
  end?: ReactNode
}) {
  const checks = checksOfExpense(r, e)
  return (
    <tr
      id={`expense-${e.id}`}
      className={highlight ? 'ad-row-flash' : undefined}
      data-testid={`expense-${e.itemNumber}`}
    >
      <td className="whitespace-nowrap">
        <span className="ad-mono font-semibold">{e.itemNumber}</span>
        <span className="ad-table-sub">{e.date}</span>
      </td>
      <td>
        <span className="font-semibold">{e.vendor}</span>
        <span className="ad-table-sub">
          {e.memo}
          {e.account ? ` · ${e.account}` : ''}
        </span>
        <TagChips types={r.tagTypes} tags={e.tags} />
      </td>
      <td>
        {e.budgetLineName ?? <span className="text-danger">Needs a budget line</span>}
        {e.allocationType !== 'direct' && (
          <span className="ad-table-sub">
            {ALLOCATION_TYPE_LABELS[e.allocationType]}
            {e.allocationNote ? `: ${e.allocationNote}` : ''}
          </span>
        )}
      </td>
      <td className="ad-num">{money(e.totalCost)}</td>
      <td className="ad-num font-semibold">{money(e.allocatedAmount)}</td>
      <td>
        <ProofChips
          can={r.can.edit}
          needed={requiredPurposes(e)}
          docs={e.documents}
          testId={e.itemNumber}
          onAdd={onAdd}
          proofOf={e.fromBooks ? { target: 'expense', id: e.id } : undefined}
        />
        <SeeChecks checks={checks} open={checksOpen} onToggle={onToggleChecks} />
        <RowChecks checks={checks} open={checksOpen} />
      </td>
      {actions && (
        <td className="ad-num whitespace-nowrap">
          {/* A line from the books is changed in the books or on the month's expenses, never here
              (review fix, 2026-11-12); its proofs are still attached in the Proof column. */}
          {e.fromBooks ? (
            <span className="ad-table-sub" data-testid={`from-books-${e.itemNumber}`}>
              from the books
            </span>
          ) : end !== undefined ? (
            end
          ) : (
            <>
              <Button kind="ghost" onClick={() => act?.editExpense?.(e)}>
                edit
              </Button>
              <Button
                kind="ghost"
                className="text-danger"
                onClick={() => act?.deleteExpense?.(e)}
                data-testid={`delete-${e.itemNumber}`}
              >
                remove
              </Button>
            </>
          )}
        </td>
      )}
    </tr>
  )
}

export function PayrollHead({ actions }: { actions: boolean }) {
  return (
    <tr>
      <th>Vendor/Participant Paid</th>
      <th>Date</th>
      <th className="ad-num">Amount</th>
      <th className="rl-c-proofcol">Proof</th>
      {actions && <th></th>}
    </tr>
  )
}

/** One payroll line or participant paid, as the month page's Payroll & Proof grid shows it. */
export function PayrollRow({
  r,
  row,
  checksOpen,
  onToggleChecks,
  onAdd,
  act,
  actions,
  end,
}: {
  r: ReportDetail
  row: PayRow
  checksOpen: boolean
  onToggleChecks: () => void
  onAdd: (purpose: DocumentPurpose) => void
  act?: RowActions
  actions: boolean
  end?: ReactNode
}) {
  const f = payFacts(r, row)
  // "Bookkeepers see staff payroll" off: the same rows, but no proof opens its file (the screen only).
  const files = r.can.seeStaffPayroll !== false
  return (
    <tr id={row.kind === 'expense' ? `expense-${row.id}` : undefined}>
      <td>
        {row.kind === 'expense' ? (
          <>
            <span className="ad-mono font-semibold">{row.e.itemNumber}</span>{' '}
            <span className="font-semibold">{row.e.vendor}</span>
            <span className="ad-table-sub">{row.e.budgetLineName ?? 'Needs a budget line'}</span>
          </>
        ) : (
          <>
            <span className="font-semibold">{row.w.participantName}</span>
            <span className="ad-table-sub ad-mono">{row.w.participantNumber}</span>
          </>
        )}
        <TagChips types={r.tagTypes} tags={f.tags} />
      </td>
      <td className="whitespace-nowrap">
        {row.kind === 'expense'
          ? shortDate(row.e.date)
          : payPeriodWords(row.w.payPeriodStart, row.w.payPeriodEnd)}
        {row.kind === 'wex' && row.w.hours != null && (
          <span className="ad-table-sub">{row.w.hours} hours</span>
        )}
      </td>
      <td className="ad-num font-semibold">
        {money(row.kind === 'expense' ? row.e.allocatedAmount : row.w.grossAmount)}
      </td>
      <td>
        <ProofChips
          can={r.can.edit}
          needed={f.needed}
          docs={f.docs}
          testId={row.kind === 'expense' ? row.e.itemNumber : row.w.participantNumber}
          onAdd={onAdd}
          proofOf={{ target: row.kind, id: row.id }}
          files={files}
          noteFirst={row.kind === 'expense' && !!row.e.payrollSplit}
        />
        <SeeChecks checks={f.checks} open={checksOpen} onToggle={onToggleChecks} />
        <RowChecks checks={f.checks} open={checksOpen} />
      </td>
      {actions && (
        <td className="ad-num whitespace-nowrap">
          {end !== undefined ? (
            end
          ) : row.kind === 'expense' ? (
            <>
              <Button kind="ghost" onClick={() => act?.editExpense?.(row.e)}>
                edit
              </Button>
              <Button
                kind="ghost"
                className="text-danger"
                onClick={() => act?.deleteExpense?.(row.e)}
              >
                remove
              </Button>
            </>
          ) : (
            <>
              <Button kind="ghost" onClick={() => act?.editPayment?.(row.w)}>
                edit
              </Button>
              <Button
                kind="ghost"
                className="text-danger"
                onClick={() => act?.deletePayment?.(row.w)}
              >
                remove
              </Button>
            </>
          )}
        </td>
      )}
    </tr>
  )
}
