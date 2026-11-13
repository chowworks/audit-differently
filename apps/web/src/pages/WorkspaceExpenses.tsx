import { useState } from 'react'
import type {
  AccountMappingDto,
  BooksBillDto,
  BooksBillInput,
  BooksLineDto,
  BooksPaymentInput,
  BooksReceiptDto,
  WorkspaceExpensesDto,
  WorkspaceExpensesSavedDto,
} from '@ad/types'
import { useApi, useLoad } from '@/hooks/useApi'
import { money, periodLabel } from '@/lib/format'
import { Button, Card, Chip, Empty, ErrorNote, Notice } from '@/components/ui'
import {
  engagementGroups,
  notOnEngagements,
  paidWords,
  paymentWords,
  receiptWords,
  statementLineWords,
  saveCounts,
  saveLabel,
  shareWords,
  unmatchedReceipts,
  unreadWords,
} from './workspace-expenses'
import { RECEIPT_MAX_BYTES, mb } from '@/components/PayrollProof'
import './workspace-expenses.css'

const many = (n: number, one: string, more = `${one}s`) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : more}`
const SKIP = 'skip'

/**
 * The month's expenses from the books (owner's decision, 2026-11-09): the step after payroll. Each line of the
 * accounting export in the month's files that is no one's pay, on the engagement its class is and the budget line its
 * account maps to, or why it is on none. Owners save; auditors read.
 */
export function WorkspaceExpenses({
  workspaceId,
  period,
  onDone,
}: {
  workspaceId: string
  period: string
  /** Saved, or left for later: back to the month's summary. */
  onDone: (saved: string | null) => void
}) {
  const api = useApi()
  const load = useLoad<WorkspaceExpensesDto>(`/workspaces/${workspaceId}/expenses/${period}`)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const d = load.data?.period === period ? load.data : null
  if (load.error) return <ErrorNote message={load.error} />
  if (!d) return <Empty>Reading the books…</Empty>
  const can = d.can.change
  const groups = engagementGroups(d.lines)
  const notOn = notOnEngagements(d.lines)
  const counts = saveCounts(d.lines, d.toRemove ?? [])
  const unread = unreadWords(d.unread ?? [])

  const changeMapping = async (m: AccountMappingDto, body: Record<string, unknown>) => {
    setError(null)
    setBusy('Saving the mapping…')
    try {
      await api.patch(`/workspaces/${workspaceId}/account-mappings/${m.id}`, body)
      await load.reload()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  const receiptsUrl = `/workspaces/${workspaceId}/expenses/${period}/receipts`
  const addReceipts = async (files: File[], transactionId?: string) => {
    if (!files.length) return
    setError(null)
    // A receipt over the server's limit is named and left out before anything is sent.
    const big = files.filter((f) => f.size > RECEIPT_MAX_BYTES)
    files = files.filter((f) => f.size <= RECEIPT_MAX_BYTES)
    const leftOut = big.length
      ? `Over ${mb(RECEIPT_MAX_BYTES)}, left out: ${big.map((f) => f.name).join(', ')}.`
      : null
    setError(leftOut)
    if (!files.length) return
    setBusy(transactionId ? 'Reading the receipt…' : `Reading ${many(files.length, 'receipt')}…`)
    try {
      for (let at = 0; at < files.length; at += 20) {
        const form = new FormData()
        for (const f of files.slice(at, at + 20)) form.append('files', f)
        if (transactionId) form.append('transactionId', transactionId)
        load.setData(await api.upload<WorkspaceExpensesDto>(receiptsUrl, form))
      }
    } catch (e) {
      const message = (e as Error).message
      // The server names a receipt it refuses for its type or size; a lone receipt is named here when it does not.
      const named =
        files.length === 1 && !message.includes(files[0]!.name)
          ? `${files[0]!.name}: ${message}`
          : message
      setError(leftOut ? `${leftOut} ${named}` : named)
    } finally {
      setBusy(null)
    }
  }
  const setBill = async (body: Omit<BooksBillInput, 'period'>) => {
    setError(null)
    setBusy(body.dropped ? 'Dropping the bill…' : 'Saving the receipt…')
    try {
      load.setData(
        await api.put<WorkspaceExpensesDto>(`/workspaces/${workspaceId}/expenses/bills`, {
          ...body,
          period,
        })
      )
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  const setPayment = async (body: Omit<BooksPaymentInput, 'period'>) => {
    setError(null)
    setBusy('Saving the payment…')
    try {
      load.setData(
        await api.put<WorkspaceExpensesDto>(`/workspaces/${workspaceId}/expenses/payments`, {
          ...body,
          period,
        })
      )
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  const bills: BillActions | null = can
    ? {
        busy: !!busy,
        open: unmatchedReceipts(d),
        attach: (transactionId, file) => void addReceipts([file], transactionId),
        choose: (transactionId, documentId) =>
          void setBill({ transactionId, documentId, dropped: false }),
        drop: (transactionId, dropped) =>
          void setBill({ transactionId, documentId: null, dropped }),
        pay: (transactionId, payment) => void setPayment({ transactionId, payment }),
      }
    : null
  const save = async () => {
    setError(null)
    setBusy('Saving the expenses…')
    try {
      const r = await api.post<WorkspaceExpensesSavedDto>(
        `/workspaces/${workspaceId}/expenses/${period}/save`
      )
      load.setData(r.expenses)
      onDone(
        `Saved the expenses for ${periodLabel(period)}: ${many(r.created, 'line')} added, ${many(r.updated, 'line')} changed, ${many(r.removed, 'line')} removed.`
      )
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="grid gap-4">
      <Card
        eyebrow={`Expenses · ${periodLabel(period)}`}
        title="Expenses from the books"
        aside={
          d.file ? <span className="text-sm text-soft">From {d.file.fileName}</span> : undefined
        }
      >
        {!d.file ? (
          <p className="text-soft">
            The month's files have no books export with expenses. Put the month's QuickBooks
            Transaction List with Splits in the zip's QuickBooks transactions folder.
          </p>
        ) : (
          <p className="text-sm">
            Every line of the books on an expense account that is no one's pay, routed to an
            engagement by its class and to a budget line by its account.{' '}
            <b>
              {many(
                groups.reduce((t, g) => t + g.lines.length, 0),
                'line'
              )}
            </b>{' '}
            on engagements,{' '}
            <b>
              {many(
                notOn.reduce((t, g) => t + g.lines.length, 0),
                'line'
              )}
            </b>{' '}
            on none, each with why.
          </p>
        )}
        {unread && <Notice tone="warn">{unread}</Notice>}
        {error && <ErrorNote message={error} />}
        {busy && <Notice tone="info">{busy}</Notice>}
      </Card>

      <Card title="Account mappings">
        {d.mappings.length === 0 ? (
          <p className="text-soft">
            No account mapping yet. Put each engagement's chart of accounts mapping (account number
            and the category it bills to) in the zip's <b>Account mapping</b> folder.
          </p>
        ) : (
          <div className="grid gap-3">
            {d.mappings.map((m) => {
              const e = d.engagements.find((x) => x.id === m.engagementId)
              return (
                <div key={m.id} className="wex-mapping">
                  <div className="wex-mapping-head">
                    <b>{m.fileName}</b>
                    {can ? (
                      <select
                        aria-label={`Engagement of ${m.fileName}`}
                        value={m.engagementId ?? ''}
                        disabled={!!busy}
                        onChange={(ev) => void changeMapping(m, { engagementId: ev.target.value })}
                      >
                        {!m.engagementId && <option value="">Choose its engagement…</option>}
                        {d.engagements.map((x) => (
                          <option key={x.id} value={x.id}>
                            {x.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span>{m.engagementName ?? 'No engagement'}</span>
                    )}
                  </div>
                  {m.engagementId && (
                    <div className="ad-tablewrap">
                      <table className="ad-table">
                        <thead>
                          <tr>
                            <th>Category in the file</th>
                            <th className="ad-num">Accounts</th>
                            <th>Budget line</th>
                          </tr>
                        </thead>
                        <tbody>
                          {m.categories.map((c) => (
                            <tr key={c.category}>
                              <td>{c.category}</td>
                              <td className="ad-num">{c.accounts}</td>
                              <td>
                                {can ? (
                                  <select
                                    aria-label={`Budget line for ${c.category}`}
                                    value={c.chosen ? (c.budgetLineId ?? '') : ''}
                                    disabled={!!busy}
                                    onChange={(ev) =>
                                      void changeMapping(m, {
                                        category: c.category,
                                        budgetLineId: ev.target.value || null,
                                      })
                                    }
                                  >
                                    <option value="">
                                      {c.chosen || !c.budgetLineName
                                        ? c.chosen
                                          ? 'As the file says'
                                          : 'Choose a budget line…'
                                        : `${c.budgetLineName} (as the file says)`}
                                    </option>
                                    {e?.budgetLines.map((b) => (
                                      <option key={b.id} value={b.id}>
                                        {b.name}
                                      </option>
                                    ))}
                                    <option value={SKIP}>Not billed</option>
                                  </select>
                                ) : (
                                  (c.budgetLineName ??
                                  (c.budgetLineId === SKIP ? 'Not billed' : 'None'))
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </Card>

      {d.file && (
        <Card
          title="Receipts"
          aside={
            can ? (
              <label className="wex-file">
                <input
                  type="file"
                  multiple
                  accept=".pdf,.png,.jpg,.jpeg"
                  disabled={!!busy}
                  onChange={(ev) => {
                    void addReceipts([...(ev.target.files ?? [])])
                    ev.target.value = ''
                  }}
                />
                <span>Upload receipts</span>
              </label>
            ) : undefined
          }
        >
          <p className="text-sm">
            Each line's bills, proved by their receipts (the zip's <b>Receipts</b> folder, receipts
            emailed to the month, or uploaded here) and paid by a line of the month's bank or card
            statements (the zip's <b>Bank &amp; card statements</b>). Each is matched to a bill by
            its amount and date. A bill with no payment found holds the month; a bill missing either
            can be dropped, and its share comes off the line.{' '}
            <b>{many(d.receipts.length, 'receipt')}</b>,{' '}
            {many(d.receipts.length - unmatchedReceipts(d).length, 'matched', 'matched')}.
          </p>
          {unmatchedReceipts(d).length > 0 && (
            <details className="wex-why">
              <summary>
                <b>Not matched to a bill</b> · {many(unmatchedReceipts(d).length, 'receipt')}
              </summary>
              <ReceiptList receipts={unmatchedReceipts(d)} />
            </details>
          )}
        </Card>
      )}

      {groups.map((g) => (
        <Card key={g.id} title={g.name} aside={<b>{money(g.total)}</b>}>
          <LineTable lines={g.lines} withLine bills={bills} />
        </Card>
      ))}

      {notOn.length > 0 && (
        <Card title="On no engagement" eyebrow="Every books line is here or above">
          <div className="grid gap-2">
            {notOn.map((n) => (
              <details key={n.status} className="wex-why">
                <summary>
                  <b>{n.label}</b> · {many(n.lines.length, 'line')} · {money(n.total)}
                </summary>
                <LineTable lines={n.lines} bills={n.status === 'dropped' ? bills : null} />
              </details>
            ))}
          </div>
        </Card>
      )}

      {can && counts.remove > 0 && (
        <Card
          title="Saved lines Save will remove"
          eyebrow="The books no longer bill them this month"
        >
          <ul className="wex-removals">
            {(d.toRemove ?? []).map((r) => (
              <li key={r.id}>
                <span>
                  <b>{r.itemNumber}</b> · {r.vendor}
                </span>
                <span>
                  {money(r.amount)} · <Chip tone="warn">will be removed</Chip>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="wex-actions">
        {can && (d.file || counts.remove > 0) && (
          <Button kind="navy" disabled={!!busy || counts.pending === 0} onClick={() => void save()}>
            {saveLabel(counts)}
          </Button>
        )}
        <Button kind="secondary" disabled={!!busy} onClick={() => onDone(null)}>
          {can ? 'Leave for later' : 'Back'}
        </Button>
      </div>
    </div>
  )
}

/** What an owner may do to a bill: attach a receipt, choose one of the month's, drop it, or bring it back. */
interface BillActions {
  busy: boolean
  /** The month's receipts that prove no bill yet. */
  open: BooksReceiptDto[]
  attach: (transactionId: string, file: File) => void
  choose: (transactionId: string, documentId: string | null) => void
  drop: (transactionId: string, dropped: boolean) => void
  /** The statement line that paid it, or null to match it again. */
  pay: (transactionId: string, payment: BooksPaymentInput['payment']) => void
}

function ReceiptList({ receipts }: { receipts: BooksReceiptDto[] }) {
  return (
    <ul className="wex-bills">
      {receipts.map((r) => (
        <li key={r.documentId}>
          <span className="font-semibold">{r.fileName}</span>
          <span className="text-soft">
            {[r.date, r.vendor, r.amount == null ? 'no amount read' : money(r.amount)]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </li>
      ))}
    </ul>
  )
}

/** A line's bills, each with its receipt and its payment, or none and what an owner may do. */
function BillList({ bills, actions }: { bills: BooksBillDto[]; actions: BillActions | null }) {
  return (
    <ul className="wex-bills">
      {bills.map((b) => (
        <li key={b.transactionId}>
          <span>
            <span className="font-semibold">{b.vendor || 'No vendor'}</span>{' '}
            <span className="text-soft">
              {b.date} · {money(b.amount)} · bill {b.transactionId}
              {b.paidFrom === 'card' ? ' · card' : b.paidFrom === 'bank' ? ' · bank' : ''}
            </span>
          </span>
          {b.dropped ? (
            <span className="wex-bill-do">
              <Chip tone="muted">Dropped</Chip>
              {actions && (
                <Button
                  kind="ghost"
                  disabled={actions.busy}
                  onClick={() => actions.drop(b.transactionId, false)}
                >
                  Undo
                </Button>
              )}
            </span>
          ) : (
            <>
              <ReceiptOfBill b={b} actions={actions} />
              <PaymentOfBill b={b} actions={actions} />
              {actions && (!b.receipt || !b.payment) && (
                <span className="wex-bill-do">
                  <Button
                    kind="ghost"
                    disabled={actions.busy}
                    onClick={() => actions.drop(b.transactionId, true)}
                  >
                    Drop
                  </Button>
                </span>
              )}
            </>
          )}
        </li>
      ))}
    </ul>
  )
}

/** A bill's receipt, or none and the receipts it may be given. */
function ReceiptOfBill({ b, actions }: { b: BooksBillDto; actions: BillActions | null }) {
  if (b.receipt)
    return (
      <span className="wex-bill-do">
        <Chip tone="ok">{b.receipt.fileName}</Chip>
        {actions && b.receipt.by === 'person' && (
          <Button
            kind="ghost"
            disabled={actions.busy}
            onClick={() => actions.choose(b.transactionId, null)}
          >
            Match again
          </Button>
        )}
      </span>
    )
  return (
    <span className="wex-bill-do">
      <Chip tone="warn">No receipt</Chip>
      {actions && actions.open.length > 0 && (
        <select
          aria-label={`Receipt of bill ${b.transactionId}`}
          value=""
          disabled={actions.busy}
          onChange={(ev) => ev.target.value && actions.choose(b.transactionId, ev.target.value)}
        >
          <option value="">Choose a receipt…</option>
          {actions.open.map((r) => (
            <option key={r.documentId} value={r.documentId}>
              {r.fileName}
              {r.amount == null ? '' : ` (${money(r.amount)})`}
            </option>
          ))}
        </select>
      )}
      {actions && (
        <label className="wex-file wex-file-small">
          <input
            type="file"
            accept=".pdf,.png,.jpg,.jpeg"
            aria-label={`Attach the receipt of bill ${b.transactionId}`}
            disabled={actions.busy}
            onChange={(ev) => {
              const f = ev.target.files?.[0]
              if (f) actions.attach(b.transactionId, f)
              ev.target.value = ''
            }}
          />
          <span>Attach receipt</span>
        </label>
      )}
    </span>
  )
}

/** A bill's payment on the month's statements, or none and the statement lines that print its amount. */
function PaymentOfBill({ b, actions }: { b: BooksBillDto; actions: BillActions | null }) {
  if (b.payment)
    return (
      <span className="wex-bill-do">
        <Chip tone="ok">Paid</Chip>
        <span className="text-xs text-soft wex-bill-line">{statementLineWords(b.payment)}</span>
        {actions && b.payment.by === 'person' && (
          <Button
            kind="ghost"
            disabled={actions.busy}
            onClick={() => actions.pay(b.transactionId, null)}
          >
            Match again
          </Button>
        )}
      </span>
    )
  return (
    <span className="wex-bill-do">
      <Chip tone="danger">No payment found</Chip>
      {actions && b.paymentChoices.length > 0 && (
        <select
          aria-label={`Payment of bill ${b.transactionId}`}
          value=""
          disabled={actions.busy}
          onChange={(ev) => {
            const p = b.paymentChoices[Number(ev.target.value)]
            if (p)
              actions.pay(b.transactionId, {
                documentId: p.documentId,
                page: p.line.page,
                text: p.line.text,
              })
          }}
        >
          <option value="">Choose the statement line…</option>
          {b.paymentChoices.map((p, i) => (
            <option key={`${p.documentId}-${p.line.page}-${p.line.y}`} value={i}>
              {statementLineWords(p)}
            </option>
          ))}
        </select>
      )}
    </span>
  )
}

function LineTable({
  lines,
  withLine = false,
  bills = null,
}: {
  lines: BooksLineDto[]
  withLine?: boolean
  bills?: BillActions | null
}) {
  return (
    <div className="ad-tablewrap">
      <table className="ad-table wex-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Vendor</th>
            <th>Account</th>
            <th>{withLine ? 'Budget line' : 'Class'}</th>
            <th className="ad-num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => {
            const share = shareWords(l, money)
            const receipts = receiptWords(l)
            const payments = paymentWords(l)
            return (
              <tr key={l.key}>
                <td>{l.date}</td>
                <td>
                  <span className="font-semibold">{l.vendor}</span>
                  <span className="ad-table-sub">
                    {l.type} {l.transactionId}
                    {paidWords(l) ? ` · ${paidWords(l)}` : ''}
                  </span>
                </td>
                <td>{l.account.split(':').pop()}</td>
                <td>
                  {withLine ? l.budgetLineName : l.className || '—'}
                  {share && !l.split && <span className="ad-table-sub">{share}</span>}
                  {share && l.split && (
                    <details className="wex-split">
                      <summary className="ad-table-sub">{share}</summary>
                      <table className="wex-split-table">
                        <tbody>
                          {l.split.rows.map((r, i) => (
                            <tr key={i} className={r.mine ? 'wex-split-mine' : undefined}>
                              <td>{r.className}</td>
                              <td className="ad-num">{money(r.amount)}</td>
                            </tr>
                          ))}
                          <tr className="wex-split-total">
                            <td>Total</td>
                            <td className="ad-num">{money(l.split.total)}</td>
                          </tr>
                        </tbody>
                      </table>
                    </details>
                  )}
                  {l.status === 'already-entered' && <Chip tone="muted">Already on the month</Chip>}
                  {l.saved === 'same' && <Chip tone="ok">Saved</Chip>}
                  {l.saved === 'changed' && <Chip tone="warn">Changed since saved</Chip>}
                  {receipts && l.bills.length > 0 && (
                    <details className="wex-receipts">
                      <summary>
                        <Chip tone={receipts.complete ? 'ok' : 'warn'}>{receipts.words}</Chip>
                        {payments && (
                          <Chip tone={payments.complete ? 'ok' : 'danger'}>{payments.words}</Chip>
                        )}
                      </summary>
                      <BillList bills={l.bills} actions={bills} />
                    </details>
                  )}
                </td>
                <td className="ad-num">{money(l.amount)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
