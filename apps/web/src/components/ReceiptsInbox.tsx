import { Fragment, useEffect, useRef, useState } from 'react'
import {
  ALLOWED_UPLOAD_TYPES,
  DISMISS_REASONS,
  DOCUMENT_SENSITIVITY,
  DISMISS_REASON_LABELS,
  EMAILED_KINDS,
  EMAILED_KIND_WORDS,
  INBOUND_RECEIPT_STATUS_LABELS,
  emailedFolder,
  type DismissReason,
  type EmailedFileDto,
  type EmailedFilesDto,
  type EmailedKind,
  type EmailedMoveDto,
  RECEIPTS_ADDRESS_PATTERN,
  type EngagementSummary,
  type InboundReceiptDto,
  type InboundReceiptStatus,
  type ReceiptsInboxDto,
  type WorkspaceDetail,
} from '@ad/types'
import { useApi, useLoad } from '@/hooks/useApi'
import { ApiError } from '@/services/api'
import { shortDate } from '@/lib/format'
import { HandCard } from '@/components/HandCard'
import { CopyPill } from '@/components/MatchReceipts'
import {
  Button,
  Card,
  Chip,
  EmailText,
  Empty,
  ErrorNote,
  Field,
  Modal,
  Notice,
  inputClass,
  type Tone,
} from '@/components/ui'

/** The words a subject takes, from the folder list: receipts, timesheets, … (issue #82). */
const SUBJECT_WORDS = EMAILED_KINDS.map((k) => EMAILED_KIND_WORDS[k][0]!)

/** A month as the screens say it: 2026-10 is October 2026. */
const monthLabel = (period: string) =>
  new Date(`${period}-01T12:00:00Z`).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })

/** Where a filed email went, in the inbox's words. */
export function whereFiled(r: InboundReceiptDto): string {
  const files = `${r.documentCount} ${r.documentCount === 1 ? 'file' : 'files'}`
  if (r.kind && r.kind !== 'receipt')
    return `${files} in ${emailedFolder(r.kind).name}${r.period ? `, ${monthLabel(r.period)}` : ''}; an owner matches them`
  // A receipt filed to no engagement went to Month End Close's Receipts, where an owner matches it to the books' bills.
  if (r.kind === 'receipt' && !r.engagementId)
    return `${files} in ${emailedFolder('receipt').name}${r.period ? `, ${monthLabel(r.period)}` : ''}; an owner matches them`
  return `${files} in ${r.engagementName ?? 'an engagement'}`
}

/**
 * Move to…'s folders for one emailed file: every folder but its own, those that take its type, and for a personal
 * file (a pay stub, payroll details) only the personal ones, as File Management's Move to… offers them.
 */
export function moveOptions(
  f: Pick<EmailedFileDto, 'kind' | 'contentType' | 'personal'>
): EmailedKind[] {
  const ext = ALLOWED_UPLOAD_TYPES[f.contentType] ?? ''
  return EMAILED_KINDS.filter(
    (k) =>
      k !== f.kind &&
      emailedFolder(k).extensions.includes(ext) &&
      !(f.personal && DOCUMENT_SENSITIVITY[k] !== 'personal')
  )
}

const TONE: Record<InboundReceiptStatus, Tone> = {
  received: 'info',
  processing: 'info',
  filed: 'ok',
  unmatched: 'warn',
  rejected: 'danger',
  failed: 'danger',
  dismissed: 'muted',
}

/**
 * The workspace's receipts address. The domain is the environment's; an owner picks the part before the @, and may
 * change it later (never clear it): the old one is then refused and never used again unless a platform admin releases
 * it. Owners do not see past addresses. Platform admins see it read only.
 */
export function ReceiptsAddress({
  w,
  onChange,
}: {
  w: {
    id: string
    canManage: boolean
    receiptsAddress: string | null
    receiptsEmail: string | null
    /** Absent on the admin's page: the setting is the owners' alone. */
    readEmailedReceiptsWithAi?: boolean
    aiAvailable?: boolean
  }
  /** Called with the workspace as the save returned it, so every place showing the address updates at once. */
  onChange: (updated: WorkspaceDetail) => void | Promise<void>
}) {
  const api = useApi()
  const [local, setLocal] = useState('')
  const [error, setError] = useState<string | null>(null)
  // "That address isn't available": said under the field, not at the top (CLAUDE.md, "Something wrong in a form").
  const [taken, setTaken] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [changing, setChanging] = useState(false)
  const clean = local.trim().toLowerCase()
  const valid = !clean || RECEIPTS_ADDRESS_PATTERN.test(clean)
  const domain = w.receiptsEmail?.split('@')[1]
  const setAi = async (on: boolean) => {
    setBusy(true)
    setError(null)
    try {
      await onChange(
        await api.patch<WorkspaceDetail>(`/workspaces/${w.id}/lists`, {
          readEmailedReceiptsWithAi: on,
        })
      )
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const save = async (ev: React.FormEvent) => {
    ev.preventDefault()
    setBusy(true)
    setError(null)
    setTaken(null)
    try {
      await onChange(
        await api.patch<WorkspaceDetail>(`/workspaces/${w.id}/lists`, { receiptsAddress: clean })
      )
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setTaken(e.message)
      else setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card title="Receipts address">
      <p className="mb-3 text-sm text-soft">
        Owners and bookkeepers email receipts and payroll files here from their own address. One
        address for the whole workspace.
      </p>
      <ErrorNote message={error} />
      {w.receiptsAddress ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="ad-mono text-sm">{w.receiptsEmail ?? w.receiptsAddress}</p>
          {w.canManage && (
            <Button size="sm" kind="navy" onClick={() => setChanging(true)}>
              Change address
            </Button>
          )}
        </div>
      ) : w.canManage ? (
        <form onSubmit={save} className="flex flex-wrap items-center gap-2">
          <input
            className={`${inputClass} ad-mono max-w-xs`}
            aria-label="Receipts address, the part before the @"
            placeholder="your-team"
            value={local}
            maxLength={40}
            onChange={(e) => {
              setLocal(e.target.value)
              setTaken(null)
            }}
          />
          <span className="ad-mono text-sm text-soft">@{domain ?? 'your receipts domain'}</span>
          <Button type="submit" kind="navy" disabled={busy || !clean || !valid}>
            Save address
          </Button>
          {!valid || taken ? (
            <small className="ad-field-error w-full" role="alert">
              {taken ??
                '3 to 40 lowercase letters, digits and hyphens, starting and ending with a letter or digit.'}
            </small>
          ) : (
            <small className="w-full text-soft">
              Choose carefully: an address once used is never used again, by any workspace.
            </small>
          )}
        </form>
      ) : (
        <p className="text-sm">Not set yet. An owner sets it.</p>
      )}
      {w.aiAvailable && w.readEmailedReceiptsWithAi !== undefined && (
        <div className="ad-ai-optin mt-4">
          <span className="ad-ai-tag">✨ Optional AI Automation</span>
          {w.canManage ? (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={w.readEmailedReceiptsWithAi}
                disabled={busy}
                onChange={(e) => setAi(e.target.checked)}
              />
              Read emailed receipts with AI
            </label>
          ) : (
            <p className="text-sm">
              Read emailed receipts with AI: {w.readEmailedReceiptsWithAi ? 'on' : 'off'}. An owner
              changes it.
            </p>
          )}
          <small className="text-soft">
            Nobody is there to ask when a receipt is emailed in. When this is on, a receipt whose
            PDF text does not give the amount, date and vendor is sent to an AI model to read them.
            Off, you type what the text does not give.
          </small>
        </div>
      )}
      {changing && w.receiptsAddress && (
        <ChangeReceiptsAddress
          w={{ id: w.id, receiptsAddress: w.receiptsAddress, receiptsEmail: w.receiptsEmail }}
          domain={domain}
          onClose={() => setChanging(false)}
          onChanged={async (updated) => {
            setChanging(false)
            await onChange(updated)
          }}
        />
      )}
    </Card>
  )
}

/**
 * An owner changes the workspace's receipts address. The old one stops working at once: mail still sent to it is
 * refused, and it is never offered to any workspace again (unless a platform admin releases it).
 */
function ChangeReceiptsAddress({
  w,
  domain,
  onClose,
  onChanged,
}: {
  w: { id: string; receiptsAddress: string; receiptsEmail: string | null }
  domain: string | undefined
  onClose: () => void
  onChanged: (updated: WorkspaceDetail) => Promise<void>
}) {
  const api = useApi()
  const [local, setLocal] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [taken, setTaken] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  useEffect(() => field.current?.focus(), [])
  const clean = local.trim().toLowerCase()
  const fieldError = !clean
    ? null
    : taken
      ? taken
      : !RECEIPTS_ADDRESS_PATTERN.test(clean)
        ? '3 to 40 lowercase letters, digits and hyphens, starting and ending with a letter or digit.'
        : clean === w.receiptsAddress
          ? 'That is the address now.'
          : null
  const save = async (ev: React.FormEvent) => {
    ev.preventDefault()
    if (!clean || fieldError) return
    setBusy(true)
    setError(null)
    setTaken(null)
    try {
      await onChanged(
        await api.patch<WorkspaceDetail>(`/workspaces/${w.id}/lists`, { receiptsAddress: clean })
      )
    } catch (e) {
      // Taken, or kept as another's old address: said under the field. Anything else, at the top.
      if (e instanceof ApiError && e.status === 409) setTaken(e.message)
      else setError((e as Error).message)
      setBusy(false)
    }
  }
  return (
    <Modal title="Change the receipts address" onClose={onClose}>
      <form onSubmit={save} className="ad-change-address">
        <ErrorNote message={error} />
        <div className="ad-change-address-lead">
          <p>
            <strong>
              Mail to <span className="ad-mono">{w.receiptsEmail ?? w.receiptsAddress}</span> is
              refused from the moment you change it.
            </strong>
          </p>
          <ol>
            <li>Tell your owners and bookkeepers the new address.</li>
            <li>Ask vendors who send receipts there to use it too.</li>
            <li>The old address can't be chosen again, here or by anyone else.</li>
          </ol>
        </div>
        <Field label="New address, the part before the @" error={fieldError} required>
          <div className="ad-change-address-input">
            <input
              ref={field}
              className={`${inputClass} ad-mono`}
              placeholder="your-team"
              value={local}
              maxLength={40}
              onChange={(e) => {
                setLocal(e.target.value)
                setTaken(null)
              }}
            />
            <span className="ad-mono text-sm text-soft">@{domain ?? 'your receipts domain'}</span>
          </div>
        </Field>
        <div className="ad-change-address-foot">
          <Button kind="ghost" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" kind="navy" disabled={busy || !clean || !!fieldError}>
            Change address
          </Button>
        </div>
      </form>
    </Modal>
  )
}

/**
 * The emailed documents inbox: every emailed receipt or payroll file and what became of it, newest first. Owners and
 * bookkeepers run a failed one again, and file one that needs filing as what they say it is, into the month (and, for a
 * receipt, the engagement) they choose; an auditor reads.
 */
export function ReceiptsInbox({
  workspaceId,
  address,
  engagements,
  onChange,
}: {
  workspaceId: string
  /** The workspace's receipts email as the page has it, so a change shows here at once (the inbox's own is older). */
  address: string | null
  engagements: EngagementSummary[]
  /** After a receipt is filed, dismissed or run again: the page's owner actions count it again. */
  onChange?: () => void
}) {
  const api = useApi()
  const {
    data,
    error,
    setData: setInbox,
  } = useLoad<ReceiptsInboxDto>(`/workspaces/${workspaceId}/receipts-inbox`)
  const setData = (next: ReceiptsInboxDto) => {
    setInbox(next)
    onChange?.()
  }
  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [filing, setFiling] = useState<InboundReceiptDto | null>(null)
  const [dismissing, setDismissing] = useState<InboundReceiptDto | null>(null)
  const [moving, setMoving] = useState<InboundReceiptDto | null>(null)
  const [moved, setMoved] = useState<string | null>(null)
  if (error) return <ErrorNote message={error} />
  if (!data) return <Empty>Loading…</Empty>
  const runAgain = async (id: string) => {
    setBusy(id)
    setActionError(null)
    try {
      setData(await api.post<ReceiptsInboxDto>(`/inbound-receipts/${id}/run-again`))
    } catch (e) {
      setActionError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  return (
    <Card title="Emailed documents">
      {!data.configured ? (
        <Notice tone="info">
          Email in receipts is not set up on this server yet: it needs the email provider connected
          first. Receipts that came in elsewhere still show below.
        </Notice>
      ) : address ? (
        <div className="mb-4">
          <HandCard
            title="Email documents in"
            icon="📬"
            lead="Email receipts and payroll files in; one word in the subject says what they are."
          >
            <CopyPill label="Email" value={address} />
            <p className="ad-hand-address">
              <span className="ad-hand-address-label">Subject</span>
              <span className="ad-mono">&lt;word&gt; &lt;month&gt;</span>
            </p>
            <CopyPill label="Example subject" value="timesheets October" />
            <ol className="ad-hand-steps">
              <li>Send from the email you sign in with, up to 10 files per email.</li>
              <li>
                Subject word:{' '}
                {SUBJECT_WORDS.map((w, i) => (
                  <Fragment key={w}>
                    {i > 0 && ' '}
                    <code className="ad-hand-word">{w}</code>
                  </Fragment>
                ))}
                . No word: they're receipts. Add an engagement's code to file them on its month.
              </li>
              <li>Name the month, or they go in this month. We email you where they went.</li>
              <li>Never email eligibility records or contracts: upload those on the engagement.</li>
            </ol>
          </HandCard>
        </div>
      ) : (
        <Notice tone="info">
          Not set up yet: an owner sets the receipts address under Workspace Settings.
        </Notice>
      )}
      <ErrorNote message={actionError} />
      {moved && (
        <Notice tone="ok" fade>
          {moved}
        </Notice>
      )}
      {data.items.length === 0 ? (
        <p className="text-sm text-soft">Nothing emailed in yet.</p>
      ) : (
        <div className="ad-tablewrap">
          <table className="ad-table ad-table-fit">
            <thead>
              <tr>
                <th>Received</th>
                <th>From</th>
                <th>Subject</th>
                <th>Status</th>
                <th>What happened</th>
                {data.canManage && <th></th>}
              </tr>
            </thead>
            <tbody>
              {data.items.map((r) => (
                <tr key={r.id}>
                  <td className="whitespace-nowrap">{shortDate(r.receivedAt)}</td>
                  <td className="ad-mono text-xs">
                    {r.fromAddress ? <EmailText value={r.fromAddress} /> : '—'}
                  </td>
                  <td>{r.subject || <span className="text-soft">(no subject)</span>}</td>
                  <td>
                    <Chip tone={TONE[r.status]}>{INBOUND_RECEIPT_STATUS_LABELS[r.status]}</Chip>
                  </td>
                  <td className="text-sm">
                    {r.status === 'filed' && <span>{whereFiled(r)}</span>}
                    {r.reason && <span>{capitalize(r.reason)}</span>}
                    {r.error && <span className="ad-table-sub">{r.error}</span>}
                  </td>
                  {data.canManage && (
                    <td>
                      {/* Stacked, so the column stays narrow and the table fits its card. */}
                      <div className="ad-row-actions">
                        {r.status === 'unmatched' && (
                          <>
                            <Button size="sm" kind="navy" onClick={() => setFiling(r)}>
                              File it
                            </Button>
                          </>
                        )}
                        {(r.status === 'failed' || r.status === 'unmatched') && (
                          <Button
                            size="sm"
                            kind="navy"
                            disabled={busy === r.id}
                            onClick={() => runAgain(r.id)}
                          >
                            Run again
                          </Button>
                        )}
                        {(r.status === 'failed' || r.status === 'unmatched') && (
                          <Button size="sm" kind="navy" onClick={() => setDismissing(r)}>
                            Dismiss
                          </Button>
                        )}
                        {/* Whoever emailed it, or an owner, until an owner matched it: the server says which. */}
                        {r.status === 'filed' && r.documentCount > 0 && (
                          <Button size="sm" kind="navy" onClick={() => setMoving(r)}>
                            Move to…
                          </Button>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {dismissing && (
        <DismissModal
          receipt={dismissing}
          onClose={() => setDismissing(null)}
          onDismissed={(inbox) => {
            setData(inbox)
            setDismissing(null)
          }}
        />
      )}
      {moving && (
        <MoveModal
          workspaceId={workspaceId}
          receipt={moving}
          onClose={() => setMoving(null)}
          onMoved={(note) => {
            setMoved(note)
            setMoving(null)
          }}
        />
      )}
      {filing && (
        <FileModal
          receipt={filing}
          engagements={engagements}
          onClose={() => setFiling(null)}
          onFiled={(inbox) => {
            setData(inbox)
            setFiling(null)
          }}
        />
      )}
    </Card>
  )
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/**
 * Files one emailed document that needs filing: what it is (a receipt or one of the month's payroll folders), the month,
 * and a receipt's engagement (its month a draft, started if it is not yet). Starts from what the subject said.
 */
function FileModal({
  receipt,
  engagements,
  onClose,
  onFiled,
}: {
  receipt: InboundReceiptDto
  engagements: EngagementSummary[]
  onClose: () => void
  onFiled: (inbox: ReceiptsInboxDto) => void
}) {
  const api = useApi()
  const [kind, setKind] = useState<EmailedKind>(receipt.kind ?? 'receipt')
  const [engagementId, setEngagementId] = useState(
    receipt.engagementId ?? (engagements.length === 1 ? engagements[0]!.id : '')
  )
  const [period, setPeriod] = useState(receipt.period ?? receipt.receivedAt.slice(0, 7))
  const isReceipt = kind === 'receipt'
  const [error, setError] = useState<string | null>(null)
  // "Choose the engagement": a workspace that has never imported its books files receipts on an engagement only.
  const [engagementError, setEngagementError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const save = async (ev: React.FormEvent) => {
    ev.preventDefault()
    setBusy(true)
    setError(null)
    setEngagementError(null)
    try {
      onFiled(
        await api.post<ReceiptsInboxDto>(`/inbound-receipts/${receipt.id}/file`, {
          kind,
          ...(isReceipt && engagementId && { engagementId }),
          period,
        })
      )
    } catch (e) {
      const message = (e as Error).message
      if (isReceipt && !engagementId && /choose the engagement/i.test(message))
        setEngagementError(message)
      else setError(message)
      setBusy(false)
    }
  }
  return (
    <Modal title="File an emailed document" onClose={onClose}>
      <form onSubmit={save} className="grid gap-4">
        <p className="text-sm text-soft">
          {receipt.subject || '(no subject)'} · {receipt.fromAddress} ·{' '}
          {shortDate(receipt.receivedAt)}
        </p>
        <ErrorNote message={error} />
        <Field
          label="What is it"
          hint={
            receipt.kind
              ? `Read from the subject: ${emailedFolder(receipt.kind).name}${receipt.period ? `, ${monthLabel(receipt.period)}` : ''}.`
              : undefined
          }
          required
        >
          <select
            className={inputClass}
            value={kind}
            onChange={(e) => setKind(e.target.value as EmailedKind)}
            required
          >
            {EMAILED_KINDS.map((k) => (
              <option key={k} value={k}>
                {emailedFolder(k).name}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Month"
          hint={
            isReceipt
              ? 'A draft month within the contract; it is started if it is not yet.'
              : "Goes into this month's payroll files on Month End Close; an owner matches them."
          }
          required
        >
          <input
            type="month"
            className={inputClass}
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            required
          />
        </Field>
        {isReceipt && (
          <Field
            label="Engagement"
            hint="Leave it empty to file it in Month End Close's Receipts, where an owner matches it to the books' bills."
            error={engagementError}
          >
            <select
              className={inputClass}
              value={engagementId}
              onChange={(e) => {
                setEngagementId(e.target.value)
                setEngagementError(null)
              }}
            >
              <option value="">None: Month End Close's Receipts</option>
              {engagements.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.code ? ` (${c.code})` : ''}
                </option>
              ))}
            </select>
          </Field>
        )}
        <div className="flex justify-end gap-2">
          <Button kind="ghost" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" kind="navy" disabled={busy || !period}>
            File it
          </Button>
        </div>
      </form>
    </Modal>
  )
}

/** Puts aside a receipt that needs filing but should never be filed, with its reason; it leaves the inbox. */
function DismissModal({
  receipt,
  onClose,
  onDismissed,
}: {
  receipt: InboundReceiptDto
  onClose: () => void
  onDismissed: (inbox: ReceiptsInboxDto) => void
}) {
  const api = useApi()
  const [reason, setReason] = useState<DismissReason | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const dismiss = async (ev: React.FormEvent) => {
    ev.preventDefault()
    if (!reason) return
    setBusy(true)
    setError(null)
    try {
      onDismissed(
        await api.post<ReceiptsInboxDto>(`/inbound-receipts/${receipt.id}/dismiss`, { reason })
      )
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }
  return (
    <Modal title="Dismiss this emailed document?" onClose={onClose}>
      <form onSubmit={dismiss} className="grid gap-4">
        <ErrorNote message={error} />
        <p className="text-sm">
          {receipt.subject || '(no subject)'} · {receipt.fromAddress ?? 'unknown sender'}. It leaves
          the inbox and nothing is filed. The access log keeps who dismissed it and why.
        </p>
        <fieldset className="ad-field">
          <span>
            Why<i className="ad-req">*</i>
          </span>
          <div className="grid gap-2">
            {DISMISS_REASONS.map((r) => (
              <label key={r} className="inline-flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="reason"
                  checked={reason === r}
                  onChange={() => setReason(r)}
                />
                {DISMISS_REASON_LABELS[r]}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="flex justify-end gap-2">
          <Button type="button" kind="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" kind="navy" disabled={busy || !reason}>
            Dismiss
          </Button>
        </div>
      </form>
    </Modal>
  )
}

/**
 * Move to… on an emailed document: each file it filed, with the folder it goes to (whoever emailed it, or an owner,
 * until an owner matched it; owner's decision, 2026-11-17). A file that can't move says why instead of a choice.
 */
function MoveModal({
  workspaceId,
  receipt,
  onClose,
  onMoved,
}: {
  workspaceId: string
  receipt: InboundReceiptDto
  onClose: () => void
  onMoved: (note: string) => void
}) {
  const api = useApi()
  const { data, error: loadError } = useLoad<EmailedFilesDto>(
    `/workspaces/${workspaceId}/emailed/${receipt.id}/files`
  )
  const [files, setFiles] = useState<EmailedFileDto[] | null>(null)
  const [to, setTo] = useState<Record<string, EmailedKind | ''>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const shown = files ?? data?.files ?? null
  const chosen = (shown ?? []).filter((f) => !f.cannotMove && to[f.id])
  const go = async (ev: React.FormEvent) => {
    ev.preventDefault()
    if (!chosen.length) return
    setBusy(true)
    setError(null)
    const notes: string[] = []
    try {
      for (const f of chosen) {
        const done = await api.post<EmailedMoveDto>(
          `/workspaces/${workspaceId}/emailed/${receipt.id}/files/${f.id}/move`,
          { to: to[f.id] }
        )
        setFiles(done.files)
        notes.push(done.note)
      }
      onMoved(notes.join(' '))
    } catch (e) {
      // What moved before the refusal stays moved: the list shows where each file is now.
      setError((e as Error).message)
      setTo({})
      setBusy(false)
    }
  }
  return (
    <Modal title="Move emailed files" onClose={onClose}>
      <form onSubmit={go} className="grid gap-4">
        <p className="text-sm text-soft">
          {receipt.subject || '(no subject)'} · {shortDate(receipt.receivedAt)}
        </p>
        <ErrorNote message={loadError ?? error} />
        {!shown ? (
          <Empty>Loading…</Empty>
        ) : (
          shown.map((f) => {
            const options = moveOptions(f)
            const where = `In ${emailedFolder(f.kind).name}${f.period ? `, ${monthLabel(f.period)}` : ''}.`
            return (
              <Field
                key={f.id}
                label={f.fileName}
                hint={
                  f.cannotMove
                    ? `${where} ${f.cannotMove}.`
                    : options.length
                      ? where
                      : `${where} No other folder takes this file.`
                }
              >
                {!f.cannotMove && options.length > 0 && (
                  <select
                    className={inputClass}
                    aria-label={`Move ${f.fileName} to`}
                    value={to[f.id] ?? ''}
                    onChange={(e) => setTo({ ...to, [f.id]: e.target.value as EmailedKind | '' })}
                  >
                    <option value="">Leave it here</option>
                    {options.map((k) => (
                      <option key={k} value={k}>
                        {emailedFolder(k).name}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            )
          })
        )}
        <div className="flex justify-end gap-2">
          <Button kind="ghost" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button kind="navy" type="submit" disabled={busy || !chosen.length}>
            {busy ? 'Moving…' : 'Move'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
