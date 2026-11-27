import { StaffReview } from '@/components/payroll-match/StaffReview'
import { Suspense, lazy, useEffect, useState, type ReactNode } from 'react'
import type {
  BooksBillDto,
  BooksBillInput,
  BooksLineDto,
  BooksLineStatus,
  BooksPaymentDto,
  BooksPaymentInput,
  BooksReceiptDto,
  WorkspaceExpensesDto,
  WorkspaceExpensesSavedDto,
} from '@ad/types'
import { accountLeaf, aliasKey, suggestAliases, zipFolder } from '@ad/types'
import { useApi, useLoad } from '@/hooks/useApi'
import { money, periodLabel, shortDate } from '@/lib/format'
import { Button, Card, Chip, Empty, ErrorNote, Modal, Notice } from '@/components/ui'
import { FoundProof, MatchPanel } from '@/components/payroll-match/MatchParts'
import '@/components/match-pairs.css'
import {
  billedLines,
  lineProof,
  nothingNew,
  notOnEngagements,
  otherMonthLines,
  provedCount,
  saveCounts,
  statementLineWords,
  unmatchedReceipts,
  unreadWords,
} from './workspace-expenses'
import { RECEIPT_MAX_BYTES, mb } from '@/components/PayrollProof'
import './workspace-expenses.css'

const StatementViewer = lazy(() =>
  import('@/components/StatementViewer').then((m) => ({ default: m.StatementViewer }))
)

const many = (n: number, one: string, more = `${one}s`) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : more}`
const SKIP = 'skip'
/** A bill list longer than this shows its first few, and the rest on "Show N more bills". */
const BILLS_SHOWN = 3

/**
 * Why a books line is billed to no engagement, in plain words (owner's decision, 2026-11-13: the reasons read as the
 * person would say them). The types' labels stay as the API and its tests have them.
 */
const PLAIN_REASON: Partial<Record<BooksLineStatus, string>> = {
  'allocation-pool': 'Allocation entries: their shares are the lines billed',
  'not-ours': 'Other programs: their class has no engagement here',
  unmapped: 'Not on the QuickBooks names list yet',
  unallowable: 'Unallowable: no proof, in no total',
  'no-budget-line': "The list's budget line is not on the engagement",
  'payroll-account': 'Payroll: done in Payroll matching',
  credit: 'Refunds and credits: never billed',
  'outside-contract': "Outside the engagement's contract dates",
  'month-closed': 'On a month no longer a draft',
  dropped: 'Every bill dropped for want of its proof',
}

/** What to open over the screen: a receipt, or the statement line that paid a bill. */
type Viewing =
  | { kind: 'receipt'; documentId: string; fileName: string }
  | { kind: 'payment'; payment: BooksPaymentDto }

/**
 * Step 3 of the workspace's month end, Expense matching (owner's decisions, 2026-11-09 and 2026-11-13): the month's
 * expenses from the books, laid out as payroll's Match step is. What is left to prove first, then every expense with
 * each bill's receipt, the books' split and its bank or card line ("✓ Found, page N" and Show), the receipts matched to
 * no bill, how the books were read, and what Save will do. Owners save; auditors read.
 */
export function WorkspaceExpenses({
  workspaceId,
  period,
  stepper,
  onDone,
  onBack,
  nextLabel = 'Next: save and finish →',
  backLabel = 'Back: find missing bank lines',
  onSaved,
}: {
  workspaceId: string
  period: string
  /** The month end's steps, shown under the card's title as payroll's are. */
  stepper?: ReactNode
  /** Left for later (or Back, for an auditor): back to the month's page. */
  onDone: () => void
  /** Back to the step before, beside Cancel. */
  onBack: () => void
  backLabel?: string
  nextLabel?: string
  /** Saved, or nothing new to save: on to the Summary, with the month's expenses as they are now. */
  onSaved: (expenses: WorkspaceExpensesDto, note: string | null) => void
}) {
  const api = useApi()
  const load = useLoad<WorkspaceExpensesDto>(`/workspaces/${workspaceId}/expenses/${period}`)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [viewing, setViewing] = useState<Viewing | null>(null)
  const d = load.data?.period === period ? load.data : null
  const title = `Match expenses & receipts: ${periodLabel(period)}`
  if (load.error)
    return (
      <Card title={title}>
        {stepper}
        <ErrorNote message={load.error} />
      </Card>
    )
  if (!d)
    return (
      <Card title={title}>
        {stepper}
        <Empty>Reading the books…</Empty>
      </Card>
    )
  const can = d.can.change
  const notOn = notOnEngagements(d.lines)
  const billed = billedLines(d.lines)
  const counts = saveCounts(d.lines, d.toRemove ?? [])
  const unread = unreadWords(d.unread ?? [])
  const proved = provedCount(d.lines)
  const remaining = billed.filter((l) => !lineProof(l).proved)
  const other = otherMonthLines(d.lines, period)
  const allSaved = nothingNew(d)
  const loose = unmatchedReceipts(d)

  const chooseLine = async (body: Record<string, unknown>) => {
    setError(null)
    setBusy('Saving to the QuickBooks names list…')
    try {
      await api.post(`/workspaces/${workspaceId}/line-aliases/choose`, body)
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
  const actions: BillActions | null = can
    ? {
        busy: !!busy,
        open: loose,
        attach: (transactionId, file) => void addReceipts([file], transactionId),
        choose: (transactionId, documentId) =>
          void setBill({ transactionId, documentId, dropped: false }),
        drop: (transactionId, dropped) =>
          void setBill({ transactionId, documentId: null, dropped }),
        pay: (transactionId, payment) => void setPayment({ transactionId, payment }),
      }
    : null
  const show = setViewing
  const save = async () => {
    setError(null)
    setBusy('Saving the expenses…')
    try {
      const r = await api.post<WorkspaceExpensesSavedDto>(
        `/workspaces/${workspaceId}/expenses/${period}/save`
      )
      load.setData(r.expenses)
      onSaved(
        r.expenses,
        `Saved the expenses for ${periodLabel(period)}: ${many(r.created, 'line')} added, ${many(r.updated, 'line')} changed, ${many(r.removed, 'line')} removed.`
      )
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card
      title={title}
      aside={
        billed.length ? (
          <span className="text-xs text-soft">
            {proved.proved} of {many(proved.total, 'expense')} fully proved
          </span>
        ) : undefined
      }
    >
      {stepper}
      {unread && <Notice tone="warn">{unread}</Notice>}
      {error && <ErrorNote message={error} />}
      {busy && <Notice tone="info">{busy}</Notice>}

      {!d.file ? (
        <Empty>
          The month&apos;s files have no books export with expenses. Put the month&apos;s QuickBooks
          Transaction List with Splits in the zip&apos;s{' '}
          {zipFolder('payroll-proof', 'payroll-details').name} folder, and upload again.
        </Empty>
      ) : (
        <>
          {other.lines.length > 0 && (
            <Notice tone="warn">
              <b>
                {many(other.lines.length, 'expense')} {other.lines.length === 1 ? 'is' : 'are'}{' '}
                dated {other.months.map((m) => periodLabel(m)).join(' and ')}, not{' '}
                {periodLabel(period)}.
              </b>{' '}
              Each expense is saved on the month of its own date, so Save puts{' '}
              {other.lines.length === 1 ? 'it' : 'them'} there. If these files are another
              month&apos;s, choose that month above and upload them there.
            </Notice>
          )}
          {allSaved ? (
            <div className="wex-allset" role="status">
              <span className="wex-allset-check" aria-hidden="true">
                ✓
              </span>
              <div>
                <b>Nothing new to save.</b> All {many(counts.same, 'expense')} from{' '}
                {d.file.fileName} {counts.same === 1 ? 'is' : 'are'} already saved
                {remaining.length
                  ? `. ${many(remaining.length, 'expense')} still ${remaining.length === 1 ? 'needs' : 'need'} proof: below.`
                  : ', each fully proved.'}
              </div>
            </div>
          ) : null}

          {/* Review expenses (owner's ask, 2026-11-15): the same grid as the payroll steps. */}
          <StaffReview
            rows={billed.map((l) => {
              const p = lineProof(l)
              const live = l.bills.filter((b) => !b.dropped)
              const part = (
                x: { have: number; of: number },
                label: string,
                none: string,
                fix: ReactNode
              ) =>
                x.of > 0 && x.have === x.of
                  ? { label, state: 'ok' as const }
                  : {
                      label,
                      state: 'missing' as const,
                      fix: actions ? fix : undefined,
                      problem:
                        x.of === 0
                          ? 'every bill on this line was dropped'
                          : x.of === 1
                            ? none
                            : `${x.of - x.have} of ${x.of} bills have none`,
                    }
              return {
                key: l.key,
                engagementId: l.engagementId ?? '',
                engagementName: l.engagementName ?? 'No engagement',
                reportId: '',
                title: l.vendor || 'No vendor',
                sub: `${accountName(l.account)}${l.budgetLineName ? ` · ${l.budgetLineName}` : ''}`,
                date: shortDate(l.date),
                amount: l.amount,
                slots: [
                  part(
                    p.receipts,
                    'Receipt',
                    'no receipt found for this bill',
                    <BillStack
                      bills={l.bills.filter((b) => b.dropped || !b.receipt)}
                      render={(b) => <ReceiptOfBill b={b} actions={actions} onShow={show} quiet />}
                      actions={actions}
                    />
                  ),
                  ...(p.allocation === 'none'
                    ? []
                    : [
                        p.allocation === 'on-file'
                          ? { label: 'Allocation', state: 'ok' as const }
                          : {
                              label: 'Allocation',
                              state: 'missing' as const,
                              problem: 'the books show no split for this shared cost',
                            },
                      ]),
                  part(
                    p.payments,
                    'Evidence of payment',
                    'no bank or card line found for it',
                    <BillStack
                      bills={live.filter((b) => !b.payment)}
                      render={(b) => <PaymentOfBill b={b} actions={actions} onShow={show} quiet />}
                    />
                  ),
                ],
              }
            })}
          />
        </>
      )}

      {can && counts.remove > 0 && (
        <section className="mx-work" aria-label="Saved lines Save will remove">
          <h3 className="mx-work-title">
            Saved lines Save will remove{' '}
            <span className="mx-tally">
              <span className="mx-tally-warn">The books no longer bill them this month</span>
            </span>
          </h3>
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
        </section>
      )}

      <MatchPanel
        label="How the books were read"
        title="How the books were read"
        sub="Why each line of the books was billed, or why not, and the QuickBooks names not mapped yet."
      >
        <div className="grid gap-4 pt-3">
          {d.file && (
            <div className="grid gap-2">
              <p className="text-sm">
                {many(d.lines.length, 'line')} of {d.file.fileName} on an expense account that is no
                one&apos;s pay: <b>{billed.length} billed</b>, the rest not, each for its reason.
              </p>
              {notOn.map((n) => (
                <details key={n.status} className="wex-why">
                  <summary>
                    <b>{PLAIN_REASON[n.status] ?? n.label}</b> · {many(n.lines.length, 'line')}
                  </summary>
                  <LineTable lines={n.lines} />
                </details>
              ))}
            </div>
          )}
          <UnmappedNames d={d} can={can} busy={!!busy} onChoose={chooseLine} />
        </div>
      </MatchPanel>

      <div className="ad-actions justify-between">
        <span className="flex items-center gap-3">
          <Button kind="ghost" disabled={!!busy} onClick={onBack}>
            {backLabel}
          </Button>
          <Button kind="ghost" disabled={!!busy} onClick={onDone}>
            Cancel
          </Button>
        </span>
        {can && allSaved && (
          <Button kind="navy" onClick={() => onSaved(d, null)}>
            {nextLabel}
          </Button>
        )}
        {can && !allSaved && (d.file || counts.remove > 0) && (
          <Button kind="navy" disabled={!!busy || counts.pending === 0} onClick={() => void save()}>
            {nextLabel}
          </Button>
        )}
      </div>

      {viewing && (
        <Modal
          title={
            viewing.kind === 'receipt'
              ? viewing.fileName
              : `${viewing.payment.fileName}, page ${viewing.payment.line.page}`
          }
          onClose={() => setViewing(null)}
          wide
        >
          {viewing.kind === 'receipt' ? (
            <ReceiptView
              src={`${receiptsUrl}/${viewing.documentId}/file`}
              documentId={viewing.documentId}
              fileName={viewing.fileName}
            />
          ) : (
            <Suspense fallback={<p className="text-sm text-soft">Opening the statement…</p>}>
              <StatementViewer
                doc={{
                  id: viewing.payment.documentId,
                  sensitivity: 'financial',
                  kind: 'bank-statement',
                }}
                src={`/workspaces/${workspaceId}/payroll/${period}/files/${viewing.payment.documentId}/file`}
                mark={viewing.payment.line}
                downloadName={viewing.payment.fileName}
              />
            </Suspense>
          )}
        </Modal>
      )}
    </Card>
  )
}

/** A receipt as uploaded: a PDF drawn as the statements are, a photo as itself. */
function ReceiptView({
  src,
  documentId,
  fileName,
}: {
  src: string
  documentId: string
  fileName: string
}) {
  const api = useApi()
  const pdf = /\.pdf$/i.test(fileName)
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (pdf) return
    let gone = false
    let made: string | null = null
    api
      .bytes(src)
      .then((bytes) => {
        if (gone) return
        made = URL.createObjectURL(new Blob([bytes]))
        setUrl(made)
      })
      .catch((e: Error) => !gone && setError(e.message))
    return () => {
      gone = true
      if (made) URL.revokeObjectURL(made)
    }
    // The API client changes identity with the session; reading again would log another open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, pdf])
  if (pdf)
    return (
      <Suspense fallback={<p className="text-sm text-soft">Opening the receipt…</p>}>
        <StatementViewer
          doc={{ id: documentId, sensitivity: 'financial', kind: 'receipt' }}
          src={src}
          downloadName={fileName}
        />
      </Suspense>
    )
  if (error) return <ErrorNote message={error} />
  if (!url) return <p className="text-sm text-soft">Opening the receipt…</p>
  return <img src={url} alt={`Receipt ${fileName}`} className="wex-receipt-img" />
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

const missing = (words: string) => <small className="ad-match-note-missing">✕ {words}</small>

/** The account's own name, not its path in the books: "60203 Workers Comp". */
const accountName = (a: string) => a.split(':').pop()!.trim()

/** A line's bills one under another, as a person's pay runs are on payroll's grid: the first few, then the rest. */
function BillStack({
  bills,
  render,
  actions,
}: {
  bills: BooksBillDto[]
  render: (b: BooksBillDto) => ReactNode
  /** With actions, a dropped bill shows Undo. */
  actions?: BillActions | null
}) {
  const [all, setAll] = useState(false)
  if (!bills.length) return missing('No bills')
  const shown = all ? bills : bills.slice(0, BILLS_SHOWN)
  return (
    <div className="wex-stack">
      {shown.map((b) => (
        <div key={b.transactionId} className="wex-bill">
          <span className="wex-bill-head">
            Bill {b.transactionId}
            {bills.length > 1 ? ` · ${money(b.amount)}` : ''}:
          </span>
          {b.dropped ? (
            <span className="ad-match-foot">
              <small className="text-soft">Dropped: its share is off the line</small>
              {actions && (
                <button
                  type="button"
                  className="ad-match-show"
                  disabled={actions.busy}
                  onClick={() => actions.drop(b.transactionId, false)}
                >
                  Undo
                </button>
              )}
            </span>
          ) : (
            render(b)
          )}
        </div>
      ))}
      {bills.length > BILLS_SHOWN && (
        <button type="button" className="wex-more" onClick={() => setAll((x) => !x)}>
          {all ? 'Show fewer' : `Show ${bills.length - BILLS_SHOWN} more bills`}
        </button>
      )}
    </div>
  )
}

/** A bill's receipt: found (Show), or missing and what an owner may do. */
function ReceiptOfBill({
  b,
  actions,
  onShow,
  quiet,
}: {
  b: BooksBillDto
  actions: BillActions | null
  onShow: (v: Viewing) => void
  /** In the stepper's grid, which already says it is missing: the controls alone. */
  quiet?: boolean
}) {
  if (b.receipt) {
    const r = b.receipt
    return (
      <>
        <FoundProof
          fileName={r.fileName}
          state="ok"
          text={r.by === 'person' ? '✓ Chosen' : '✓ Found'}
          onShow={() => onShow({ kind: 'receipt', documentId: r.documentId, fileName: r.fileName })}
        />
        {actions && r.by === 'person' && (
          <button
            type="button"
            className="wex-act"
            disabled={actions.busy}
            onClick={() => actions.choose(b.transactionId, null)}
          >
            Match again
          </button>
        )}
      </>
    )
  }
  return (
    <>
      {!quiet && missing('Missing')}
      {actions && (
        <span className="wex-acts">
          {actions.open.length > 0 && (
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
            <span>Upload</span>
          </label>
          <button
            type="button"
            className="wex-act wex-act-drop"
            disabled={actions.busy}
            onClick={() => actions.drop(b.transactionId, true)}
          >
            Drop bill
          </button>
        </span>
      )}
    </>
  )
}

/** A bill's payment on the month's statements: found (Show, with the line highlighted), or none and the lines to choose. */
function PaymentOfBill({
  b,
  actions,
  onShow,
  quiet,
}: {
  b: BooksBillDto
  actions: BillActions | null
  onShow: (v: Viewing) => void
  /** In the stepper's grid, which already says it is missing: the controls alone. */
  quiet?: boolean
}) {
  if (b.payment) {
    const p = b.payment
    return (
      <>
        <FoundProof
          fileName={p.fileName}
          state="ok"
          text={`✓ ${p.by === 'person' ? 'Chosen' : 'Found'}, page ${p.line.page}`}
          onShow={() => onShow({ kind: 'payment', payment: p })}
        />
        {actions && p.by === 'person' && (
          <button
            type="button"
            className="wex-act"
            disabled={actions.busy}
            onClick={() => actions.pay(b.transactionId, null)}
          >
            Match again
          </button>
        )}
      </>
    )
  }
  return (
    <>
      {!quiet && missing('No payment found')}
      {actions && (
        <span className="wex-acts">
          {b.paymentChoices.length > 0 && (
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
          {!b.receipt && (
            <button
              type="button"
              className="wex-act wex-act-drop"
              disabled={actions.busy}
              onClick={() => actions.drop(b.transactionId, true)}
            >
              Drop bill
            </button>
          )}
        </span>
      )}
    </>
  )
}

/**
 * The books' accounts no budget line takes yet, on each engagement (owner's decisions, 2026-11-27, #132): each asks
 * where it goes, offering first the names on the QuickBooks names list it may be the same as (an account renamed in
 * QuickBooks), then the engagement's budget lines, then Unallowable. The choice is kept on the list.
 */
function UnmappedNames({
  d,
  can,
  busy,
  onChoose,
}: {
  d: WorkspaceExpensesDto
  can: boolean
  busy: boolean
  onChoose: (body: Record<string, unknown>) => Promise<void>
}) {
  // Every account of this month's books, wherever its line went: a listed name not among them may have been renamed.
  const inFile = new Set(d.lines.map((l) => accountLeaf(l.account)).filter(Boolean))
  const asks = new Map<
    string,
    { name: string; engagementId: string; engagementName: string; lines: number }
  >()
  for (const l of d.lines) {
    if (
      (l.status !== 'unmapped' && l.status !== 'no-budget-line') ||
      !l.engagementId ||
      !l.category
    )
      continue
    const k = `${l.engagementId}|${aliasKey(l.category)}`
    const at = asks.get(k)
    if (at) at.lines++
    else
      asks.set(k, {
        name: l.category,
        engagementId: l.engagementId,
        engagementName: l.engagementName ?? '',
        lines: 1,
      })
  }
  if (asks.size === 0)
    return (
      <p className="text-sm text-soft">
        Every account in the books goes to a budget line or is Unallowable, by the QuickBooks names
        list on the workspace page.
      </p>
    )
  return (
    <div className="grid gap-2">
      <h4 className="font-bold">QuickBooks names not mapped yet</h4>
      <div className="ad-tablewrap">
        <table className="ad-table">
          <thead>
            <tr>
              <th>QuickBooks name</th>
              <th>Engagement</th>
              <th className="ad-num">Lines</th>
              <th>Goes to</th>
            </tr>
          </thead>
          <tbody>
            {[...asks.values()].map((a) => {
              const lines = d.engagements.find((e) => e.id === a.engagementId)?.budgetLines ?? []
              const has = (n: string) => lines.some((b) => aliasKey(b.name) === aliasKey(n))
              const same = suggestAliases(a.name, d.aliases, inFile, a.engagementId).filter(
                (s) => s.unallowable || has(s.budgetLineName ?? '')
              )
              return (
                <tr key={`${a.engagementId}|${a.name}`}>
                  <td>{a.name}</td>
                  <td>{a.engagementName}</td>
                  <td className="ad-num">{a.lines}</td>
                  <td>
                    {can ? (
                      <select
                        aria-label={`Where ${a.name} goes`}
                        value=""
                        disabled={busy}
                        onChange={(ev) => {
                          const v = ev.target.value
                          if (!v) return
                          const unallowable = v === SKIP
                          void onChoose({
                            name: a.name,
                            engagementId: a.engagementId,
                            unallowable,
                            budgetLineName: unallowable ? null : v,
                          })
                        }}
                      >
                        <option value="">Choose where it goes…</option>
                        {same.length > 0 && (
                          <optgroup label="Is it the same as one of these?">
                            {same.map((s) => (
                              <option key={s.name} value={s.unallowable ? SKIP : s.budgetLineName!}>
                                {s.name} → {s.unallowable ? 'Unallowable' : s.budgetLineName}
                              </option>
                            ))}
                          </optgroup>
                        )}
                        <optgroup label="A budget line">
                          {lines.map((b) => (
                            <option key={b.id} value={b.name}>
                              {b.name}
                            </option>
                          ))}
                        </optgroup>
                        <option value={SKIP}>Unallowable (no proof, in no total)</option>
                      </select>
                    ) : (
                      'Not mapped'
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** The lines of one reason, read-only: when, who, the account and the class the books gave it. */
function LineTable({ lines }: { lines: BooksLineDto[] }) {
  return (
    <div className="ad-tablewrap">
      <table className="ad-table wex-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Vendor</th>
            <th>Account</th>
            <th>Class</th>
            <th className="ad-num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.key}>
              <td className="whitespace-nowrap">{shortDate(l.date)}</td>
              <td>
                <span className="font-semibold">{l.vendor || 'No vendor'}</span>
                <span className="ad-table-sub">
                  {l.type} {l.transactionId}
                </span>
              </td>
              <td>{accountName(l.account)}</td>
              <td>{l.className || '—'}</td>
              <td className="ad-num">{money(l.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
