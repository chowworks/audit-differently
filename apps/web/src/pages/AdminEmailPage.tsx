import { useEffect, useState } from 'react'
import {
  INBOUND_RECEIPT_STATUS_LABELS,
  type AdminInboundDto,
  type AdminInboundReceiptDto,
  type InboundReceiptStatus,
} from '@ad/types'
import { useApi, useLoad } from '@/hooks/useApi'
import { shortDate } from '@/lib/format'
import { Button, Card, Chip, Empty, ErrorNote, Notice, type Tone } from '@/components/ui'
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
}
const SIGN: Record<InboundReceiptStatus, string> = {
  received: '🔄',
  processing: '🔄',
  filed: '✅',
  unmatched: '📥',
  rejected: '⛔',
  failed: '⚠️',
}

/**
 * Admin tools → Email administration: the emailed receipts that reached no workspace, and a workspace's that were
 * refused or failed, with "Run again". Metadata only: no attachment and no message is ever shown here.
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
          <table className="ad-table">
            <thead>
              <tr>
                <th>Received</th>
                <th>To</th>
                <th>From</th>
                <th>Subject</th>
                <th>Status</th>
                <th>Why</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((r) => (
                <tr key={r.id}>
                  <td className="whitespace-nowrap">{shortDate(r.receivedAt)}</td>
                  <td className="ad-mono text-xs">
                    {r.toAddress ?? '—'}
                    <span className="ad-table-sub">{r.workspaceName ?? 'No workspace'}</span>
                  </td>
                  <td className="ad-mono text-xs">{r.fromAddress ?? '—'}</td>
                  <td>{r.subject || <span className="text-soft">(no subject)</span>}</td>
                  <td>
                    <Chip tone={TONE[r.status]} fill>
                      <span aria-hidden="true">{SIGN[r.status]}</span>{' '}
                      {INBOUND_RECEIPT_STATUS_LABELS[r.status]}
                    </Chip>
                    <span className="ad-table-sub">
                      {r.attempts} {r.attempts === 1 ? 'attempt' : 'attempts'}
                    </span>
                  </td>
                  <td className="text-sm">
                    {r.reason && <span>{capitalize(r.reason)}</span>}
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
      <Card title="Not filed" aside={controls}>
        {notices}
        {table}
        <AdminHow to="/admin/email" />
      </Card>
    </>
  )
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
