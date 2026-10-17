import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  DOCUMENT_PURPOSE_LABELS,
  ALLOCATION_TYPE_LABELS,
  ALLOCATION_TYPES,
  PAYROLL_REPORT_LINES,
  REPORT_LINE_LABELS,
  type BudgetLineRow,
  type DocumentKind,
  type DocumentPurpose,
  type ExpenseDto,
  type ExpenseInput,
  type ParticipantDto,
  type ReportLine,
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
  inputClass,
} from '@/components/ui'
import { DocumentLink } from '@/components/DocumentLink'
import { AttachModal } from '@/components/AttachModal'
import { TagPicker } from '@/components/Tags'
import { ImportTransactionsModal } from '@/components/ImportTransactionsModal'
import { MatchReceipts } from '@/components/MatchReceipts'
import { FindLineModal, PayrollProof } from '@/components/PayrollProof'
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
  const [editingWex, setEditingWex] = useState<WexPaymentDto | null>(null)
  const [findingLine, setFindingLine] = useState<ExpenseDto | null>(null)
  const [attach, setAttach] = useState<Attach | null>(null)
  const [closing, setClosing] = useState<
    'approve' | 'send-back' | 'request-edits' | 'reopen' | null
  >(null)
  const [signing, setSigning] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null)
  const [highlight, setHighlight] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const navigate = useNavigate()

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

  /** An empty month: nothing to submit, so an owner deletes it, after a yes, and lands on its engagement. */
  const deleteMonth = async () => {
    if (
      !confirm(
        `Delete ${periodLabel(r.period)}? It has no expenses, no payroll and no files, so there is nothing to submit. You can start it again later.`
      )
    )
      return
    setBusy(true)
    try {
      const { engagementId } = await api.del<{ engagementId: string }>(`/reports/${r.id}`)
      navigate(`/engagements/${engagementId}`)
    } catch (e) {
      setNotice({ tone: 'danger', text: (e as Error).message })
      setBusy(false)
    }
  }

  const deletePayment = (w: WexPaymentDto) => {
    if (
      !confirm(
        `Remove ${w.participantName}'s pay (${money(w.grossAmount)}, ${w.payPeriodStart} to ${w.payPeriodEnd}) from ${periodLabel(r.period)}? Its proof stays filed under the month.`
      )
    )
      return
    void run(() => api.del<ReportDetail>(`/wex/${w.id}`), `${w.participantName}'s pay removed.`)
  }

  const receiptsCard = (
    <MatchReceipts
      report={r}
      onChange={setData}
      onNotice={(text) => setNotice({ tone: 'ok', text })}
    />
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
          lines={r.budgetLines}
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
      {editingWex && (
        <Modal
          title={`Edit ${editingWex.participantName}'s pay`}
          onClose={() => setEditingWex(null)}
        >
          <WexForm
            participants={r.participants}
            period={r.period}
            tagTypes={r.tagTypes}
            initial={{
              participantId: editingWex.participantId,
              payPeriodStart: editingWex.payPeriodStart.slice(0, 10),
              payPeriodEnd: editingWex.payPeriodEnd.slice(0, 10),
              hours: editingWex.hours,
              grossAmount: editingWex.grossAmount,
              tags: editingWex.tags,
            }}
            onClose={() => setEditingWex(null)}
            onSave={async (input) => {
              setData(await api.patch<ReportDetail>(`/wex/${editingWex.id}`, input))
              setEditingWex(null)
              setNotice({ tone: 'ok', text: `${editingWex.participantName}'s pay changed.` })
            }}
          />
        </Modal>
      )}
      {findingLine && (
        <FindLineModal
          item={{
            target: 'expense',
            id: findingLine.id,
            title: `${findingLine.itemNumber} ${findingLine.vendor}`,
          }}
          onClose={() => setFindingLine(null)}
          onLinked={(report) => {
            setData(report)
            setNotice({
              tone: 'ok',
              text: `Marked the bank statement line for ${findingLine.itemNumber}.`,
            })
            setFindingLine(null)
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

  return (
    <>
      <LayoutC
        r={r}
        busy={busy}
        notice={notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
        highlight={highlight}
        sections={{ receipts: receiptsCard, payrollProof: payrollProofCard, earlier }}
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
          editPayment: (w) => setEditingWex(w),
          deletePayment,
          findBankLine: (e) => setFindingLine(e),
          deleteMonth: () => void deleteMonth(),
        }}
      />
      {modals}
    </>
  )
}

type EntryKind = 'expense' | 'payroll'
const kindOf = (line: ReportLine): EntryKind =>
  PAYROLL_REPORT_LINES.has(line) ? 'payroll' : 'expense'

/** The engagement's budget lines a form offers: those of its own kind (payroll or not). */
const lineChoices = (kind: EntryKind, lines: BudgetLineRow[]) =>
  lines.filter((l) => kindOf(l.reportLine) === kind)

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
  lines: BudgetLineRow[]
  /** The engagement's participants: a payroll item may pay one of them (a work-experience payment). */
  participants: ParticipantDto[]
  onSaveWex: (input: WexPaymentInput) => Promise<void>
  period: string
  tagTypes: TagType[]
  onClose: () => void
  onSave: (input: ExpenseInput) => Promise<void>
}) {
  const choices = lineChoices(kind, lines)
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
      budgetLineId: choices.length === 1 ? choices[0]!.id : null,
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
                choices.length === 0
                  ? `This engagement has no ${payroll ? 'payroll' : 'expense'} budget line yet. Add one on its approved budget (step 4).`
                  : 'The line of the approved budget it is spent against'
              }
            >
              <select
                className={inputClass}
                value={form.budgetLineId ?? ''}
                onChange={(e) => set('budgetLineId', e.target.value || null)}
                required
                data-testid="f-line"
              >
                <option value="" disabled>
                  Choose a budget line
                </option>
                {choices.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name} · {REPORT_LINE_LABELS[l.reportLine]}
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
  initial,
  onClose,
  onSave,
}: {
  participants: ParticipantDto[]
  period: string
  tagTypes: TagType[]
  /** A payment being changed; none for a new one. */
  initial?: WexPaymentInput
  onClose: () => void
  onSave: (input: WexPaymentInput) => Promise<void>
}) {
  const [form, setForm] = useState<WexPaymentInput>(
    initial ?? {
      participantId: '',
      payPeriodStart: `${period}-01`,
      payPeriodEnd: `${period}-15`,
      hours: null,
      grossAmount: 0,
      tags: [],
    }
  )
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
        <span className="ad-req">*</span> Required.
        {!initial &&
          ' Next: attach the timesheet, payroll register and pay stub or deposit advice on its row.'}
      </p>
      <div className="flex justify-end gap-2">
        <Button type="button" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" kind="primary" disabled={busy || !participants.length}>
          {initial ? 'Save' : 'Add payroll'}
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
