import { useEffect, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import {
  DOCUMENT_PURPOSE_LABELS,
  ALLOCATION_TYPE_LABELS,
  ALLOCATION_TYPES,
  PAYROLL_REPORT_LINES,
  REPORT_LINES,
  REPORT_LINE_LABELS,
  type CheckDto,
  type DocumentKind,
  type DocumentPurpose,
  type ExpenseDto,
  type ExpenseInput,
  type LineRow,
  type ParticipantDto,
  type WexPaymentInput,
  type ClosingInput,
  type ReportDetail,
  type TagType,
  type WexPaymentDto,
} from '@ad/types'
import { useApi, useLoad } from '@/hooks/useApi'
import { ApiError } from '@/services/api'
import { money, periodLabel, shortDate } from '@/lib/format'
import {
  Button,
  Card,
  Chip,
  Empty,
  ErrorNote,
  Field,
  Modal,
  Notice,
  StatusChip,
  Tile,
  inputClass,
  severityTone,
} from '@/components/ui'
import { DocumentLink } from '@/components/DocumentLink'
import { AttachModal } from '@/components/AttachModal'
import { TagChips, TagFilter, TagPicker, TagsModal } from '@/components/Tags'
import { ImportTransactionsModal } from '@/components/ImportTransactionsModal'
import { MatchReceipts } from '@/components/MatchReceipts'
import { PayrollProof } from '@/components/PayrollProof'
// DESIGN EXPERIMENT (?layout=a|b|c): remove with report-layouts/ once one is chosen.
import { ReviewSwitch } from '@/ReviewSwitch'
import type { MonthLayoutProps } from './report-layouts/shared'
import { LayoutA } from './report-layouts/LayoutA'
import { LayoutB } from './report-layouts/LayoutB'
import { LayoutC } from './report-layouts/LayoutC'

/** The document types that can stand as each kind of proof. */
const KINDS_FOR: Record<DocumentPurpose, DocumentKind[]> = {
  invoice: ['invoice', 'receipt', 'purchase-order'],
  payment: ['bank-statement', 'card-statement', 'eft-confirmation', 'cancelled-check'],
  allocation: ['allocation-calculation'],
  timesheet: ['timesheet'],
  register: ['payroll-register'],
  other: ['other'],
}

/** The proof each expense needs, by the line it reports on and how it was allocated. */
function requiredPurposes(e: ExpenseDto): DocumentPurpose[] {
  const base: DocumentPurpose[] = PAYROLL_REPORT_LINES.has(e.reportLine)
    ? ['timesheet', 'register', 'payment']
    : ['invoice', 'payment']
  return e.allocationType === 'direct' ? base : [...base, 'allocation']
}

/**
 * Item numbers and accounts are logged by value, so the API takes them as ID-like text only; the inputs say so
 * before the person submits.
 */
const ID_LIKE = {
  pattern: '[A-Za-z0-9#&.\\/ \\-]{1,40}',
  maxLength: 40,
  title: 'Letters, digits, #, &, ., /, - and spaces, up to 40 characters',
}

type Attach =
  | { kind: 'expense'; expense: ExpenseDto; purpose: DocumentPurpose }
  | { kind: 'wex'; payment: WexPaymentDto; purpose: DocumentPurpose }

export function ReportPage() {
  const { id } = useParams()
  const api = useApi()
  // The open is the one logged read; each change answers with the page as it now stands, so nothing re-fetches.
  const { data: r, error, setData } = useLoad<ReportDetail>(id ? `/reports/${id}` : null)
  // The expense or payroll form: two forms, each with its own lines, so neither offers the other's.
  const [editing, setEditing] = useState<{ kind: EntryKind; expense: ExpenseDto | null } | null>(
    null
  )
  const edit = (e: ExpenseDto) => setEditing({ kind: kindOf(e.reportLine), expense: e })
  const [importing, setImporting] = useState(false)
  const [tagFilter, setTagFilter] = useState('')
  const [tagging, setTagging] = useState<WexPaymentDto | null>(null)
  const [attach, setAttach] = useState<Attach | null>(null)
  const [closing, setClosing] = useState<
    'approve' | 'send-back' | 'request-edits' | 'reopen' | null
  >(null)
  const [signing, setSigning] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null)
  const [highlight, setHighlight] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [params] = useSearchParams()
  const layout = params.get('layout')

  useEffect(() => {
    if (!highlight) return
    document
      .getElementById(`expense-${highlight}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    const t = setTimeout(() => setHighlight(null), 2500)
    return () => clearTimeout(t)
  }, [highlight])

  if (error) return <ErrorNote message={error} />
  if (!r) return <Empty>Loading…</Empty>

  const signed = r.signedCopy
  const reopening = r.reopenings[0]
  const blockers = r.checks.filter((k) => k.severity === 'blocker')
  const attention = r.checks.filter((k) => k.severity === 'attention')
  const infos = r.checks.filter((k) => k.severity === 'info')
  const billed = r.lines.reduce((t, l) => t + l.billedThisPeriod, 0)
  const expenses = tagFilter ? r.expenses.filter((e) => e.tags.includes(tagFilter)) : r.expenses

  const run = async (fn: () => Promise<ReportDetail>, ok?: string) => {
    setBusy(true)
    setNotice(null)
    try {
      setData(await fn())
      if (ok) setNotice({ tone: 'ok', text: ok })
    } catch (e) {
      setNotice({ tone: 'danger', text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }
  const submit = () =>
    run(
      async () => {
        try {
          return await api.post<ReportDetail>(`/reports/${r.id}/submit`)
        } catch (e) {
          if (e instanceof ApiError && e.status === 409) throw new Error(e.message)
          throw e
        }
      },
      `${periodLabel(r.period)} submitted to ${r.engagement.funder ?? 'the funder'}.`
    )
  const downloadBundle = async () => {
    setBusy(true)
    setNotice(null)
    try {
      await api.download(
        `/reports/${r.id}/bundle`,
        `${r.engagement.name} - ${periodLabel(r.period)} - bundle.zip`
      )
      setNotice({
        tone: 'ok',
        text: "Month's bundle downloaded. The download is in the access log.",
      })
    } catch (e) {
      setNotice({ tone: 'danger', text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }
  const deleteExpense = (e: ExpenseDto) => {
    if (
      !confirm(
        `Remove ${e.itemNumber} (${e.vendor}, ${money(e.allocatedAmount)}) from ${periodLabel(r.period)}?`
      )
    )
      return
    void run(() => api.del<ReportDetail>(`/expenses/${e.id}`), `${e.itemNumber} removed.`)
  }

  const head = (
    <>
      <nav className="ad-crumbs" aria-label="Breadcrumb">
        <Link to={`/workspaces/${r.engagement.workspace.id}`}>{r.engagement.workspace.name}</Link> /{' '}
        <Link to={`/engagements/${r.engagement.id}`} className="ad-mono">
          {r.engagement.number}
        </Link>{' '}
        / {periodLabel(r.period)}
      </nav>
      <div className="ad-head">
        <div>
          <h1 className="ad-h1 flex flex-wrap items-center gap-3">
            {periodLabel(r.period)} <StatusChip status={r.status} />
          </h1>
          <p className="ad-sub">
            {r.engagement.workspace.name} · <span className="ad-mono">{r.engagement.number}</span> ·{' '}
            {r.engagement.name}
          </p>
          <p className="ad-sub !mt-0">
            Due {shortDate(r.dueDate)}
            {r.status !== 'draft' && r.authorizedAt && (
              <>
                {' '}
                · month-end closing approved {shortDate(r.authorizedAt)}
                {r.authorizedByName ? ` by ${r.authorizedByName}` : ''}
              </>
            )}
            {r.submittedAt && (
              <>
                {' '}
                · submitted {shortDate(r.submittedAt)} by {r.preparedByName}
              </>
            )}
          </p>
        </div>
        <div className="ad-actions">
          {signed ? (
            <Chip tone="ok" title={signed.fileName}>
              <DocumentLink doc={signed}>✓ signed copy</DocumentLink>
            </Chip>
          ) : r.can.attachSigned ? (
            <Button onClick={() => setSigning(true)}>Attach signed copy</Button>
          ) : null}
          <Link to={`/reports/${r.id}/form`} className="ad-btn-quiet">
            Funder's form
          </Link>
          <Button
            onClick={() => void downloadBundle()}
            disabled={busy}
            title="The signed report, the ledger summary and the supporting records in one zip, to send with the invoice. Personal records are never in it."
            data-testid="download-bundle"
          >
            Download the month's bundle
          </Button>
          {r.can.close && (
            <Button
              kind="primary"
              onClick={() => setClosing('approve')}
              disabled={busy || blockers.length > 0}
              title={
                blockers.length
                  ? `${blockers.length} blocking check(s) first`
                  : 'Record that the month-end closing is approved'
              }
              data-testid="approve-closing"
            >
              Approve month-end closing {blockers.length > 0 && `(${blockers.length} blocking)`}
            </Button>
          )}
          {r.can.sendBack && (
            <Button onClick={() => setClosing('send-back')} disabled={busy}>
              Send back
            </Button>
          )}
          {r.can.submit && (
            <Button
              kind="primary"
              onClick={submit}
              disabled={busy || blockers.length > 0}
              title={
                blockers.length
                  ? `${blockers.length} blocking check(s) first`
                  : 'Submit to the funder'
              }
              data-testid="submit"
            >
              Submit to the funder {blockers.length > 0 && `(${blockers.length} blocking)`}
            </Button>
          )}
          {r.can.reopen && (
            <Button
              onClick={() => setClosing('reopen')}
              disabled={busy}
              title="Make it a draft again to correct it, then approve the closing and submit it again"
              data-testid="reopen"
            >
              Reopen to correct
            </Button>
          )}
        </div>
      </div>

      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
      {r.status === 'draft' && r.sentBackReason && (
        <Notice tone="danger">
          <b>Month-end closing sent back:</b> {r.sentBackReason}
        </Notice>
      )}
      {r.status === 'draft' && !r.sentBackReason && reopening && (
        <Notice tone="danger">
          <b>Reopened to correct:</b> {reopening.reason} Correct the month, approve its closing
          again, attach the corrected signed copy and submit it again.
        </Notice>
      )}
      {r.status === 'closed' && (
        <Notice tone="ok">
          <b>Month-end closing approved</b>
          {r.authorizedByName ? ` by ${r.authorizedByName}` : ''}
          {r.authorizedAt ? ` on ${shortDate(r.authorizedAt)}` : ''}.
          {r.closingNote ? ` ${r.closingNote}` : ''} The ledger is locked: send it back to change
          it. Next, sign the funder's form and submit it.
        </Notice>
      )}

      <div className="ad-tiles">
        <Tile
          label="Billed this month"
          value={money(billed)}
          note={`${r.expenses.length} expenses`}
        />
        <Tile
          label="Blocking"
          value={blockers.length}
          note={blockers.length ? 'Fix before the month-end closing' : 'Nothing blocks the closing'}
          warn={blockers.length > 0}
        />
        <Tile
          label="Needs attention"
          value={attention.length}
          note={attention.length ? 'Worth a look before the funder does' : 'Nothing flagged'}
        />
        <Tile
          label="Due"
          value={shortDate(r.dueDate)}
          note={
            r.submittedAt
              ? `Submitted ${shortDate(r.submittedAt)}`
              : `Day ${r.engagement.reportDueDay} of each month`
          }
        />
      </div>
    </>
  )
  const checksCard = (
    <Card
      className="lg:col-span-2"
      title="Checks"
      aside={
        <>
          {blockers.length > 0 ? (
            <Chip tone="danger" fill>
              {blockers.length} blocking
            </Chip>
          ) : (
            <Chip tone="ok">nothing blocking</Chip>
          )}
          {attention.length > 0 && <Chip tone="warn">{attention.length} attention</Chip>}
          {infos.length > 0 && <Chip tone="info">{infos.length} info</Chip>}
        </>
      }
    >
      {r.checks.length === 0 && <Empty>Every rule passes. Ready for the month-end closing.</Empty>}
      <ul className="ad-checks" data-testid="checks">
        {r.checks.map((k) => (
          <CheckRow
            key={k.id}
            check={k}
            onJump={k.expenseId ? () => setHighlight(k.expenseId!) : undefined}
          />
        ))}
      </ul>
    </Card>
  )
  const linesCard = (
    <Card title="By report line" aside={<b className="text-ink">{money(billed)}</b>}>
      <table className="ad-table">
        <thead>
          <tr>
            <th>Line</th>
            <th className="ad-num">This month</th>
            <th className="ad-num">Left</th>
          </tr>
        </thead>
        <tbody>
          {r.lines
            .filter((l) => l.budget > 0 || l.billedThisPeriod > 0 || l.previouslyBilled > 0)
            .map((l) => (
              <tr key={l.line}>
                <td>{l.label}</td>
                <td className="ad-num font-semibold">{money(l.billedThisPeriod)}</td>
                <td className={`ad-num ${l.remaining < 0 ? 'font-bold text-danger' : 'text-soft'}`}>
                  {money(l.remaining)}
                </td>
              </tr>
            ))}
        </tbody>
      </table>
      <p className="mt-3 text-xs text-soft">
        Budget, previously billed, cumulative and remaining per line are on the{' '}
        <Link to={`/reports/${r.id}/form`}>funder's form</Link>.
      </p>
    </Card>
  )
  const ledgerCard = (
    <Card
      className="mt-4"
      title="Ledger"
      aside={
        <>
          {r.expenses.length > 0 && (
            <TagFilter
              types={r.tagTypes}
              target="expense"
              value={tagFilter}
              onChange={setTagFilter}
            />
          )}
          {r.can.edit && <Button onClick={() => setImporting(true)}>Import transactions</Button>}
          {r.can.edit && (
            <Button
              kind="primary"
              onClick={() => setEditing({ kind: 'expense', expense: null })}
              data-testid="add-expense"
            >
              + Add expense
            </Button>
          )}
        </>
      }
    >
      {r.expenses.length === 0 && <Empty>No expenses yet.</Empty>}
      {r.expenses.length > 0 && expenses.length === 0 && (
        <Empty>No expense this month has that tag.</Empty>
      )}
      {expenses.length > 0 && (
        <div className="ad-tablewrap">
          <table className="ad-table">
            <thead>
              <tr>
                <th>Item</th>
                <th>Vendor</th>
                <th>Line</th>
                <th className="ad-num">Total</th>
                <th className="ad-num">Charged</th>
                <th>Proof</th>
                {r.can.edit && <th></th>}
              </tr>
            </thead>
            <tbody>
              {expenses.map((e) => {
                const have = new Map(e.documents.map((d) => [d.purpose, d]))
                const required = requiredPurposes(e)
                const extra = e.documents.filter((d) => !required.includes(d.purpose))
                const flagged = r.checks.some(
                  (k) => k.expenseId === e.id && k.severity === 'blocker'
                )
                return (
                  <tr
                    key={e.id}
                    id={`expense-${e.id}`}
                    className={highlight === e.id ? 'ad-row-flash' : undefined}
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
                      {REPORT_LINE_LABELS[e.reportLine]}
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
                      <div className="flex flex-wrap gap-1">
                        {required.map((purpose) => {
                          const d = have.get(purpose)
                          return d ? (
                            <Chip key={purpose} tone="ok" title={d.document.fileName}>
                              <DocumentLink doc={d.document}>
                                ✓ {DOCUMENT_PURPOSE_LABELS[purpose]}
                              </DocumentLink>
                            </Chip>
                          ) : r.can.edit ? (
                            <button
                              key={purpose}
                              type="button"
                              className="ad-chip ad-chip-missing"
                              onClick={() => setAttach({ kind: 'expense', expense: e, purpose })}
                              data-testid={`attach-${e.itemNumber}-${purpose}`}
                            >
                              + {DOCUMENT_PURPOSE_LABELS[purpose]}
                            </button>
                          ) : (
                            <Chip key={purpose} tone="danger">
                              missing {DOCUMENT_PURPOSE_LABELS[purpose]}
                            </Chip>
                          )
                        })}
                        {extra.map((d) => (
                          <Chip key={d.document.id} tone="muted" title={d.document.fileName}>
                            <DocumentLink doc={d.document}>
                              {DOCUMENT_PURPOSE_LABELS[d.purpose]}
                            </DocumentLink>
                          </Chip>
                        ))}
                      </div>
                      {flagged && (
                        <span className="ad-table-sub mt-1 font-semibold !text-danger">
                          Blocking: see checks
                        </span>
                      )}
                    </td>
                    {r.can.edit && (
                      <td className="ad-num">
                        <Button kind="ghost" onClick={() => edit(e)}>
                          edit
                        </Button>
                        <Button
                          kind="ghost"
                          className="text-danger"
                          onClick={() => deleteExpense(e)}
                          data-testid={`delete-${e.itemNumber}`}
                        >
                          remove
                        </Button>
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
  const receiptsCard = (
    <MatchReceipts
      report={r}
      onChange={setData}
      onNotice={(text) => setNotice({ tone: 'ok', text })}
    />
  )
  const payrollCard = (
    <Card
      className="mt-4"
      title="Payroll verification"
      aside={
        <span className="text-xs text-soft">
          Timesheet, payroll register and evidence of payment for each participant paid. Pay stubs
          are personal documents: download only, every read logged.
        </span>
      }
    >
      {r.wexPayments.length === 0 && <Empty>No participant was paid this month.</Empty>}
      {r.wexPayments.length > 0 && (
        <div className="ad-tablewrap">
          <table className="ad-table">
            <thead>
              <tr>
                <th>Participant</th>
                <th>Pay period</th>
                <th className="ad-num">Hours</th>
                <th className="ad-num">Gross</th>
                <th>Proof</th>
                <th>Eligibility file</th>
              </tr>
            </thead>
            <tbody>
              {r.wexPayments.map((w) => {
                const have = new Map(w.documents.map((d) => [d.purpose, d]))
                const participant = r.participants.find((p) => p.id === w.participantId)
                const items = new Set(participant?.documents.map((d) => d.purpose))
                const missing = r.engagement.eligibilityItems
                  .filter((i) => i.required)
                  .filter((i) => !items.has(i.key))
                return (
                  <tr key={w.id}>
                    <td>
                      <span className="font-semibold">{w.participantName}</span>
                      <span className="ad-table-sub ad-mono">{w.participantNumber}</span>
                      <TagChips types={r.tagTypes} tags={w.tags} />
                      {r.can.edit && (
                        <Button size="sm" kind="ghost" onClick={() => setTagging(w)}>
                          tags
                        </Button>
                      )}
                    </td>
                    <td className="whitespace-nowrap">
                      {w.payPeriodStart} to {w.payPeriodEnd}
                    </td>
                    <td className="ad-num">{w.hours ?? '—'}</td>
                    <td className="ad-num font-semibold">{money(w.grossAmount)}</td>
                    <td>
                      <div className="flex flex-wrap gap-1">
                        {(['timesheet', 'register', 'payment'] as DocumentPurpose[]).map(
                          (purpose) => {
                            const d = have.get(purpose)
                            return d ? (
                              <Chip key={purpose} tone="ok">
                                <DocumentLink doc={d.document}>
                                  ✓ {DOCUMENT_PURPOSE_LABELS[purpose]}
                                </DocumentLink>
                              </Chip>
                            ) : r.can.edit ? (
                              <button
                                key={purpose}
                                type="button"
                                className="ad-chip ad-chip-missing"
                                onClick={() => setAttach({ kind: 'wex', payment: w, purpose })}
                              >
                                + {DOCUMENT_PURPOSE_LABELS[purpose]}
                              </button>
                            ) : (
                              <Chip key={purpose} tone="danger">
                                missing {DOCUMENT_PURPOSE_LABELS[purpose]}
                              </Chip>
                            )
                          }
                        )}
                      </div>
                    </td>
                    <td>
                      {missing.length === 0 ? (
                        <Chip tone="ok">complete</Chip>
                      ) : (
                        <Chip tone={items.has('self-attestation') ? 'info' : 'warn'}>
                          {missing.length} missing
                        </Chip>
                      )}{' '}
                      <Link
                        to={`/engagements/${r.engagement.id}#participants`}
                        className="text-xs font-semibold"
                      >
                        file
                      </Link>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
  const payrollProofCard = (
    <PayrollProof
      report={r}
      onChange={setData}
      onNotice={(text) => setNotice({ tone: 'ok', text })}
    />
  )
  const earlier = r.reopenings.length > 0 && <EarlierSubmissions report={r} />
  const modals = (
    <>
      {importing && (
        <ImportTransactionsModal
          engagementId={r.engagement.id}
          reportId={r.id}
          onClose={() => setImporting(false)}
          onImported={(result) => result.report && setData(result.report)}
        />
      )}
      {editing && (
        <ExpenseModal
          kind={editing.kind}
          expense={editing.expense}
          lines={r.lines}
          participants={r.participants}
          onSaveWex={async (input) => {
            setData(await api.post<ReportDetail>(`/reports/${r.id}/wex`, input))
            setEditing(null)
          }}
          period={r.period}
          tagTypes={r.tagTypes}
          onClose={() => setEditing(null)}
          onSave={async (input) => {
            setData(
              editing.expense
                ? await api.patch<ReportDetail>(`/expenses/${editing.expense.id}`, input)
                : await api.post<ReportDetail>(`/reports/${r.id}/expenses`, input)
            )
            setEditing(null)
          }}
        />
      )}
      {tagging && (
        <TagsModal
          title={`Tags for ${tagging.participantName}'s pay, ${tagging.payPeriodStart} to ${tagging.payPeriodEnd}`}
          types={r.tagTypes}
          target="payroll"
          tags={tagging.tags}
          onClose={() => setTagging(null)}
          onSave={async (tags) => {
            setData(await api.patch<ReportDetail>(`/wex/${tagging.id}/tags`, { tags }))
            setTagging(null)
          }}
        />
      )}
      {attach && (
        <AttachModal
          title={
            attach.kind === 'expense'
              ? `${attach.expense.itemNumber} ${attach.expense.vendor}: ${DOCUMENT_PURPOSE_LABELS[attach.purpose]}`
              : `${attach.payment.participantName}: ${DOCUMENT_PURPOSE_LABELS[attach.purpose]}`
          }
          workspaceId={r.engagement.workspace.id}
          engagementId={r.engagement.id}
          period={r.period}
          defaultKind={KINDS_FOR[attach.purpose][0]}
          kinds={KINDS_FOR[attach.purpose]}
          attachTo={
            attach.kind === 'expense'
              ? { target: 'expense', id: attach.expense.id, purpose: attach.purpose }
              : { target: 'wex', id: attach.payment.id, purpose: attach.purpose }
          }
          onClose={() => setAttach(null)}
          onAttached={async (report) => {
            setAttach(null)
            setData(report)
            setNotice({
              tone: 'ok',
              text: `Attached ${DOCUMENT_PURPOSE_LABELS[attach.purpose].toLowerCase()}.`,
            })
          }}
        />
      )}
      {signing && (
        <AttachModal
          title={`Signed report for ${periodLabel(r.period)}`}
          workspaceId={r.engagement.workspace.id}
          engagementId={r.engagement.id}
          period={r.period}
          defaultKind="signed-report"
          kinds={['signed-report']}
          uploadOnly
          onClose={() => setSigning(false)}
          onPick={async (doc) => {
            setSigning(false)
            // The upload's answer is the new document; the page adds it without asking again.
            setData({
              ...r,
              documents: [doc, ...r.documents],
              signedCopy: doc,
              can: { ...r.can, attachSigned: false },
            })
            setNotice({ tone: 'ok', text: 'Signed copy on file.' })
          }}
        />
      )}
      {closing === 'approve' && (
        <ClosingModal
          report={r}
          onClose={() => setClosing(null)}
          onSave={async (body) => {
            setData(await api.post<ReportDetail>(`/reports/${r.id}/closing`, body))
            setClosing(null)
            setNotice({
              tone: 'ok',
              text: `Month-end closing of ${periodLabel(r.period)} recorded as approved.`,
            })
          }}
        />
      )}
      {closing === 'send-back' && (
        <SendBackModal
          report={r}
          onClose={() => setClosing(null)}
          onSave={async (reason) => {
            setData(await api.post<ReportDetail>(`/reports/${r.id}/send-back`, { reason }))
            setClosing(null)
            setNotice({
              tone: 'ok',
              text: `Month-end closing of ${periodLabel(r.period)} sent back. The month is a draft again.`,
            })
          }}
        />
      )}
      {closing === 'request-edits' && (
        <RequestEditsModal
          report={r}
          onClose={() => setClosing(null)}
          onSave={async (comment) => {
            setData(await api.post<ReportDetail>(`/reports/${r.id}/request-edits`, { comment }))
            setClosing(null)
            setNotice({
              tone: 'ok',
              text:
                r.status === 'closed'
                  ? `Edits requested. ${periodLabel(r.period)} is a draft again and its closing needs approving again.`
                  : `Edits requested on ${periodLabel(r.period)}. The request shows on the month until its closing is approved.`,
            })
          }}
        />
      )}
      {closing === 'reopen' && (
        <ReopenModal
          report={r}
          onClose={() => setClosing(null)}
          onSave={async (reason) => {
            setData(await api.post<ReportDetail>(`/reports/${r.id}/reopen`, { reason }))
            setClosing(null)
            setNotice({
              tone: 'ok',
              text: `${periodLabel(r.period)} reopened. It is a draft again: correct it, then approve its closing and submit it again.`,
            })
          }}
        />
      )}
    </>
  )

  // DESIGN EXPERIMENT (?layout=a|b|c): delete this block, report-layouts/ and the switch once one is chosen.
  const switcher = (
    <ReviewSwitch
      param="layout"
      label="Month layout"
      current={layout && LAYOUTS[layout] ? layout : 'now'}
      options={[
        { key: 'now', label: 'Now' },
        { key: 'a', label: 'A · Stepper' },
        { key: 'b', label: 'B · Checklist' },
        { key: 'c', label: 'C · Your design' },
      ]}
    />
  )
  const Layout = layout ? LAYOUTS[layout] : undefined
  if (Layout)
    return (
      <>
        <Layout
          r={r}
          busy={busy}
          notice={notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
          highlight={highlight}
          sections={{
            checks: checksCard,
            lines: linesCard,
            ledger: ledgerCard,
            receipts: receiptsCard,
            payroll: payrollCard,
            payrollProof: payrollProofCard,
            earlier,
          }}
          act={{
            addExpense: () => setEditing({ kind: 'expense', expense: null }),
            addPayroll: () => setEditing({ kind: 'payroll', expense: null }),
            editExpense: edit,
            importTransactions: () => setImporting(true),
            attach: (expense, purpose) => setAttach({ kind: 'expense', expense, purpose }),
            approve: () => setClosing('approve'),
            sendBack: () => setClosing('send-back'),
            requestEdits: () => setClosing('request-edits'),
            reopen: () => setClosing('reopen'),
            attachSigned: () => setSigning(true),
            submit: () => void submit(),
            downloadBundle: () => void downloadBundle(),
            deleteExpense,
            attachPayment: (payment, purpose) => setAttach({ kind: 'wex', payment, purpose }),
            tagPayment: (w) => setTagging(w),
          }}
        />
        {modals}
        {switcher}
      </>
    )

  return (
    <>
      {head}
      <div className="grid gap-4 lg:grid-cols-3">
        {checksCard}
        {linesCard}
      </div>
      {ledgerCard}
      {receiptsCard}
      {payrollCard}
      {payrollProofCard}
      {earlier}
      {modals}
      {switcher}
    </>
  )
}

/** DESIGN EXPERIMENT: the layouts under review, by their ?layout= key. */
const LAYOUTS: Record<string, (p: MonthLayoutProps) => React.JSX.Element> = {
  a: LayoutA,
  b: LayoutB,
  c: LayoutC,
}

function CheckRow({ check, onJump }: { check: CheckDto; onJump?: () => void }) {
  return (
    <li>
      <Chip tone={severityTone[check.severity]} fill={check.severity === 'blocker'}>
        {check.severity}
      </Chip>
      <div className="flex-1">
        <span>{check.message}</span>{' '}
        {onJump && (
          <button
            type="button"
            className="text-xs font-semibold text-accent hover:underline"
            onClick={onJump}
          >
            show
          </button>
        )}
        <span className="ad-mono ml-2 text-xs text-soft">{check.code}</span>
      </div>
    </li>
  )
}

type EntryKind = 'expense' | 'payroll'
const kindOf = (line: ExpenseInput['reportLine']): EntryKind =>
  PAYROLL_REPORT_LINES.has(line) ? 'payroll' : 'expense'

/**
 * The lines a form offers: its own kind's lines that this engagement has a budget for, and the line an edited row
 * is on. With no budget line of that kind yet, every line of the kind, so the form is never a dead end.
 */
function lineChoices(kind: EntryKind, lines: LineRow[], current?: ExpenseInput['reportLine']) {
  const ofKind = REPORT_LINES.filter((l) => kindOf(l) === kind)
  const budgeted = ofKind.filter(
    (l) => l === current || lines.some((x) => x.line === l && x.budget > 0)
  )
  return { choices: budgeted.length ? budgeted : ofKind, unbudgeted: !budgeted.length }
}

function ExpenseModal({
  kind,
  expense,
  lines,
  participants,
  onSaveWex,
  period,
  tagTypes,
  onClose,
  onSave,
}: {
  kind: EntryKind
  expense: ExpenseDto | null
  lines: LineRow[]
  /** The engagement's participants: a payroll item may pay one of them (a work-experience payment). */
  participants: ParticipantDto[]
  onSaveWex: (input: WexPaymentInput) => Promise<void>
  period: string
  tagTypes: TagType[]
  onClose: () => void
  onSave: (input: ExpenseInput) => Promise<void>
}) {
  const { choices, unbudgeted } = lineChoices(kind, lines, expense?.reportLine)
  const payroll = kind === 'payroll'
  // Add payroll pays a vendor (a staff member or payroll provider) or a participant (work experience).
  const [payee, setPayee] = useState<'vendor' | 'participant'>('vendor')
  const [form, setForm] = useState<ExpenseInput>(
    expense ?? {
      itemNumber: '',
      date: `${period}-01`,
      vendor: '',
      memo: '',
      account: '',
      totalCost: 0,
      allocatedAmount: 0,
      allocationType: 'direct',
      allocationNote: '',
      reportLine: choices[0],
      tags: [],
    }
  )
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const set = <K extends keyof ExpenseInput>(k: K, v: ExpenseInput[K]) =>
    setForm((f) => ({ ...f, [k]: v }))
  const first = useRef<HTMLInputElement>(null)
  useEffect(() => first.current?.focus(), [])
  const save = async (ev: React.FormEvent) => {
    ev.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await onSave({
        ...form,
        totalCost: Number(form.totalCost),
        allocatedAmount:
          form.allocationType === 'direct' ? Number(form.totalCost) : Number(form.allocatedAmount),
      })
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }
  return (
    <Modal
      title={expense ? `Edit ${expense.itemNumber}` : payroll ? 'Add payroll' : 'Add an expense'}
      onClose={onClose}
    >
      {payroll && !expense && (
        <div className="ad-payee" role="radiogroup" aria-label="Who was paid">
          {(
            [
              ['vendor', 'Staff or payroll provider'],
              ['participant', 'A participant (work experience)'],
            ] as const
          ).map(([k, label]) => (
            <label key={k} className={payee === k ? 'ad-payee-on' : undefined}>
              <input type="radio" name="payee" checked={payee === k} onChange={() => setPayee(k)} />
              {label}
            </label>
          ))}
        </div>
      )}
      {payroll && !expense && payee === 'participant' ? (
        <WexForm
          participants={participants}
          period={period}
          tagTypes={tagTypes}
          onClose={onClose}
          onSave={onSaveWex}
        />
      ) : (
        /* Three numbered groups, required fields first, so the form says what to fill in and in what order. */
        <form onSubmit={save} className="ad-entry">
          {error && <ErrorNote message={error} />}
          <fieldset className="ad-entry-group">
            <legend>
              <b>1</b> {payroll ? 'Who was paid' : 'What was bought'}
            </legend>
            <Field
              label={payroll ? 'Paid to (employee or payroll provider)' : 'Vendor'}
              required
              className="sm:col-span-2"
            >
              <input
                ref={first}
                className={inputClass}
                value={form.vendor}
                onChange={(e) => set('vendor', e.target.value)}
                required
                data-testid="f-vendor"
              />
            </Field>
            <Field label={payroll ? 'Pay date' : 'Date'} required>
              <input
                type="date"
                className={inputClass}
                value={form.date}
                onChange={(e) => set('date', e.target.value)}
                required
                data-testid="f-date"
              />
            </Field>
            <Field label="Total cost" required>
              <input
                type="number"
                step="0.01"
                min="0.01"
                className={inputClass}
                value={form.totalCost || ''}
                onChange={(e) => set('totalCost', Number(e.target.value))}
                placeholder="0.00"
                required
                data-testid="f-total"
              />
            </Field>
            <Field
              label="Item number"
              required
              hint={
                payroll
                  ? 'Your reference, such as the payroll run or check number.'
                  : 'Your reference, such as the invoice, check or transaction number.'
              }
              className="sm:col-span-2"
            >
              <input
                className={inputClass}
                value={form.itemNumber}
                onChange={(e) => set('itemNumber', e.target.value)}
                required
                {...ID_LIKE}
                data-testid="f-item"
              />
            </Field>
          </fieldset>
          <fieldset className="ad-entry-group">
            <legend>
              <b>2</b> Where it is charged
            </legend>
            <Field
              label="Budget line"
              required
              hint={
                unbudgeted
                  ? `This engagement has no ${payroll ? 'payroll' : 'expense'} budget line yet. Add one on its budget.`
                  : undefined
              }
            >
              <select
                className={inputClass}
                value={form.reportLine}
                onChange={(e) => set('reportLine', e.target.value as ExpenseInput['reportLine'])}
                required
                data-testid="f-line"
              >
                {choices.map((l) => (
                  <option key={l} value={l}>
                    {REPORT_LINE_LABELS[l]}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="How much goes to this program"
              required
              hint={
                form.allocationType === 'direct'
                  ? `All of it: ${money(Number(form.totalCost) || 0)} is charged here.`
                  : 'Only a share is charged here; say how it was worked out.'
              }
            >
              <select
                className={inputClass}
                value={form.allocationType}
                onChange={(e) =>
                  set('allocationType', e.target.value as ExpenseInput['allocationType'])
                }
              >
                {ALLOCATION_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {ALLOCATION_TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
            </Field>
            {form.allocationType !== 'direct' && (
              <>
                <Field label="Amount charged to this program" required>
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    className={inputClass}
                    value={form.allocatedAmount || ''}
                    onChange={(e) => set('allocatedAmount', Number(e.target.value))}
                    placeholder="0.00"
                    required
                  />
                </Field>
                <Field label="How the share was worked out" hint="e.g. 18.5% of payroll hours">
                  <input
                    className={inputClass}
                    value={form.allocationNote ?? ''}
                    onChange={(e) => set('allocationNote', e.target.value)}
                  />
                </Field>
              </>
            )}
          </fieldset>
          <fieldset className="ad-entry-group">
            <legend>
              <b>3</b> Details <span className="text-soft">(optional)</span>
            </legend>
            <Field
              label="Memo"
              hint="What it was for. It shows under the vendor in the grid."
              className="sm:col-span-2"
            >
              <input
                className={inputClass}
                value={form.memo ?? ''}
                onChange={(e) => set('memo', e.target.value)}
                data-testid="f-memo"
              />
            </Field>
            <Field
              label="Account in your books (general ledger)"
              hint="e.g. 60701 Accounting Fees. An import fills it in; it lets the auditor match your ledger."
              className="sm:col-span-2"
            >
              <input
                className={inputClass}
                value={form.account ?? ''}
                onChange={(e) => set('account', e.target.value)}
                {...ID_LIKE}
              />
            </Field>
            {/* Not a <label>: a label holding buttons would press the first when its words are clicked. */}
            <div className="ad-field sm:col-span-2">
              <span>Tags</span>
              <TagPicker
                types={tagTypes}
                target="expense"
                value={form.tags ?? []}
                onChange={(tags) => set('tags', tags)}
              />
              <small>For finding it later with the search box.</small>
            </div>
          </fieldset>
          <p className="ad-entry-next">
            <span className="ad-req">*</span> Required.{' '}
            {payroll
              ? 'Next: attach the timesheet, payroll register and evidence of payment on its row.'
              : 'Next: attach the invoice and evidence of payment on its row.'}
          </p>
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" kind="primary" disabled={busy} data-testid="f-save">
              {expense ? 'Save' : payroll ? 'Add payroll' : 'Add expense'}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  )
}

/** A participant's work-experience pay: who, the pay period, the hours and the gross pay, charged to WEX. */
function WexForm({
  participants,
  period,
  tagTypes,
  onClose,
  onSave,
}: {
  participants: ParticipantDto[]
  period: string
  tagTypes: TagType[]
  onClose: () => void
  onSave: (input: WexPaymentInput) => Promise<void>
}) {
  const [form, setForm] = useState<WexPaymentInput>({
    participantId: '',
    payPeriodStart: `${period}-01`,
    payPeriodEnd: `${period}-15`,
    hours: null,
    grossAmount: 0,
    tags: [],
  })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const set = <K extends keyof WexPaymentInput>(k: K, v: WexPaymentInput[K]) =>
    setForm((f) => ({ ...f, [k]: v }))
  const save = async (ev: React.FormEvent) => {
    ev.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await onSave({ ...form, grossAmount: Number(form.grossAmount) })
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }
  return (
    <form onSubmit={save} className="ad-entry">
      {error && <ErrorNote message={error} />}
      <fieldset className="ad-entry-group">
        <legend>
          <b>1</b> Who was paid
        </legend>
        <Field
          label="Participant"
          required
          className="sm:col-span-2"
          hint={
            participants.length
              ? 'From this engagement’s participants (step 5).'
              : 'No participants yet: add them on the engagement (step 5) first.'
          }
        >
          <select
            className={inputClass}
            value={form.participantId}
            onChange={(e) => set('participantId', e.target.value)}
            required
          >
            <option value="">Choose a participant</option>
            {participants.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName} ({p.participantId})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Pay period starts" required>
          <input
            type="date"
            className={inputClass}
            value={form.payPeriodStart}
            onChange={(e) => set('payPeriodStart', e.target.value)}
            required
          />
        </Field>
        <Field label="Pay period ends" required>
          <input
            type="date"
            className={inputClass}
            value={form.payPeriodEnd}
            onChange={(e) => set('payPeriodEnd', e.target.value)}
            required
          />
        </Field>
        <Field label="Gross pay" required>
          <input
            type="number"
            step="0.01"
            min="0.01"
            className={inputClass}
            value={form.grossAmount || ''}
            onChange={(e) => set('grossAmount', Number(e.target.value))}
            placeholder="0.00"
            required
          />
        </Field>
        <Field label="Hours" hint="From the timesheet, if you have it.">
          <input
            type="number"
            step="0.25"
            min="0"
            className={inputClass}
            value={form.hours ?? ''}
            onChange={(e) => set('hours', e.target.value === '' ? null : Number(e.target.value))}
          />
        </Field>
      </fieldset>
      <fieldset className="ad-entry-group">
        <legend>
          <b>2</b> Where it is charged
        </legend>
        <p className="text-sm sm:col-span-2">
          Work Experience (WEX). A participant’s pay is always charged there.
        </p>
      </fieldset>
      <fieldset className="ad-entry-group">
        <legend>
          <b>3</b> Details <span className="text-soft">(optional)</span>
        </legend>
        <div className="ad-field sm:col-span-2">
          <span>Tags</span>
          <TagPicker
            types={tagTypes}
            target="payroll"
            value={form.tags ?? []}
            onChange={(tags) => set('tags', tags)}
          />
          <small>For finding it later with the search box.</small>
        </div>
      </fieldset>
      <p className="ad-entry-next">
        <span className="ad-req">*</span> Required. Next: attach the timesheet, payroll register and
        pay stub or deposit advice on its row.
      </p>
      <div className="flex justify-end gap-2">
        <Button type="button" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" kind="primary" disabled={busy || !participants.length}>
          Add payroll
        </Button>
      </div>
    </form>
  )
}

/** Today as YYYY-MM-DD, in the person's own time zone. */
const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * The month-end closing: the company's own approval of the month (the CEO's, often given offline) before the
 * report goes to the funder. The bookkeeper records who approved it and when.
 */
function ClosingModal({
  report,
  onClose,
  onSave,
}: {
  report: ReportDetail
  onClose: () => void
  onSave: (body: ClosingInput) => Promise<void>
}) {
  const [form, setForm] = useState<ClosingInput>({
    approvedBy: report.engagement.authorizerName ?? '',
    approvedOn: today(),
    note: '',
  })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await onSave(form)
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }
  return (
    <Modal title={`Month-end closing for ${periodLabel(report.period)}`} onClose={onClose}>
      <form onSubmit={save}>
        <ErrorNote message={error} />
        <p className="mb-4 text-sm text-soft">
          Record who approved this month for your company, and when, before it goes to{' '}
          {report.engagement.funder ?? 'the funder'}. Once approved, the ledger is locked until the
          closing is sent back.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Approved by" required>
            <input
              className={inputClass}
              value={form.approvedBy}
              onChange={(e) => setForm({ ...form, approvedBy: e.target.value })}
              maxLength={120}
              required
              data-testid="closing-by"
            />
          </Field>
          <Field label="Approved on" required>
            <input
              type="date"
              className={inputClass}
              value={form.approvedOn}
              max={today()}
              onChange={(e) => setForm({ ...form, approvedOn: e.target.value })}
              required
            />
          </Field>
        </div>
        <Field label="Note" hint="Optional" className="mt-4">
          <textarea
            className={inputClass}
            rows={2}
            maxLength={2000}
            value={form.note ?? ''}
            onChange={(e) => setForm({ ...form, note: e.target.value })}
          />
        </Field>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" kind="primary" disabled={busy} data-testid="closing-approve">
            Record as approved
          </Button>
        </div>
      </form>
    </Modal>
  )
}

/**
 * Reopening a submitted month makes it a draft again to correct it (a typo, say), with the reason on its page. Its
 * documents stay; it is closed and submitted again.
 */
function ReopenModal({
  report,
  onClose,
  onSave,
}: {
  report: ReportDetail
  onClose: () => void
  onSave: (reason: string) => Promise<void>
}) {
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await onSave(reason)
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }
  return (
    <Modal title={`Reopen ${periodLabel(report.period)} to correct it`} onClose={onClose}>
      <form onSubmit={save}>
        <ErrorNote message={error} />
        <p className="mb-4 text-sm text-soft">
          The month becomes a draft again so you can correct it. Its documents stay, and the signed
          copy you submitted is kept under Earlier submissions. Then approve its month-end closing
          again, attach the corrected signed copy and submit it again.
        </p>
        <Field label="Why it is reopened" required>
          <textarea
            className={inputClass}
            rows={3}
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            required
          />
        </Field>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" kind="danger" disabled={busy || !reason.trim()}>
            Reopen
          </Button>
        </div>
      </form>
    </Modal>
  )
}

/**
 * Every time the submitted month was reopened, newest first: the submission it undid, the closing's approval, who
 * reopened it and why, and the signed copy as it was submitted. Every member reads it, auditors too.
 */
function EarlierSubmissions({ report }: { report: ReportDetail }) {
  return (
    <Card title="Earlier submissions" aside={<Chip tone="muted">{report.reopenings.length}</Chip>}>
      <p className="mb-3 text-sm text-soft">
        Each time this month was reopened to correct it, what had been submitted is kept here.
      </p>
      <div className="ad-tablewrap">
        <table className="ad-table" data-testid="earlier-submissions">
          <thead>
            <tr>
              <th>Submitted on</th>
              <th>Month-end closing approved</th>
              <th>Reopened</th>
              <th>Why</th>
              <th>Signed copy as submitted</th>
            </tr>
          </thead>
          <tbody>
            {report.reopenings.map((o) => (
              <tr key={o.id}>
                <td className="whitespace-nowrap">{shortDate(o.submittedAt)}</td>
                <td>
                  {o.approvedAt ? shortDate(o.approvedAt) : '—'}
                  {o.approvedByName && <span className="ad-table-sub">by {o.approvedByName}</span>}
                </td>
                <td>
                  {shortDate(o.reopenedAt)}
                  <span className="ad-table-sub">by {o.reopenedBy}</span>
                </td>
                <td>{o.reason}</td>
                <td>
                  {o.signedDocument ? (
                    <DocumentLink doc={o.signedDocument} />
                  ) : (
                    <span className="text-soft">not on file</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

/**
 * Asking for edits, with a comment: on a draft it is recorded on the month, the status unchanged; on a month whose
 * closing is approved it sends the closing back, so the month is a draft again.
 */
function RequestEditsModal({
  report,
  onClose,
  onSave,
}: {
  report: ReportDetail
  onClose: () => void
  onSave: (comment: string) => Promise<void>
}) {
  const [comment, setComment] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await onSave(comment)
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }
  return (
    <Modal title={`Request edits on ${periodLabel(report.period)}`} onClose={onClose}>
      <form onSubmit={save}>
        <ErrorNote message={error} />
        <p className="mb-4 text-sm text-soft">
          {report.status === 'closed'
            ? 'The closing is sent back: the month becomes a draft again so it can be corrected, and its closing needs approving again.'
            : 'The month stays a draft. Your comment shows on it until its closing is approved.'}
        </p>
        <Field label="What needs editing" required>
          <textarea
            className={inputClass}
            rows={3}
            maxLength={500}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            required
          />
        </Field>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" kind="navy" disabled={busy || !comment.trim()}>
            ✏️ Request edits
          </Button>
        </div>
      </form>
    </Modal>
  )
}

/** Sending the month-end closing back reopens the month as a draft, with the reason on its page. */
function SendBackModal({
  report,
  onClose,
  onSave,
}: {
  report: ReportDetail
  onClose: () => void
  onSave: (reason: string) => Promise<void>
}) {
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await onSave(reason)
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }
  return (
    <Modal title={`Send back the closing of ${periodLabel(report.period)}`} onClose={onClose}>
      <form onSubmit={save}>
        <ErrorNote message={error} />
        <p className="mb-4 text-sm text-soft">
          The month becomes a draft again so you can correct it, and its closing needs approving
          again.
        </p>
        <Field label="Why it was sent back" required>
          <textarea
            className={inputClass}
            rows={3}
            maxLength={2000}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            required
          />
        </Field>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" kind="danger" disabled={busy || !reason.trim()}>
            Send back
          </Button>
        </div>
      </form>
    </Modal>
  )
}
