/*
 * DESIGN EXPERIMENT (?layout=a|b|c on the month page): delete this folder, report-layouts.css, the layout switch in
 * ReportPage.tsx and the ReviewSwitch there once the owner picks one. See "Design experiments" in CLAUDE.md.
 *
 * What the three layouts share: the month's six steps worked out from the data, the single next action, the status
 * panel (who, when, why, what next) and the quiet "More" menu.
 */
import { useRef, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  DOCUMENT_PURPOSE_LABELS,
  type CheckCode,
  type CheckDto,
  type DocumentPurpose,
  type ExpenseDto,
  type ReportDetail,
  type WexPaymentDto,
} from '@ad/types'
import { money, periodLabel, shortDate } from '@/lib/format'
import { Button, StatusChip } from '@/components/ui'
import './report-layouts.css'

/** The page's own work, built in ReportPage and placed by each layout. */
export interface MonthSections {
  checks: ReactNode
  lines: ReactNode
  ledger: ReactNode
  receipts: ReactNode
  payroll: ReactNode
  payrollProof: ReactNode
  earlier: ReactNode
}

/** The page's actions: the same calls and modals as today. */
export interface MonthActions {
  addExpense: () => void
  addPayroll: () => void
  editExpense: (e: ExpenseDto) => void
  importTransactions: () => void
  attach: (e: ExpenseDto, purpose: DocumentPurpose) => void
  approve: () => void
  sendBack: () => void
  requestEdits: () => void
  reopen: () => void
  attachSigned: () => void
  submit: () => void
  downloadBundle: () => void
  deleteExpense: (e: ExpenseDto) => void
  attachPayment: (w: WexPaymentDto, purpose: DocumentPurpose) => void
  tagPayment: (w: WexPaymentDto) => void
}

export interface MonthLayoutProps {
  r: ReportDetail
  busy: boolean
  notice: ReactNode
  highlight: string | null
  sections: MonthSections
  act: MonthActions
}

export type StageKey = 'expenses' | 'proof' | 'blockers' | 'closing' | 'signed' | 'send'

export const STAGES: { key: StageKey; label: string }[] = [
  { key: 'expenses', label: 'Record Expenses & Payroll' },
  { key: 'proof', label: 'Attach Proof & Reconcile' },
  { key: 'blockers', label: 'Clear what blocks' },
  { key: 'closing', label: 'Approve Month End' },
  { key: 'signed', label: 'Sign & Finalize' },
  { key: 'send', label: 'Ship It' },
]

/** The blocking checks that a missing document causes, and the proof that clears each. */
export const PROOF_FOR: Partial<Record<CheckCode, DocumentPurpose>> = {
  'missing-invoice': 'invoice',
  'missing-proof-of-payment': 'payment',
  'missing-allocation': 'allocation',
  'missing-timesheet': 'timesheet',
  'missing-register': 'register',
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** A missing piece of proof: the blocking check, its expense and the proof that clears it. */
export interface MissingProof {
  check: CheckDto
  expense: ExpenseDto
  purpose: DocumentPurpose
}

export interface MonthProgress {
  done: Record<StageKey, boolean>
  /** The first step not done; null once the month is sent and its signed copy is on file. */
  current: StageKey | null
  missing: MissingProof[]
  /** Blocking checks a document does not clear (an amount, a date, a duplicate). */
  otherBlockers: CheckDto[]
  blockers: CheckDto[]
  attention: CheckDto[]
  billed: number
}

/** Where the month stands, from its own data: the six steps in order, each done or not. */
export function progressOf(r: ReportDetail): MonthProgress {
  const blockers = r.checks.filter((k) => k.severity === 'blocker')
  const attention = r.checks.filter((k) => k.severity === 'attention')
  const missing: MissingProof[] = []
  const otherBlockers: CheckDto[] = []
  for (const k of blockers) {
    const purpose = PROOF_FOR[k.code]
    const expense = k.expenseId ? r.expenses.find((e) => e.id === k.expenseId) : undefined
    if (purpose && expense) missing.push({ check: k, expense, purpose })
    else otherBlockers.push(k)
  }
  const drafted = r.status === 'draft'
  const done: Record<StageKey, boolean> = {
    expenses: !drafted || r.expenses.length > 0 || r.wexPayments.length > 0,
    proof: !drafted || missing.length === 0,
    blockers: !drafted || otherBlockers.length === 0,
    closing: !drafted,
    signed: !!r.signedCopy,
    send: r.status === 'submitted',
  }
  const current = STAGES.find((s) => !done[s.key])?.key ?? null
  const billed = r.lines.reduce((t, l) => t + l.billedThisPeriod, 0)
  return { done, current, missing, otherBlockers, blockers, attention, billed }
}

/** How a step stands, in a few words, for a checklist or a stepper. */
export function stageNote(r: ReportDetail, p: MonthProgress, key: StageKey): string {
  switch (key) {
    case 'expenses':
      return r.expenses.length ? plural(r.expenses.length, 'expense') : 'none yet'
    case 'proof':
      return p.missing.length ? `${p.missing.length} missing` : 'all attached'
    case 'blockers':
      return p.otherBlockers.length ? `${p.otherBlockers.length} to fix` : 'nothing blocks'
    case 'closing':
      return r.status === 'draft' ? 'not approved' : `approved ${shortDate(r.authorizedAt)}`.trim()
    case 'signed':
      return r.signedCopy ? 'on file' : 'not on file'
    case 'send':
      return r.submittedAt ? `sent ${shortDate(r.submittedAt)}` : `due ${shortDate(r.dueDate)}`
  }
}

export const funderOf = (r: ReportDetail) => r.engagement.funder ?? 'the funder'

export const proofWords = (m: MissingProof) =>
  `${DOCUMENT_PURPOSE_LABELS[m.purpose].toLowerCase()} for ${m.expense.itemNumber}`

export interface NextAction {
  /** One plain sentence: what the month needs now. */
  sentence: string
  /** The button, when this person can do it. An auditor gets none. */
  label?: string
  onClick?: () => void
  stage: StageKey | null
}

/**
 * The single next thing to do. `showBlockers` is how this layout brings the blocking checks into view. A step the
 * person's role cannot do gets the sentence alone.
 */
export function nextActionOf(
  r: ReportDetail,
  p: MonthProgress,
  act: MonthActions,
  showBlockers: () => void
): NextAction {
  const month = periodLabel(r.period)
  const stage = p.current
  switch (stage) {
    case null:
      return {
        stage,
        sentence: `${month} is sent to ${funderOf(r)} and its signed copy is on file. Nothing is left to do.`,
      }
    case 'expenses':
      return {
        stage,
        sentence: `Nothing is recorded for ${month} yet. Type each expense, or import them from your accounting file.`,
        ...(r.can.edit && { label: 'Add the first expense', onClick: act.addExpense }),
      }
    case 'proof': {
      const first = p.missing[0]!
      return {
        stage,
        sentence: `${plural(p.missing.length, 'piece')} of proof ${p.missing.length === 1 ? 'is' : 'are'} missing. Each expense needs its invoice, proof of payment and, when it is shared, its allocation worksheet.`,
        ...(r.can.edit && {
          label: `Attach the ${proofWords(first)}`,
          onClick: () => act.attach(first.expense, first.purpose),
        }),
      }
    }
    case 'blockers':
      return {
        stage,
        sentence: `${plural(p.otherBlockers.length, 'problem')} ${p.otherBlockers.length === 1 ? 'blocks' : 'block'} the month-end closing. Correct ${p.otherBlockers.length === 1 ? 'it' : 'each one'}, then approve the closing.`,
        ...(r.can.edit && {
          label: `Clear ${plural(p.otherBlockers.length, 'blocking problem')}`,
          onClick: showBlockers,
        }),
      }
    case 'closing':
      return {
        stage,
        sentence: '🏁 Everything has been verified and cross-checked. Ready for final review.',
        ...(r.can.close && { label: 'Approve month-end closing', onClick: act.approve }),
      }
    case 'signed':
      return {
        stage,
        sentence:
          r.status === 'submitted'
            ? `${month} is sent, but its signed copy is not on file. Attach it.`
            : `The closing is approved. Sign the funder's form, then attach the signed copy.`,
        ...(r.can.attachSigned && { label: 'Sign & Finalize', onClick: act.attachSigned }),
      }
    case 'send':
      return {
        stage,
        sentence: `The signed copy is on file. Send ${month} to ${funderOf(r)} by ${shortDate(r.dueDate)}.`,
        ...(r.can.submit && { label: `Send it to ${funderOf(r)}`, onClick: act.submit }),
      }
  }
}

/** The one green button on the screen. */
export function NextButton({ next, busy }: { next: NextAction; busy: boolean }) {
  if (!next.label || !next.onClick) return null
  return (
    <Button kind="primary" className="rl-next" onClick={next.onClick} disabled={busy}>
      {next.label}
    </Button>
  )
}

/** A date and time as the person reads it, in their own time zone: Oct 16, 2026, 3:05 PM. */
const dateTime = (iso: string) =>
  new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })

/** A date and time in a sentence: Oct 16, 2026 at 1:35 AM. */
const atTime = (iso: string) => dateTime(iso).replace(/, (\d+:\d\d)/, ' at $1')

/** The reasons a change writes by itself (the budget or an eligibility file changed), read after "because". */
const AUTOMATIC =
  /^(?:sent back because )?((?:the approved budget|a participant's eligibility file) changed.*)$/i

/** The end of a status sentence: "because the approved budget changed on …." or ': "the person's words".' */
function becauseOf(reason: string) {
  const words = reason.trim().replace(/[.\s]+$/, '')
  const auto = AUTOMATIC.exec(words)?.[1]
  return auto ? ` because ${auto[0]!.toLowerCase()}${auto.slice(1)}.` : `: \u201c${words}\u201d.`
}

/**
 * The month's status, when something happened to it: reopened to correct, edits requested, closing sent back,
 * closing approved, sent. One calm card: an emoji and a heading, one sentence with who, when and why, and what to do
 * next. Red only while something blocks the month.
 */
export function StatusPanel({ r }: { r: ReportDetail }) {
  const reopening = r.reopenings[0]
  const blocked = r.checks.some((k) => k.severity === 'blocker')
  let tone: 'calm' | 'ok' | 'danger' = 'calm'
  let icon: string
  let heading: string
  let sentence: string
  let next: string | null
  // The person's own words (edits requested, sent back by hand), quoted on their own under who and when.
  let quote: string | null = null
  const editsNewer = !!r.editsRequestedAt && (!r.sentBackAt || r.editsRequestedAt > r.sentBackAt)
  if (r.status === 'draft' && r.editsRequestedAt && r.editsRequestComment && editsNewer) {
    icon = '\u270f\ufe0f'
    heading = 'Edits requested'
    sentence = `${r.editsRequestedBy ?? 'Someone'} asked for edits on ${atTime(r.editsRequestedAt)}`
    quote = r.editsRequestComment.trim()
    next = 'Make the edits. Ask the approver to review.'
  } else if (r.status === 'draft' && r.sentBackReason) {
    const auto = AUTOMATIC.test(r.sentBackReason.trim())
    icon = auto ? '\u21a9\ufe0f' : '\u270f\ufe0f'
    heading = auto ? 'Closing sent back' : 'Edits requested'
    const who = r.sentBackBy ?? 'Someone'
    const when = r.sentBackAt ? ` on ${atTime(r.sentBackAt)}` : ''
    sentence = auto
      ? `${who} sent the approved closing back${when}${becauseOf(r.sentBackReason)}`
      : `${who} asked for edits${when} and sent the approved closing back`
    if (!auto) quote = r.sentBackReason.trim()
    next = auto
      ? 'Correct the month, then approve its month-end closing again.'
      : 'Make the edits. Ask the approver to review.'
  } else if (r.status === 'draft' && reopening) {
    icon = '\u21a9\ufe0f'
    heading = 'Reopened to correct'
    sentence = `${reopening.reopenedBy} reopened it on ${atTime(reopening.reopenedAt)}${becauseOf(reopening.reason)}`
    next =
      'Correct the month, approve its closing again, attach the corrected signed copy and send it again.'
  } else if (r.status === 'closed') {
    tone = 'ok'
    icon = '\u2705'
    heading = 'Closing approved'
    sentence = `${r.authorizedByName ?? 'Someone'} approved the month-end closing${r.authorizedAt ? ` on ${shortDate(r.authorizedAt)}` : ''}${r.closingNote ? becauseOf(r.closingNote).replace(/^:/, ', noting:') : '.'}`
    next = r.signedCopy
      ? `The ledger is locked. Send it to ${funderOf(r)}.`
      : "The ledger is locked. Sign the funder's form, attach the signed copy and send it."
  } else if (r.status === 'submitted') {
    tone = 'ok'
    icon = '\ud83d\udce4'
    heading = `Sent to ${funderOf(r)}`
    sentence = `${r.preparedByName ?? 'Someone'} sent it${r.submittedAt ? ` on ${atTime(r.submittedAt)}` : ''}${r.authorizedByName ? `, with the closing approved by ${r.authorizedByName}${r.authorizedAt ? ` on ${shortDate(r.authorizedAt)}` : ''}` : ''}.`
    next = r.signedCopy ? null : 'Attach its signed copy: it is not on file yet.'
  } else return null
  if (blocked && r.status === 'draft') tone = 'danger'
  return (
    <section className={`rl-status rl-status-${tone}`} aria-label="Status of the month">
      <h2 className="rl-status-head">
        <span className="rl-status-icon" aria-hidden="true">
          {icon}
        </span>
        {heading}
      </h2>
      <p className={quote ? 'rl-status-meta' : 'rl-status-text'}>{sentence}</p>
      {quote && <blockquote className="rl-status-quote">{quote}</blockquote>}
      {next && (
        <p className="rl-status-next">
          <b>What to do next:</b> {next}
        </p>
      )}
    </section>
  )
}

/** The page's numbers, small and secondary. */
export function MonthFacts({ r, p }: { r: ReportDetail; p: MonthProgress }) {
  return (
    <dl className="rl-facts">
      <div>
        <dt>Billed</dt>
        <dd>{money(p.billed)}</dd>
      </div>
      <div>
        <dt>Expenses</dt>
        <dd>{r.expenses.length}</dd>
      </div>
      <div className={p.blockers.length ? 'rl-facts-warn' : undefined}>
        <dt>Blocking</dt>
        <dd>{p.blockers.length}</dd>
      </div>
      <div>
        <dt>Needs attention</dt>
        <dd>{p.attention.length}</dd>
      </div>
      <div>
        <dt>Due</dt>
        <dd>{shortDate(r.dueDate)}</dd>
      </div>
    </dl>
  )
}

/** Breadcrumbs, the month's name and engagement, its numbers and its status panel. */
export function MonthHead({
  r,
  p,
  facts = true,
  children,
}: {
  r: ReportDetail
  p: MonthProgress
  /** false when the layout shows the numbers itself (C's tiles). */
  facts?: boolean
  children?: ReactNode
}) {
  return (
    <>
      <nav className="ad-crumbs" aria-label="Breadcrumb">
        <Link to={`/workspaces/${r.engagement.workspace.id}`}>{r.engagement.workspace.name}</Link> /{' '}
        <Link to={`/engagements/${r.engagement.id}`} className="ad-mono">
          {r.engagement.number}
        </Link>{' '}
        / {periodLabel(r.period)}
      </nav>
      <div className="rl-head">
        <div className="min-w-0">
          <h1 className="ad-h1 flex flex-wrap items-center gap-3">
            {periodLabel(r.period)} <StatusChip status={r.status} />
          </h1>
          <p className="ad-sub !mt-1">
            <span className="ad-mono">{r.engagement.number}</span> · {r.engagement.name}
          </p>
          {facts && <MonthFacts r={r} p={p} />}
        </div>
        {children && <div className="ad-actions">{children}</div>}
      </div>
      <StatusPanel r={r} />
    </>
  )
}

export interface MoreItem {
  label: string
  onClick?: () => void
  to?: string
  title?: string
}

/**
 * The page's other actions, out of the way: the bundle, the funder's form, import, send back, reopen, and the
 * steps that are not the next one. `skip` leaves out the one the layout already shows as its button.
 */
export function moreItems(r: ReportDetail, act: MonthActions, skip: string[] = []): MoreItem[] {
  const items: (MoreItem & { key: string })[] = [
    {
      key: 'bundle',
      label: "Download the month's bundle",
      onClick: act.downloadBundle,
      title:
        'The signed report, the ledger summary and the supporting records in one zip, to send with the invoice. Personal records are never in it.',
    },
    { key: 'form', label: "Open the funder's form", to: `/reports/${r.id}/form` },
  ]
  if (r.can.edit) {
    items.push({ key: 'add', label: 'Add an expense', onClick: act.addExpense })
    items.push({ key: 'import', label: 'Import transactions', onClick: act.importTransactions })
  }
  if (r.can.attachSigned)
    items.push({ key: 'signed', label: 'Sign & Finalize', onClick: act.attachSigned })
  if (r.can.submit)
    items.push({
      key: 'submit',
      label: r.signedCopy ? `Send it to ${funderOf(r)}` : 'Send it without the signed copy',
      onClick: act.submit,
    })
  if (r.can.sendBack)
    items.push({ key: 'send-back', label: 'Send back the closing', onClick: act.sendBack })
  if (r.can.reopen)
    items.push({
      key: 'reopen',
      label: 'Reopen to correct',
      onClick: act.reopen,
      title: 'Make it a draft again to correct it, then approve the closing and submit it again',
    })
  return items.filter((i) => !skip.includes(i.key))
}

/** Which More item a next action already is, so the menu does not repeat it. */
export const skipFor = (next: NextAction): string[] =>
  !next.label
    ? []
    : next.stage === 'expenses'
      ? ['add']
      : next.stage === 'signed'
        ? ['signed']
        : next.stage === 'send'
          ? ['submit']
          : []

/** A quiet "More" menu. */
export function MoreMenu({ items, busy }: { items: MoreItem[]; busy: boolean }) {
  const ref = useRef<HTMLDetailsElement>(null)
  if (!items.length) return null
  const close = () => ref.current?.removeAttribute('open')
  return (
    <details className="rl-more" ref={ref}>
      <summary className="ad-btn-quiet">More ▾</summary>
      <ul role="menu">
        {items.map((i) => (
          <li key={i.label} role="none">
            {i.to ? (
              <Link role="menuitem" to={i.to} title={i.title} onClick={close}>
                {i.label}
              </Link>
            ) : (
              <button
                role="menuitem"
                type="button"
                title={i.title}
                disabled={busy}
                onClick={() => {
                  close()
                  i.onClick?.()
                }}
              >
                {i.label}
              </button>
            )}
          </li>
        ))}
      </ul>
    </details>
  )
}

/** Brings an expense row into view once the layout has shown the ledger (the check's "show" link). */
export function scrollToExpense(id: string | null) {
  if (id)
    document
      .getElementById(`expense-${id}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}
