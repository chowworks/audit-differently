import { useMemo, useState } from 'react'
import type { ActivityEntry } from '@ad/types'
import { useLoad } from '@/hooks/useApi'
import { Button, Empty, ErrorNote, Modal, inputClass } from '@/components/ui'

const ACTION_WORDS: Record<string, string> = {
  read: 'opened',
  list: 'listed',
  download: 'downloaded',
  create: 'added',
  update: 'changed',
  delete: 'removed',
  export: 'exported',
  submit: 'submitted',
  review: 'recorded a decision on',
}
const what = (a: ActivityEntry) =>
  a.resource === 'export'
    ? 'the audit package'
    : a.action === 'list'
      ? `${a.resource}s`
      : `a ${a.resource}`
const did = (a: ActivityEntry) => `${ACTION_WORDS[a.action] ?? a.action} ${what(a)}`
const when = (iso: string) =>
  new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })

/** The workspace's access log: who opened, listed, downloaded or exported what. Searchable; exports as CSV. */
export function ActivityModal({
  workspaceId,
  workspaceName,
  onClose,
}: {
  workspaceId: string
  workspaceName: string
  onClose: () => void
}) {
  const { data, error } = useLoad<ActivityEntry[]>(`/workspaces/${workspaceId}/activity`)
  const [q, setQ] = useState('')
  const rows = useMemo(() => {
    const all = data ?? []
    const needle = q.trim().toLowerCase()
    if (!needle) return all
    return all.filter((a) =>
      [a.actorName, did(a), a.detail ?? '', when(a.at)].join(' ').toLowerCase().includes(needle)
    )
  }, [data, q])
  const exportCsv = () => {
    const lines = [
      ['When', 'Who', 'Did', 'Detail'],
      ...rows.map((a) => [a.at, a.actorName, did(a), a.detail ?? '']),
    ]
    const csv = lines
      .map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))
      .join('\r\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${workspaceName} - access log.csv`
    a.click()
    URL.revokeObjectURL(url)
  }
  return (
    <Modal title="Access log" onClose={onClose} wide>
      <ErrorNote message={error} />
      <p className="mb-3 text-sm text-soft">
        Who opened, listed, downloaded or exported what, newest first. Nothing here can be edited or
        removed.
      </p>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          className={`${inputClass} max-w-xs`}
          placeholder="Search by person, action or record"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoFocus
        />
        <span className="text-xs text-soft">
          {rows.length} of {(data ?? []).length}
        </span>
        <span className="flex-1" />
        <Button size="sm" onClick={exportCsv} disabled={rows.length === 0}>
          Export CSV
        </Button>
      </div>
      {data && data.length === 0 && <Empty>Nothing yet.</Empty>}
      {data && data.length > 0 && rows.length === 0 && <Empty>Nothing matches.</Empty>}
      {rows.length > 0 && (
        <div className="ad-tablewrap max-h-[60vh] overflow-auto">
          <table className="ad-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>Did</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id}>
                  <td className="whitespace-nowrap">{when(a.at)}</td>
                  <td className="whitespace-nowrap">{a.actorName}</td>
                  <td>{did(a)}</td>
                  <td className="text-soft">{a.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  )
}
