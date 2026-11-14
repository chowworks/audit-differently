/*
 * Changing a month's rows: the expense and payroll forms, attaching a proof, finding a staff line's bank line, and
 * removing a row. The month page and the month end page both use it, so a row is changed the same way wherever it is
 * shown (owner's decision, 2026-11-14). On the month end page an owner's payroll proof is filed once for the
 * workspace, in File Management's payroll folders; everything else is filed under the row's engagement and month.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  DOCUMENT_PURPOSE_LABELS,
  ALLOCATION_TYPE_LABELS,
  ALLOCATION_TYPES,
  PAYROLL_DOCUMENT_KINDS,
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
  type ReportDetail,
  type TagType,
  type WexPaymentDto,
} from '@ad/types'
import { useApi } from '@/hooks/useApi'
import { money, periodLabel } from '@/lib/format'
import { Button, ErrorNote, Field, Modal, inputClass } from '@/components/ui'
import { AttachModal } from '@/components/AttachModal'
import { TagPicker } from '@/components/Tags'
import { FindLineModal } from '@/components/PayrollProof'

/** The document types that can stand as each kind of proof. */
export const KINDS_FOR: Record<DocumentPurpose, DocumentKind[]> = {
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

/** A row's dialogs on whichever page shows it: the month of the row they are open for travels with them. */
export interface RowEditing {
  /** The row actions for one month, for the grids. */
  forMonth: (r: ReportDetail) => {
    editExpense: (e: ExpenseDto) => void
    deleteExpense: (e: ExpenseDto) => void
    attach: (e: ExpenseDto, purpose: DocumentPurpose) => void
    attachPayment: (w: WexPaymentDto, purpose: DocumentPurpose) => void
    editPayment: (w: WexPaymentDto) => void
    deletePayment: (w: WexPaymentDto) => void
    findBankLine: (e: ExpenseDto) => void
    /** The new expense or payroll form ("+ Add expense", "+ Add payroll"). */
    add: (kind: EntryKind) => void
  }
  /** The open dialog, if any: rendered by the page. */
  modals: ReactNode
}

/**
 * The dialogs that change a month's rows. `onChange` takes the month as it now stands (each change answers with
 * it); `run` wraps a removal (the month page shows it busy); `atWorkspace` is the month end page, where an owner's
 * payroll proof is filed once for the workspace.
 */
export function useRowEditing({
  onChange,
  onNotice,
  run,
  atWorkspace = false,
}: {
  onChange: (r: ReportDetail) => void
  onNotice: (n: { tone: 'ok' | 'danger'; text: string }) => void
  run: (fn: () => Promise<ReportDetail>, ok: string) => void
  atWorkspace?: boolean
}): RowEditing {
  const api = useApi()
  const [editing, setEditing] = useState<{
    r: ReportDetail
    kind: EntryKind
    expense: ExpenseDto | null
  } | null>(null)
  const [editingWex, setEditingWex] = useState<{ r: ReportDetail; w: WexPaymentDto } | null>(null)
  const [findingLine, setFindingLine] = useState<{ r: ReportDetail; e: ExpenseDto } | null>(null)
  const [attach, setAttach] = useState<(Attach & { r: ReportDetail }) | null>(null)

  const forMonth: RowEditing['forMonth'] = (r) => ({
    editExpense: (e) => setEditing({ r, kind: kindOf(e.reportLine), expense: e }),
    add: (kind) => setEditing({ r, kind, expense: null }),
    deleteExpense: (e) => {
      if (
        !confirm(
          `Remove ${e.itemNumber} (${e.vendor}, ${money(e.allocatedAmount)}) from ${periodLabel(r.period)}?`
        )
      )
        return
      run(() => api.del<ReportDetail>(`/expenses/${e.id}`), `${e.itemNumber} removed.`)
    },
    deletePayment: (w) => {
      if (
        !confirm(
          `Remove ${w.participantName}'s pay (${money(w.grossAmount)}, ${w.payPeriodStart} to ${w.payPeriodEnd}) from ${periodLabel(r.period)}? Its proof stays filed under the month.`
        )
      )
        return
      run(() => api.del<ReportDetail>(`/wex/${w.id}`), `${w.participantName}'s pay removed.`)
    },
    attach: (expense, purpose) => setAttach({ r, kind: 'expense', expense, purpose }),
    attachPayment: (payment, purpose) => setAttach({ r, kind: 'wex', payment, purpose }),
    editPayment: (w) => setEditingWex({ r, w }),
    findBankLine: (e) => setFindingLine({ r, e }),
  })

  // On the month end page (owners only) a payroll proof goes to File Management's payroll folders, filed once for
  // the workspace and month; the API takes it there from an owner alone.
  const filedAt = (r: ReportDetail) => (kind: DocumentKind) =>
    atWorkspace && (PAYROLL_DOCUMENT_KINDS as readonly string[]).includes(kind)
      ? null
      : r.engagement.id

  const modals = (
    <>
      {editing && (
        <ExpenseModal
          kind={editing.kind}
          expense={editing.expense}
          lines={editing.r.budgetLines}
          participants={editing.r.participants}
          onSaveWex={async (input) => {
            onChange(await api.post<ReportDetail>(`/reports/${editing.r.id}/wex`, input))
            setEditing(null)
          }}
          period={editing.r.period}
          tagTypes={editing.r.tagTypes}
          onClose={() => setEditing(null)}
          onSave={async (input) => {
            onChange(
              editing.expense
                ? await api.patch<ReportDetail>(`/expenses/${editing.expense.id}`, input)
                : await api.post<ReportDetail>(`/reports/${editing.r.id}/expenses`, input)
            )
            setEditing(null)
          }}
        />
      )}
      {editingWex && (
        <Modal
          title={`Edit ${editingWex.w.participantName}'s pay`}
          onClose={() => setEditingWex(null)}
        >
          <WexForm
            participants={editingWex.r.participants}
            period={editingWex.r.period}
            tagTypes={editingWex.r.tagTypes}
            initial={{
              participantId: editingWex.w.participantId,
              payPeriodStart: editingWex.w.payPeriodStart.slice(0, 10),
              payPeriodEnd: editingWex.w.payPeriodEnd.slice(0, 10),
              hours: editingWex.w.hours,
              grossAmount: editingWex.w.grossAmount,
              tags: editingWex.w.tags,
            }}
            onClose={() => setEditingWex(null)}
            onSave={async (input) => {
              onChange(await api.patch<ReportDetail>(`/wex/${editingWex.w.id}`, input))
              setEditingWex(null)
              onNotice({ tone: 'ok', text: `${editingWex.w.participantName}'s pay changed.` })
            }}
          />
        </Modal>
      )}
      {findingLine && (
        <FindLineModal
          item={{
            target: 'expense',
            id: findingLine.e.id,
            title: `${findingLine.e.itemNumber} ${findingLine.e.vendor}`,
          }}
          onClose={() => setFindingLine(null)}
          onLinked={(report) => {
            onChange(report)
            onNotice({
              tone: 'ok',
              text: `Marked the bank statement line for ${findingLine.e.itemNumber}.`,
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
          workspaceId={attach.r.engagement.workspace.id}
          engagementId={attach.r.engagement.id}
          filedAt={filedAt(attach.r)}
          period={attach.r.period}
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
            onChange(report)
            onNotice({
              tone: 'ok',
              text: `Attached ${DOCUMENT_PURPOSE_LABELS[attach.purpose].toLowerCase()}.`,
            })
          }}
        />
      )}
    </>
  )
  return { forMonth, modals }
}

export type EntryKind = 'expense' | 'payroll'
export const kindOf = (line: ReportLine): EntryKind =>
  PAYROLL_REPORT_LINES.has(line) ? 'payroll' : 'expense'

/** The engagement's budget lines a form offers: those of its own kind (payroll or not). */
const lineChoices = (kind: EntryKind, lines: BudgetLineRow[]) =>
  lines.filter((l) => kindOf(l.reportLine) === kind)

export function ExpenseModal({
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
export function WexForm({
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
