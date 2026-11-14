import { Suspense, lazy, useEffect, useState, type ReactNode } from 'react'
import type {
  AccountMappingDto,
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
import { useApi, useLoad } from '@/hooks/useApi'
import { money, periodLabel, shortDate } from '@/lib/format'
import { Button, Card, Chip, Empty, ErrorNote, Modal, Notice } from '@/components/ui'
import { FoundProof, MatchPanel, RemainingSection } from '@/components/payroll-match/MatchParts'
import { VerificationModelLink } from '@/components/payroll-match/VerificationModel'
import '@/components/match-pairs.css'
import {
  billedLines,
  byBudgetLine,
  engagementGroups,
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
  'no-mapping': 'No account mapping for the engagement yet',
  'not-billable': 'Not billable: the account mapping leaves the account out',
  'no-budget-line': 'No budget line for the category',
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
  onSaved,
}: {
  workspaceId: string
  period: string
  /** The month end's steps, shown under the card's title as payroll's are. */
  stepper?: ReactNode
  /** Left for later (or Back, for an auditor): back to the month's page. */
  onDone: () => void
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
  const groups = engagementGroups(d.lines)
  const notOn = notOnEngagements(d.lines)
  const billed = billedLines(d.lines)
  const counts = saveCounts(d.lines, d.toRemove ?? [])
  const unread = unreadWords(d.unread ?? [])
  const proved = provedCount(d.lines)
  const remaining = billed.filter((l) => !lineProof(l).proved)
  const other = otherMonthLines(d.lines, period)
  const allSaved = nothingNew(d)
  const loose = unmatchedReceipts(d)

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
  // Bills with no receipt yet, of the lines billed: what a receipt matched to no bill may prove.
  const openBills = billed.flatMap((l) =>
    l.bills.filter((b) => !b.dropped && !b.receipt).map((b) => ({ line: l, bill: b }))
  )

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
          Transaction List with Splits in the zip&apos;s QuickBooks transactions folder, and upload
          again.
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
          ) : (
            can && <p className="ad-replacing">Expenses are not saved until you press Save.</p>
          )}

          {remaining.length > 0 && (
            <RemainingSection count={remaining.length}>
              <RemainingTable lines={remaining} />
            </RemainingSection>
          )}

          <section className="mx-work" aria-label="Expenses">
            <h3 className="mx-work-title">
              Expenses{' '}
              <span className="mx-tally">
                <span className="mx-tally-ok">✓ {many(billed.length, 'line')} from the books</span>
                {remaining.length > 0 && (
                  <span className="mx-tally-danger">{remaining.length} to prove</span>
                )}
              </span>
              <VerificationModelLink who="expenses" />
            </h3>
            {groups.length === 0 ? (
              <Empty>
                The books bill nothing to an engagement this month. How the books were read, below,
                says why for each line.
              </Empty>
            ) : (
              <ExpenseTable
                groups={groups}
                exportName={d.file.fileName}
                actions={actions}
                onShow={show}
              />
            )}
          </section>

          {d.receipts.length > 0 && (
            <section className="mx-work" aria-label="Receipts">
              <h3 className="mx-work-title">
                Receipts{' '}
                <span className="mx-tally">
                  <span className="mx-tally-ok">
                    ✓ {(d.receipts.length - loose.length).toLocaleString('en-US')} matched
                  </span>
                  {loose.length > 0 && (
                    <span className="mx-tally-warn">{loose.length} not matched to a bill</span>
                  )}
                </span>
                {can && (
                  <label className="wex-file wex-file-head">
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
                )}
              </h3>
              {loose.length === 0 ? (
                <p className="text-sm text-soft">Every receipt of the month proves a bill.</p>
              ) : (
                <LooseReceipts
                  receipts={loose}
                  openBills={openBills}
                  actions={actions}
                  onShow={show}
                />
              )}
            </section>
          )}
          {d.receipts.length === 0 && can && (
            <section className="mx-work" aria-label="Receipts">
              <h3 className="mx-work-title">
                Receipts
                <label className="wex-file wex-file-head">
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
              </h3>
              <p className="text-sm text-soft">
                No receipts for the month yet. Put them in the zip&apos;s Receipts folder, email
                them to the month, or upload them here.
              </p>
            </section>
          )}
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
        sub="Why each line of the books was billed, or why not, and the account mapping used."
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
          <Mappings d={d} can={can} busy={!!busy} onChange={changeMapping} />
        </div>
      </MatchPanel>

      {can && d.file && !allSaved && (
        <div className="grid gap-1">
          <h3 className="font-bold">What Save will do</h3>
          <ul className="wex-save-list">
            {groups.map((g) => {
              const lines = byBudgetLine(g.lines.filter((l) => l.status === 'billed'))
              return (
                <li key={g.id}>
                  <b>{g.name}:</b>{' '}
                  {many(g.lines.filter((l) => l.status === 'billed').length, 'expense')},{' '}
                  {money(g.total)}
                  {lines.length > 0 &&
                    ` (${lines.map((b) => `${b.name} ${money(b.total)}`).join(', ')})`}
                  .
                </li>
              )
            })}
            <li>
              <b>Changes:</b> {many(counts.add, 'new line')}, {many(counts.change, 'change')},{' '}
              {many(counts.remove, 'removal')}.
            </li>
            <li>
              <b>Proof attached:</b>{' '}
              {many(
                billed.reduce((t, l) => t + lineProof(l).receipts.have, 0),
                'receipt'
              )}
              ,{' '}
              {many(
                billed.reduce((t, l) => t + lineProof(l).payments.have, 0),
                'payment'
              )}
              , {many(billed.filter((l) => l.split).length, 'allocation note')}.
            </li>
            <li>
              <b>Dropped bills:</b>{' '}
              {billed.reduce((t, l) => t + l.bills.filter((b) => b.dropped).length, 0) || 'none'}.
            </li>
          </ul>
        </div>
      )}

      <div className="ad-actions justify-between">
        <Button kind="ghost" disabled={!!busy} onClick={onDone}>
          {can ? 'Leave for later' : 'Back'}
        </Button>
        {can && allSaved && (
          <Button kind="primary" onClick={() => onSaved(d, null)}>
            Continue to summary
          </Button>
        )}
        {can && !allSaved && (d.file || counts.remove > 0) && (
          <Button
            kind="primary"
            disabled={!!busy || counts.pending === 0}
            onClick={() => void save()}
          >
            Save and continue
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

const onFile = (
  <Chip tone="ok" fill>
    ✓ on file
  </Chip>
)
const missing = (words: string) => <small className="ad-match-note-missing">✕ {words}</small>

/** "Remaining to match": each expense still short of a proof, as payroll's table is. */
function RemainingTable({ lines }: { lines: BooksLineDto[] }) {
  return (
    <div className="ad-tablewrap">
      <table className="ad-table">
        <thead>
          <tr>
            <th>Engagement</th>
            <th>Paid to</th>
            <th>Date</th>
            <th className="ad-num">Amount</th>
            <th>Receipt</th>
            <th>Allocation</th>
            <th>Evidence of payment</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => {
            const p = lineProof(l)
            const short = (x: { have: number; of: number }, none: string, some: string) =>
              x.of === 1 ? missing(none) : missing(`${x.of - x.have} of ${x.of} bills ${some}`)
            return (
              <tr key={l.key}>
                <td>
                  <span className="font-semibold">{l.engagementName}</span>
                  <span className="ad-table-sub">{l.budgetLineName}</span>
                </td>
                <td>
                  <span className="font-semibold">{l.vendor || 'No vendor'}</span>
                  <span className="ad-table-sub">{accountName(l.account)}</span>
                </td>
                <td className="whitespace-nowrap">{shortDate(l.date)}</td>
                <td className="ad-num font-semibold">{money(l.amount)}</td>
                <td className="ad-matchcell">
                  {p.receipts.of === 0
                    ? missing('Every bill dropped')
                    : p.receipts.have === p.receipts.of
                      ? onFile
                      : short(p.receipts, 'No receipt found', 'have no receipt')}
                </td>
                <td className="ad-matchcell">
                  {p.allocation === 'on-file' ? (
                    onFile
                  ) : p.allocation === 'none' ? (
                    <Chip tone="muted">Not shared</Chip>
                  ) : (
                    missing('No split in the books')
                  )}
                </td>
                <td className="ad-matchcell">
                  {p.payments.of > 0 && p.payments.have === p.payments.of
                    ? onFile
                    : short(p.payments, 'No payment found', 'have no payment found')}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** The account's own name, not its path in the books: "60203 Workers Comp". */
const accountName = (a: string) => a.split(':').pop()!.trim()

/**
 * Every expense on an engagement, grouped by engagement and budget line with their totals, as payroll's Staff table:
 * each bill's receipt, the books' split and each bill's bank or card line, found or not.
 */
function ExpenseTable({
  groups,
  exportName,
  actions,
  onShow,
}: {
  groups: ReturnType<typeof engagementGroups>
  exportName: string
  actions: BillActions | null
  onShow: (v: Viewing) => void
}) {
  return (
    <div className="ad-tablewrap">
      <table className="ad-table wex-table">
        <thead>
          <tr>
            <th>Expense</th>
            <th>Receipt</th>
            <th>Allocation</th>
            <th>Bank or card line</th>
            <th className="ad-num">Amount</th>
          </tr>
        </thead>
        {groups.map((g) =>
          byBudgetLine(g.lines).map((b) => (
            <tbody key={`${g.id}-${b.name}`}>
              <tr className="wex-group">
                <td colSpan={4}>
                  <span className="wex-group-eng">{g.name}</span> · {b.name}
                </td>
                <td className="ad-num">{money(b.total)}</td>
              </tr>
              {b.lines.map((l) => (
                <tr key={l.key}>
                  <td>
                    <span className="font-semibold">{l.vendor || 'No vendor'}</span>
                    <span className="ad-table-sub">{accountName(l.account)}</span>
                    <span className="ad-table-sub">
                      {shortDate(l.date)} · {l.type} {l.transactionId}
                    </span>
                    {l.status === 'already-entered' && (
                      <Chip tone="muted">Already on the month</Chip>
                    )}
                    {l.saved === 'same' && <Chip tone="ok">Saved</Chip>}
                    {l.saved === 'changed' && <Chip tone="warn">Changed since saved</Chip>}
                  </td>
                  <td className="ad-matchcell">
                    <BillStack
                      bills={l.bills}
                      render={(bill) => (
                        <ReceiptOfBill b={bill} actions={actions} onShow={onShow} />
                      )}
                      actions={actions}
                    />
                  </td>
                  <td className="ad-matchcell">
                    <AllocationCell l={l} exportName={exportName} />
                  </td>
                  <td className="ad-matchcell">
                    <BillStack
                      bills={l.bills.filter((x) => !x.dropped)}
                      render={(bill) => (
                        <PaymentOfBill b={bill} actions={actions} onShow={onShow} />
                      )}
                    />
                  </td>
                  <td className="ad-num">
                    <span className="font-semibold">{money(l.amount)}</span>
                    {l.allocation && (
                      <span className="ad-table-sub">of {money(l.allocation.total)}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          ))
        )}
      </table>
    </div>
  )
}

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
}: {
  b: BooksBillDto
  actions: BillActions | null
  onShow: (v: Viewing) => void
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
      {missing('Missing')}
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
}: {
  b: BooksBillDto
  actions: BillActions | null
  onShow: (v: Viewing) => void
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
      {missing('No payment found')}
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

/** The books' split of a shared cost: this program's dollars of the whole, and every program's on Show. */
function AllocationCell({ l, exportName }: { l: BooksLineDto; exportName: string }) {
  if (!l.allocation) return <small className="text-soft">Not shared: the whole bill</small>
  if (!l.split) return missing('No split in the books')
  const s = l.split
  const mine = s.rows.filter((r) => r.mine)
  const booked = mine.reduce((t, r) => t + r.amount, 0)
  return (
    <div className="wex-bill">
      <span className="wex-bill-head">
        {s.how === 'entry' ? `Allocation entry ${s.transactionId}` : `Split of ${s.transactionId}`}:
      </span>
      <span className="mx-proof-file" title={exportName}>
        {exportName}
      </span>
      <details className="wex-split">
        <summary>
          <small className="ad-match-note-ok">
            ✓ {money(booked)} of {money(s.total)}
          </small>{' '}
          <span className="ad-match-show">Show</span>
        </summary>
        <table className="wex-split-table">
          <tbody>
            {s.rows.map((r, i) => (
              <tr key={i} className={r.mine ? 'wex-split-mine' : undefined}>
                <td>{r.className}</td>
                <td className="ad-num">{money(r.amount)}</td>
              </tr>
            ))}
            <tr className="wex-split-total">
              <td>Total</td>
              <td className="ad-num">{money(s.total)}</td>
            </tr>
          </tbody>
        </table>
      </details>
    </div>
  )
}

/** The month's receipts that prove no bill: each with Show, and the bill it may prove. */
function LooseReceipts({
  receipts,
  openBills,
  actions,
  onShow,
}: {
  receipts: BooksReceiptDto[]
  openBills: { line: BooksLineDto; bill: BooksBillDto }[]
  actions: BillActions | null
  onShow: (v: Viewing) => void
}) {
  return (
    <div className="ad-tablewrap">
      <table className="ad-table">
        <thead>
          <tr>
            <th>Receipt</th>
            <th>Vendor</th>
            <th>Date</th>
            <th className="ad-num">Amount</th>
            <th>Bill it proves</th>
          </tr>
        </thead>
        <tbody>
          {receipts.map((r) => (
            <tr key={r.documentId}>
              <td className="ad-matchcell">
                <FoundProof
                  fileName={r.fileName}
                  state="missing"
                  text="✕ Matched to no bill"
                  onShow={() =>
                    onShow({ kind: 'receipt', documentId: r.documentId, fileName: r.fileName })
                  }
                />
              </td>
              <td>{r.vendor ?? '—'}</td>
              <td className="whitespace-nowrap">{r.date ? shortDate(r.date) : '—'}</td>
              <td className="ad-num">{r.amount == null ? 'Not read' : money(r.amount)}</td>
              <td>
                {actions && openBills.length > 0 ? (
                  <select
                    aria-label={`Bill that ${r.fileName} proves`}
                    value=""
                    disabled={actions.busy}
                    onChange={(ev) =>
                      ev.target.value && actions.choose(ev.target.value, r.documentId)
                    }
                  >
                    <option value="">Choose its bill…</option>
                    {openBills.map(({ line, bill }) => (
                      <option key={bill.transactionId} value={bill.transactionId}>
                        {bill.vendor || line.vendor} · {money(bill.amount)} · {shortDate(bill.date)}{' '}
                        (bill {bill.transactionId})
                      </option>
                    ))}
                  </select>
                ) : (
                  <small className="text-soft">
                    No bill in the books billed this month has this amount and date.
                  </small>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Each engagement's account mapping: its categories and the budget line each bills to. */
function Mappings({
  d,
  can,
  busy,
  onChange,
}: {
  d: WorkspaceExpensesDto
  can: boolean
  busy: boolean
  onChange: (m: AccountMappingDto, body: Record<string, unknown>) => Promise<void>
}) {
  if (d.mappings.length === 0)
    return (
      <p className="text-sm text-soft">
        No account mapping yet. Put each engagement&apos;s chart of accounts mapping (account number
        and the category it bills to) in the zip&apos;s <b>Account mapping</b> folder.
      </p>
    )
  return (
    <div className="grid gap-3">
      <h4 className="font-bold">Account mapping</h4>
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
                  disabled={busy}
                  onChange={(ev) => void onChange(m, { engagementId: ev.target.value })}
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
                              disabled={busy}
                              onChange={(ev) =>
                                void onChange(m, {
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
                            (c.budgetLineName ?? (c.budgetLineId === SKIP ? 'Not billed' : 'None'))
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
