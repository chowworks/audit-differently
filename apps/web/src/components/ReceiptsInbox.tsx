import { useEffect, useRef, useState } from 'react'
import {
  DISMISS_REASONS,
  DISMISS_REASON_LABELS,
  INBOUND_RECEIPT_STATUS_LABELS,
  type DismissReason,
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
        Owners and bookkeepers email receipts here from their own address. One address for the whole
        workspace.
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
 * The receipts inbox: every emailed receipt and what became of it, newest first. Owners and bookkeepers run a failed
 * one again, and file one that needs filing into the engagement and month they choose; an auditor reads.
 */
export function ReceiptsInbox({
  workspaceId,
  address,
  engagements,
}: {
  workspaceId: string
  /** The workspace's receipts email as the page has it, so a change shows here at once (the inbox's own is older). */
  address: string | null
  engagements: EngagementSummary[]
}) {
  const api = useApi()
  const { data, error, setData } = useLoad<ReceiptsInboxDto>(
    `/workspaces/${workspaceId}/receipts-inbox`
  )
  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [filing, setFiling] = useState<InboundReceiptDto | null>(null)
  const [dismissing, setDismissing] = useState<InboundReceiptDto | null>(null)
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
    <Card title="Receipts inbox">
      {!data.configured ? (
        <Notice tone="info">
          Email in receipts is not set up on this server yet: it needs the email provider connected
          first. Receipts that came in elsewhere still show below.
        </Notice>
      ) : address ? (
        <div className="mb-4">
          <HandCard
            title="Email receipts in"
            icon="📬"
            lead="Forward receipts to your workspace's email, with the engagement code in the subject."
          >
            <CopyPill label="Email" value={address} />
            <ol className="ad-hand-steps">
              <li>Send from the email you sign in with.</li>
              <li>Attach PDF, PNG or JPG files, up to 10 per email.</li>
              <li>
                Each is filed to its engagement's month; anything that can't be is listed here.
              </li>
            </ol>
          </HandCard>
        </div>
      ) : (
        <Notice tone="info">
          Not set up yet: an owner sets the receipts address under Workspace Settings.
        </Notice>
      )}
      <ErrorNote message={actionError} />
      {data.items.length === 0 ? (
        <p className="text-sm text-soft">No emailed receipts yet.</p>
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
                    {r.status === 'filed' && (
                      <span>
                        {r.documentCount} {r.documentCount === 1 ? 'file' : 'files'} in{' '}
                        {r.engagementName ?? 'an engagement'}
                      </span>
                    )}
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
                            <Button size="sm" kind="navy" onClick={() => setDismissing(r)}>
                              Dismiss
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

/** Files one emailed receipt that needs filing: the engagement and the month, a draft (started if it is not yet). */
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
  const [engagementId, setEngagementId] = useState(
    receipt.engagementId ?? (engagements.length === 1 ? engagements[0]!.id : '')
  )
  const [period, setPeriod] = useState(receipt.receivedAt.slice(0, 7))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const save = async (ev: React.FormEvent) => {
    ev.preventDefault()
    setBusy(true)
    setError(null)
    try {
      onFiled(
        await api.post<ReceiptsInboxDto>(`/inbound-receipts/${receipt.id}/file`, {
          engagementId,
          period,
        })
      )
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }
  return (
    <Modal title="File an emailed receipt" onClose={onClose}>
      <form onSubmit={save} className="grid gap-4">
        <p className="text-sm text-soft">
          {receipt.subject || '(no subject)'} · {receipt.fromAddress} ·{' '}
          {shortDate(receipt.receivedAt)}
        </p>
        <ErrorNote message={error} />
        <Field label="Engagement" required>
          <select
            className={inputClass}
            value={engagementId}
            onChange={(e) => setEngagementId(e.target.value)}
            required
          >
            <option value="">Choose…</option>
            {engagements.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.code ? ` (${c.code})` : ''}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Month"
          hint="A draft month within the contract; it is started if it is not yet."
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
        <div className="flex justify-end gap-2">
          <Button kind="ghost" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" kind="navy" disabled={busy || !engagementId || !period}>
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
    <Modal title="Dismiss this emailed receipt?" onClose={onClose}>
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
