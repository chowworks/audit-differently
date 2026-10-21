import { useEffect, useState } from 'react'
import {
  INBOUND_RECEIPT_STATUS_LABELS,
  type AdminInboundDto,
  type AdminInboundReceiptDto,
  type AdminReceiptsAddressDto,
  type AdminReceiptsAddressesDto,
  type InboundReceiptStatus,
  type ReleaseReceiptsAddressBody,
} from '@ad/types'
import { useApi, useLoad } from '@/hooks/useApi'
import { shortDate } from '@/lib/format'
import {
  Button,
  Card,
  Chip,
  EmailText,
  Empty,
  ErrorNote,
  Modal,
  Notice,
  type Tone,
} from '@/components/ui'
import { Icon, type IconName } from '@/components/icons'
import { AdminHow, AdminToolHead } from '@/pages/AdminPage'

// Solid chips, told apart by colour and a sign: waiting grey, failed amber (usually passing: run it again), refused red
// (a deliberate no).
const TONE: Record<InboundReceiptStatus, Tone> = {
  received: 'muted',
  processing: 'muted',
  filed: 'ok',
  unmatched: 'warn',
  rejected: 'danger',
  failed: 'warn',
  dismissed: 'muted',
}
const SIGN: Record<InboundReceiptStatus, string> = {
  received: '🔄',
  processing: '🔄',
  filed: '✅',
  unmatched: '📥',
  rejected: '⛔',
  failed: '⚠️',
  dismissed: '🗑️',
}

/**
 * Admin tools → Email administration: the emailed receipts that reached no workspace, and a workspace's that were
 * refused or failed, with "Run again"; then every receipts address used (GitHub issue #24). Metadata only: no
 * attachment and no message is ever shown here.
 */
export function AdminEmailPage() {
  const api = useApi()
  const { data, error, status, setData } = useLoad<AdminInboundDto>('/admin/inbound')
  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  // Refresh controls: the list reloads on Refresh, or on the period Auto-refresh names (every 30 seconds on each visit,
  // never remembered; paused while the tab is hidden). Run again turns it back on if someone set it to Off, so the
  // result shows up here. The list writes no access-log line, so reloading it records nothing.
  const [every, setEvery] = useState(30) // seconds; 0 is off
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  // Emails run again, with the status they had then, until the list shows what became of them.
  const [pending, setPending] = useState<Record<string, string>>({})
  const [outcome, setOutcome] = useState<string | null>(null)
  useEffect(() => {
    if (data && !updatedAt) setUpdatedAt(new Date())
  }, [data, updatedAt])
  const refresh = async () => {
    if (refreshing) return
    setRefreshing(true)
    try {
      const next = await api.get<AdminInboundDto>('/admin/inbound')
      setData(next)
      setUpdatedAt(new Date())
      const left = { ...pending }
      for (const id of Object.keys(pending)) {
        const row = next.items.find((x) => x.id === id)
        if (!row) {
          setOutcome(
            "Processed: it reached its workspace and left this list. Look for it in that workspace's Emailed receipts."
          )
          delete left[id]
        } else if (row.status === 'rejected' || row.status === 'failed') {
          setOutcome(
            `Processed again: ${INBOUND_RECEIPT_STATUS_LABELS[row.status].toLowerCase()}. The reason is on its row.`
          )
          delete left[id]
        }
      }
      setPending(left)
    } catch (e) {
      setActionError((e as Error).message)
    } finally {
      setRefreshing(false)
    }
  }
  useEffect(() => {
    if (!every) return
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, every * 1000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [every, pending])
  const runAgain = async (r: AdminInboundReceiptDto) => {
    if (!confirm('Run this email again with the current settings?')) return
    setBusy(r.id)
    setActionError(null)
    try {
      const updated = await api.post<AdminInboundReceiptDto>(`/admin/inbound/${r.id}/run-again`)
      setData((d) => d && { ...d, items: d.items.map((x) => (x.id === r.id ? updated : x)) })
      setPending((p) => ({ ...p, [r.id]: updated.status }))
      setEvery((e) => e || 30)
      setOutcome(
        'Back in the queue. The list refreshes on its own, so what becomes of it shows here.'
      )
    } catch (e) {
      setActionError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  const controls = (
    <div className="ad-refresh">
      {updatedAt && <span className="text-soft">Updated {updatedAt.toLocaleTimeString()}</span>}
      <Button kind="navy" size="sm" onClick={() => void refresh()} disabled={refreshing}>
        {refreshing ? 'Refreshing…' : 'Refresh'}
      </Button>
      <label className="ad-refresh-auto">
        Auto-refresh
        <select
          className="ad-refresh-select"
          value={every}
          onChange={(e) => setEvery(Number(e.target.value))}
        >
          <option value={0}>Off</option>
          <option value={10}>Every 10 seconds</option>
          <option value={30}>Every 30 seconds</option>
          <option value={60}>Every minute</option>
        </select>
      </label>
    </div>
  )
  const notices = (
    <>
      {outcome && <Notice tone="info">{outcome}</Notice>}
      <ErrorNote
        message={
          actionError ??
          (status === 403 ? 'You are no longer a platform admin. Reload the page.' : error)
        }
      />
    </>
  )
  const table = (
    <>
      {!data && !error && <Empty>Loading…</Empty>}
      {data?.items.length === 0 && <Empty>No email to look at.</Empty>}
      {!!data?.items.length && (
        <div className="ad-tablewrap">
          <table className="ad-table ad-table-fit">
            <thead>
              <tr>
                <th>Received</th>
                <th>Workspace</th>
                <th>To</th>
                <th>From</th>
                <th>Subject</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((r) => (
                <tr key={r.id}>
                  <td className="whitespace-nowrap">{shortDate(r.receivedAt)}</td>
                  <td>{r.workspaceName ?? <span className="text-soft">No workspace</span>}</td>
                  <td className="ad-mono text-xs">
                    {r.toAddress ? <EmailText value={r.toAddress} /> : '—'}
                  </td>
                  <td className="ad-mono text-xs">
                    {r.fromAddress ? <EmailText value={r.fromAddress} /> : '—'}
                  </td>
                  <td>{r.subject || <span className="text-soft">(no subject)</span>}</td>
                  <td>
                    <Chip tone={TONE[r.status]} fill>
                      <span aria-hidden="true">{SIGN[r.status]}</span>{' '}
                      {INBOUND_RECEIPT_STATUS_LABELS[r.status]}
                    </Chip>
                    <span className="ad-table-sub">
                      {r.attempts} {r.attempts === 1 ? 'attempt' : 'attempts'}
                    </span>
                    {r.reason && <span className="mt-1 block text-sm">{capitalize(r.reason)}</span>}
                    {r.error && <span className="ad-table-sub">{r.error}</span>}
                  </td>
                  <td className="whitespace-nowrap text-right">
                    {r.canRunAgain && (
                      <Button
                        kind="navy"
                        size="sm"
                        disabled={busy === r.id}
                        onClick={() => runAgain(r)}
                      >
                        Run again
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
  return (
    <>
      <AdminToolHead to="/admin/email" />
      <div className="ad-admin-sections">
        <section className="ad-admin-section">
          <SectionHead icon="mail" title="Emailed receipts" />
          <Card title="Not filed" aside={controls}>
            {notices}
            {table}
            <AdminHow to="/admin/email" />
          </Card>
        </section>
        <ReceiptsAddresses />
      </div>
    </>
  )
}

const ADDRESSES_HOW = (
  <>
    <p>
      <strong>An address a workspace stops using is held here, so nobody can choose it.</strong>
    </p>
    <ul>
      <li>When an owner changes the address, or a workspace is deleted, the old one is held.</li>
      <li>Mail still sent to it is refused and counted under Emails since removal.</li>
      <li>Release it once its mail has stopped; any workspace may then choose it.</li>
      <li>
        A current address is never released. A release is kept here, never shown to the workspace.
      </li>
    </ul>
  </>
)

/** The heading over a group of cards on this page, with the line under it that sets the sections apart. */
function SectionHead({ icon, title }: { icon: IconName; title: string }) {
  return (
    <div className="ad-section-head">
      <span className="ad-head-icon">
        <Icon name={icon} size={16} />
      </span>
      <h2>{title}</h2>
    </div>
  )
}

/** One workspace's previously used addresses; a deleted workspace's go under one "Deleted workspace" heading. */
type Group = { key: string; name: string; rows: AdminReceiptsAddressDto[] }

function groupByWorkspace(rows: AdminReceiptsAddressDto[]): Group[] {
  const groups = new Map<string, Group>()
  for (const r of rows) {
    const key = r.workspaceName == null ? 'deleted' : r.workspaceId
    const g = groups.get(key) ?? { key, name: r.workspaceName ?? 'Deleted workspace', rows: [] }
    g.rows.push(r)
    groups.set(key, g)
  }
  // By name; a deleted workspace's last. Each group keeps the API's order (not released first, newest removal first).
  return [...groups.values()].sort((a, b) =>
    a.key === 'deleted' ? 1 : b.key === 'deleted' ? -1 : a.name.localeCompare(b.name)
  )
}

/**
 * Email administration → Receipts addresses, in two cards: each workspace's address in use, and the addresses used
 * before, held and watched (the emails that still arrived since removal, all refused), grouped by workspace, so an
 * admin can judge whether one is safe to hand out again and release it. A current address is never released.
 */
function ReceiptsAddresses() {
  const api = useApi()
  const { data, error, status, setData } = useLoad<AdminReceiptsAddressesDto>(
    '/admin/receipts-addresses'
  )
  const [releasing, setReleasing] = useState<AdminReceiptsAddressDto | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const release = async (r: AdminReceiptsAddressDto) => {
    const body: ReleaseReceiptsAddressBody = { receivedSinceRemoval: r.receivedSinceRemoval }
    setData(
      await api.post<AdminReceiptsAddressesDto>(`/admin/receipts-addresses/${r.id}/release`, body)
    )
    setReleasing(null)
    setDone(`Released ${r.email ?? r.address}. Any workspace may choose it now.`)
  }
  const current = (data?.items ?? [])
    .filter((r) => !r.removedAt)
    .sort((a, b) => (a.workspaceName ?? '').localeCompare(b.workspaceName ?? ''))
  // An address in use again (released, then chosen) shows only as current: its released period is not listed.
  const inUse = new Set(current.map((r) => r.address))
  const previous = groupByWorkspace(
    (data?.items ?? []).filter((r) => r.removedAt && !inUse.has(r.address))
  )
  const loadError = (
    <ErrorNote
      message={status === 403 ? 'You are no longer a platform admin. Reload the page.' : error}
    />
  )
  return (
    <section className="ad-admin-section">
      <SectionHead icon="key" title="Receipts addresses" />
      <div className="ad-admin-cards">
        <Card title="Current addresses">
          {loadError}
          {!data && !error && <Empty>Loading…</Empty>}
          {data && current.length === 0 && (
            <Empty>No workspace has set a receipts address yet.</Empty>
          )}
          {current.length > 0 && (
            <div className="ad-tablewrap">
              <table className="ad-table ad-table-fit">
                <thead>
                  <tr>
                    <th>Workspace</th>
                    <th>Address</th>
                    <th>In use since</th>
                  </tr>
                </thead>
                <tbody>
                  {current.map((r) => (
                    <tr key={r.id}>
                      <td>{r.workspaceName ?? 'Deleted workspace'}</td>
                      <td className="ad-mono text-xs">
                        <EmailText value={r.email ?? r.address} />
                      </td>
                      <td className="whitespace-nowrap">{shortDate(r.firstUsedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card title="Previously used addresses">
          {done && (
            <Notice tone="ok" fade>
              {done}
            </Notice>
          )}
          {loadError}
          {!data && !error && <Empty>Loading…</Empty>}
          {data && previous.length === 0 && <Empty>No address has been changed yet.</Empty>}
          {previous.length > 0 && (
            <div className="ad-tablewrap">
              <table className="ad-table ad-table-fit">
                <thead>
                  <tr>
                    <th>Address</th>
                    <th>Removed</th>
                    <th className="text-right">Emails since removal</th>
                    <th>Last received</th>
                    <th></th>
                  </tr>
                </thead>
                {previous.map((g) => (
                  <tbody key={g.key}>
                    <tr className="ad-table-group">
                      <th colSpan={5} scope="colgroup">
                        {g.name}
                      </th>
                    </tr>
                    {g.rows.map((r) => (
                      <tr key={r.id}>
                        <td className="ad-mono text-xs">
                          <EmailText value={r.email ?? r.address} />
                        </td>
                        <td className="whitespace-nowrap">
                          {r.removedAt && shortDate(r.removedAt)}
                        </td>
                        <td className="text-right">
                          {r.releasedAt ? '—' : r.receivedSinceRemoval}
                        </td>
                        <td className="whitespace-nowrap">
                          {r.releasedAt
                            ? '—'
                            : r.lastReceivedAt
                              ? shortDate(r.lastReceivedAt)
                              : 'None'}
                        </td>
                        <td className="text-right">
                          {r.releasedAt ? (
                            <>
                              <Chip tone="muted" fill>
                                <span aria-hidden="true">🔓</span> Released
                              </Chip>
                              <span className="ad-table-sub">
                                {shortDate(r.releasedAt)}
                                {r.releasedByEmail && `, by ${r.releasedByEmail}`}
                              </span>
                            </>
                          ) : (
                            r.canRelease && (
                              <Button
                                kind="navy"
                                size="sm"
                                onClick={() => {
                                  setDone(null)
                                  setReleasing(r)
                                }}
                              >
                                Release
                              </Button>
                            )
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                ))}
              </table>
            </div>
          )}
          <AdminHow to="/admin/email" text={ADDRESSES_HOW} />
        </Card>
      </div>
      {releasing && (
        <ReleaseDialog
          address={releasing}
          onClose={() => setReleasing(null)}
          onRelease={() => release(releasing)}
        />
      )}
    </section>
  )
}

/**
 * The release confirm: which workspace and address, how much mail still reached it since it was removed and the
 * last, and what releasing means.
 */
function ReleaseDialog({
  address: r,
  onClose,
  onRelease,
}: {
  address: AdminReceiptsAddressDto
  onClose: () => void
  onRelease: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const n = r.receivedSinceRemoval
  const go = async () => {
    setBusy(true)
    setError(null)
    try {
      await onRelease()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }
  return (
    <Modal title="Release this address?" onClose={onClose}>
      <div className="grid gap-4">
        <ErrorNote message={error} />
        <dl className="ad-release-facts">
          <div>
            <dt>Workspace:</dt>
            <dd>{r.workspaceName ?? 'Deleted workspace'}</dd>
          </div>
          <div>
            <dt>Address:</dt>
            <dd className="ad-mono">{r.email ?? r.address}</dd>
          </div>
          {r.removedAt && (
            <div>
              <dt>Removed:</dt>
              <dd>{shortDate(r.removedAt)}</dd>
            </div>
          )}
        </dl>
        <p className="text-sm">
          <strong>
            {n === 0 || !r.lastReceivedAt
              ? 'No email has arrived since it was removed.'
              : `${n} ${n === 1 ? 'email has' : 'emails have'} arrived since it was removed, the last on ${shortDate(r.lastReceivedAt)}.`}
          </strong>
        </p>
        <p className="text-sm">
          Any workspace can then choose it, and mail sent to it lands there.
        </p>
        <div className="flex justify-end gap-2">
          <Button kind="ghost" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button kind="navy" disabled={busy} onClick={() => void go()}>
            Release address
          </Button>
        </div>
      </div>
    </Modal>
  )
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
