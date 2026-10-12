import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  DOCUMENT_PURPOSE_LABELS,
  ALLOCATION_TYPES,
  PAYROLL_REPORT_LINES,
  REPORT_LINES,
  REPORT_LINE_LABELS,
  type CheckDto,
  type DocumentKind,
  type DocumentPurpose,
  type ExpenseDto,
  type ExpenseInput,
  type ReportDetail,
  type ReportReview,
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

type Attach =
  | { kind: 'expense'; expense: ExpenseDto; purpose: DocumentPurpose }
  | { kind: 'wex'; payment: WexPaymentDto; purpose: DocumentPurpose }

export function ReportPage() {
  const { id } = useParams()
  const api = useApi()
  const { data: r, error, reload } = useLoad<ReportDetail>(id ? `/reports/${id}` : null)
  const [editing, setEditing] = useState<ExpenseDto | 'new' | null>(null)
  const [attach, setAttach] = useState<Attach | null>(null)
  const [reviewing, setReviewing] = useState(false)
  const [signing, setSigning] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null)
  const [highlight, setHighlight] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

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

  const signed = r.documents.find((d) => d.kind === 'signed-report' && d.period === r.period)
  const blockers = r.checks.filter((k) => k.severity === 'blocker')
  const attention = r.checks.filter((k) => k.severity === 'attention')
  const infos = r.checks.filter((k) => k.severity === 'info')
  const billed = r.lines.reduce((t, l) => t + l.billedThisPeriod, 0)

  const run = async (fn: () => Promise<void>, ok?: string) => {
    setBusy(true)
    setNotice(null)
    try {
      await fn()
      await reload()
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
          await api.post(`/reports/${r.id}/submit`)
        } catch (e) {
          if (e instanceof ApiError && e.status === 409) throw new Error(e.message)
          throw e
        }
      },
      `${periodLabel(r.period)} submitted to ${r.engagement.funder ?? 'the funder'}.`
    )
  const deleteExpense = (e: ExpenseDto) => {
    if (
      !confirm(
        `Remove ${e.itemNumber} (${e.vendor}, ${money(e.allocatedAmount)}) from ${periodLabel(r.period)}?`
      )
    )
      return
    void run(() => api.del(`/expenses/${e.id}`), `${e.itemNumber} removed.`)
  }

  return (
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
            {r.submittedAt && (
              <>
                {' '}
                · submitted {shortDate(r.submittedAt)} by {r.preparedByName}
                {r.authorizedByName ? `, authorized by ${r.authorizedByName}` : ''}
              </>
            )}
            {r.reviewedAt && (
              <>
                {' '}
                · {r.status === 'denied' ? 'denied' : 'reviewed'} {shortDate(r.reviewedAt)}
              </>
            )}
          </p>
        </div>
        <div className="ad-actions">
          {signed ? (
            <Chip tone="ok" title={signed.fileName}>
              <DocumentLink doc={signed}>✓ signed copy</DocumentLink>
            </Chip>
          ) : r.can.edit ? (
            <Button onClick={() => setSigning(true)}>Attach signed copy</Button>
          ) : null}
          <Link to={`/reports/${r.id}/form`} className="ad-btn-quiet">
            Funder's form
          </Link>
          {r.can.reopen && (
            <Button
              onClick={() => run(() => api.post(`/reports/${r.id}/reopen`), 'Reopened as a draft.')}
              disabled={busy}
            >
              Reopen as draft
            </Button>
          )}
          {r.can.review && (
            <Button kind="primary" onClick={() => setReviewing(true)}>
              Record the funder's decision
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
        </div>
      </div>

      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
      {r.status === 'denied' && r.deniedReason && (
        <Notice tone="danger">
          <b>Denied for payment:</b> {r.deniedReason}
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
          note={blockers.length ? 'Fix before submitting' : 'Nothing blocks submission'}
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

      <div className="grid gap-4 lg:grid-cols-3">
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
          {r.checks.length === 0 && <Empty>Every rule passes. Ready for the funder.</Empty>}
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
                    <td
                      className={`ad-num ${l.remaining < 0 ? 'font-bold text-danger' : 'text-soft'}`}
                    >
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
      </div>

      <Card
        className="mt-4"
        title="Ledger"
        aside={
          r.can.edit && (
            <Button kind="primary" onClick={() => setEditing('new')} data-testid="add-expense">
              + Add expense
            </Button>
          )
        }
      >
        {r.expenses.length === 0 && <Empty>No expenses yet.</Empty>}
        {r.expenses.length > 0 && (
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
                {r.expenses.map((e) => {
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
                      </td>
                      <td>
                        {REPORT_LINE_LABELS[e.reportLine]}
                        {e.allocationType !== 'direct' && (
                          <span className="ad-table-sub">
                            allocated by{' '}
                            {e.allocationType === 'payroll' ? 'payroll hours' : 'usage'}
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
                          <Button kind="ghost" onClick={() => setEditing(e)}>
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

      {editing && (
        <ExpenseModal
          expense={editing === 'new' ? null : editing}
          period={r.period}
          onClose={() => setEditing(null)}
          onSave={async (input) => {
            if (editing === 'new') await api.post(`/reports/${r.id}/expenses`, input)
            else await api.patch(`/expenses/${editing.id}`, input)
            setEditing(null)
            await reload()
          }}
        />
      )}
      {attach && (
        <AttachModal
          title={
            attach.kind === 'expense'
              ? `${attach.expense.itemNumber} ${attach.expense.vendor}: ${attach.purpose}`
              : `${attach.payment.participantName}: ${attach.purpose}`
          }
          workspaceId={r.engagement.workspace.id}
          engagementId={r.engagement.id}
          period={r.period}
          defaultKind={KINDS_FOR[attach.purpose][0]}
          kinds={KINDS_FOR[attach.purpose]}
          onClose={() => setAttach(null)}
          onPick={async (documentId) => {
            if (attach.kind === 'expense')
              await api.post(`/expenses/${attach.expense.id}/documents`, {
                documentId,
                purpose: attach.purpose,
              })
            else
              await api.post(`/wex/${attach.payment.id}/documents`, {
                documentId,
                purpose: attach.purpose,
              })
            setAttach(null)
            await reload()
            setNotice({ tone: 'ok', text: `Attached ${attach.purpose}.` })
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
          onPick={async () => {
            setSigning(false)
            await reload()
            setNotice({ tone: 'ok', text: 'Signed copy on file.' })
          }}
        />
      )}
      {reviewing && (
        <ReviewModal
          report={r}
          onClose={() => setReviewing(false)}
          onDecide={async (body) => {
            await api.post(`/reports/${r.id}/review`, body)
            setReviewing(false)
            await reload()
            setNotice({
              tone: 'ok',
              text:
                body.decision === 'approve'
                  ? `${periodLabel(r.period)} recorded as approved for payment.`
                  : `${periodLabel(r.period)} recorded as denied.`,
            })
          }}
        />
      )}
    </>
  )
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

function ExpenseModal({
  expense,
  period,
  onClose,
  onSave,
}: {
  expense: ExpenseDto | null
  period: string
  onClose: () => void
  onSave: (input: ExpenseInput) => Promise<void>
}) {
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
      reportLine: 'program-costs',
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
    <Modal title={expense ? `Edit ${expense.itemNumber}` : 'Add an expense'} onClose={onClose}>
      <form onSubmit={save} className="grid gap-4 sm:grid-cols-2">
        {error && (
          <div className="sm:col-span-2">
            <ErrorNote message={error} />
          </div>
        )}
        <Field label="Item number">
          <input
            ref={first}
            className={inputClass}
            value={form.itemNumber}
            onChange={(e) => set('itemNumber', e.target.value)}
            required
            data-testid="f-item"
          />
        </Field>
        <Field label="Date">
          <input
            type="date"
            className={inputClass}
            value={form.date}
            onChange={(e) => set('date', e.target.value)}
            required
            data-testid="f-date"
          />
        </Field>
        <Field label="Vendor" className="sm:col-span-2">
          <input
            className={inputClass}
            value={form.vendor}
            onChange={(e) => set('vendor', e.target.value)}
            required
            data-testid="f-vendor"
          />
        </Field>
        <Field label="Memo" className="sm:col-span-2">
          <input
            className={inputClass}
            value={form.memo ?? ''}
            onChange={(e) => set('memo', e.target.value)}
            data-testid="f-memo"
          />
        </Field>
        <Field label="Account (general ledger)">
          <input
            className={inputClass}
            value={form.account ?? ''}
            onChange={(e) => set('account', e.target.value)}
          />
        </Field>
        <Field label="Report line">
          <select
            className={inputClass}
            value={form.reportLine}
            onChange={(e) => set('reportLine', e.target.value as ExpenseInput['reportLine'])}
            data-testid="f-line"
          >
            {REPORT_LINES.map((l) => (
              <option key={l} value={l}>
                {REPORT_LINE_LABELS[l]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Total cost">
          <input
            type="number"
            step="0.01"
            min="0"
            className={inputClass}
            value={form.totalCost}
            onChange={(e) => set('totalCost', Number(e.target.value))}
            required
            data-testid="f-total"
          />
        </Field>
        <Field label="Allocation">
          <select
            className={inputClass}
            value={form.allocationType}
            onChange={(e) =>
              set('allocationType', e.target.value as ExpenseInput['allocationType'])
            }
          >
            {ALLOCATION_TYPES.map((t) => (
              <option key={t} value={t}>
                {t === 'direct'
                  ? 'Direct (all of it)'
                  : t === 'payroll'
                    ? 'Shared, by payroll hours'
                    : 'Shared, by usage'}
              </option>
            ))}
          </select>
        </Field>
        {form.allocationType !== 'direct' && (
          <>
            <Field label="Amount charged to this program">
              <input
                type="number"
                step="0.01"
                min="0"
                className={inputClass}
                value={form.allocatedAmount}
                onChange={(e) => set('allocatedAmount', Number(e.target.value))}
                required
              />
            </Field>
            <Field label="Allocation note" hint="e.g. 18.5% of payroll hours">
              <input
                className={inputClass}
                value={form.allocationNote ?? ''}
                onChange={(e) => set('allocationNote', e.target.value)}
              />
            </Field>
          </>
        )}
        <div className="mt-2 flex justify-end gap-2 sm:col-span-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" kind="primary" disabled={busy} data-testid="f-save">
            {expense ? 'Save' : 'Add expense'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

/** The funder's review steps, in neutral words; a funder's own checklist is a per-workspace list later. */
const CHECKLIST: [keyof ReportReview, string][] = [
  ['newServicesEntered', 'Services for the period are entered in the case system'],
  ['newEnrollmentsEntered', 'New enrollments for the period are entered'],
  ['servicesInProgress', 'Services in progress for the period were reviewed'],
  ['caseNotesChecked', 'A sample of case notes confirms services were delivered'],
  ['fileReviewCompleted', 'A file review or desk audit supports the services billed'],
  ['siteVisitConducted', 'A site visit during the period observed service delivery'],
]

function ReviewModal({
  report,
  onClose,
  onDecide,
}: {
  report: ReportDetail
  onClose: () => void
  onDecide: (body: {
    decision: 'approve' | 'deny'
    reason?: string
    review: ReportReview
  }) => Promise<void>
}) {
  const [review, setReview] = useState<ReportReview>({
    receivedOn: report.submittedAt?.slice(0, 10),
    ...(report.review ?? {}),
  })
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const decide = async (decision: 'approve' | 'deny') => {
    setBusy(true)
    setError(null)
    try {
      await onDecide({ decision, reason, review })
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }
  const blockers = report.checks.filter((k) => k.severity === 'blocker').length
  return (
    <Modal
      title={`Record the funder's decision on ${periodLabel(report.period)}`}
      onClose={onClose}
    >
      <ErrorNote message={error} />
      <p className="mb-4 text-sm text-soft">
        What the funder sent back: the review section of the monthly report, the invoice number, and
        whether the month was approved for payment.{' '}
        {blockers > 0
          ? `${blockers} blocking check(s) are still open.`
          : 'No blocking checks are open.'}
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Received on">
          <input
            type="date"
            className={inputClass}
            value={review.receivedOn ?? ''}
            onChange={(e) => setReview({ ...review, receivedOn: e.target.value })}
          />
        </Field>
        <Field label="IV# for payment">
          <input
            className={inputClass}
            value={review.invoiceNumber ?? ''}
            onChange={(e) => setReview({ ...review, invoiceNumber: e.target.value })}
          />
        </Field>
      </div>
      <ul className="mt-4 space-y-2">
        {CHECKLIST.map(([key, label]) => (
          <li key={key}>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={!!review[key]}
                onChange={(e) => setReview({ ...review, [key]: e.target.checked })}
              />
              <span>{label}</span>
            </label>
          </li>
        ))}
      </ul>
      <Field label="If denied, why" className="mt-4">
        <textarea
          className={inputClass}
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </Field>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button kind="danger" onClick={() => decide('deny')} disabled={busy || !reason.trim()}>
          Record as denied
        </Button>
        <Button
          kind="primary"
          onClick={() => decide('approve')}
          disabled={busy}
          data-testid="approve"
        >
          Record as approved
        </Button>
      </div>
    </Modal>
  )
}
