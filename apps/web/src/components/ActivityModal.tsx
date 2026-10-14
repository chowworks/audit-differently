import { useMemo, useState } from 'react'
import type { ActivityEntry, LoggedChange } from '@ad/types'
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
/** What the person did, as the line says it; older lines without one are worded from their action. */
const did = (a: ActivityEntry) =>
  a.description ?? `${ACTION_WORDS[a.action] ?? a.action} ${what(a)}`
/** One changed field. A field logged by name alone (personal or free text) shows its name only. */
const changed = (c: LoggedChange) =>
  'before' in c && 'after' in c
    ? `${c.field}: ${c.before ?? 'blank'} → ${c.after ?? 'blank'}`
    : 'after' in c
      ? `${c.field}: ${c.after}`
      : 'before' in c
        ? `${c.field}: was ${c.before}`
        : c.field
const detail = (a: ActivityEntry) =>
  a.changes?.length ? a.changes.map(changed).join(' · ') : (a.detail ?? '')
const when = (iso: string) =>
  new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })

/**
 * One CSV cell. A cell a spreadsheet would read as a formula (it starts with =, +, -, @, a tab or a carriage
 * return) gets a leading apostrophe, so it opens as text; then it is quoted, with quotes doubled.
 */
export const csvCell = (v: unknown) => {
  const s = String(v ?? '')
  return `"${(/^[=+\-@\t\r]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`
}
export const toCsv = (rows: unknown[][]) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n')

/** How many changed fields a line shows before "and N more". */
const SHOWN = 3

/**
 * The Detail cell: at most three lines, and the first few changes with "and N more", which opens the rest. The full
 * text is also on hover. The CSV keeps it all.
 */
function Detail({ a }: { a: ActivityEntry }) {
  const [open, setOpen] = useState(false)
  const all = detail(a)
  const changes = a.changes ?? []
  const more = changes.length - SHOWN
  if (open) return <span>{all}</span>
  return (
    <span title={all}>
      <span className="line-clamp-3">
        {more > 0 ? changes.slice(0, SHOWN).map(changed).join(' · ') : all}
      </span>
      {more > 0 && (
        <button type="button" className="underline" onClick={() => setOpen(true)}>
          and {more} more
        </button>
      )}
    </span>
  )
}

/** The workspace's access log: who opened, listed, downloaded, exported or changed what. Searchable; exports as CSV. */
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
      [a.actorName, did(a), detail(a), when(a.at)].join(' ').toLowerCase().includes(needle)
    )
  }, [data, q])
  const exportCsv = () => {
    const csv = toCsv([
      ['When', 'Who (email)', 'Did', 'Detail'],
      ...rows.map((a) => [a.at, a.actorName, did(a), detail(a)]),
    ])
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
        Who opened, listed, downloaded, exported or changed what, newest first. People are named by
        their email. Amounts, dates, statuses and roles show what they changed from and to; personal
        details and free text show the field name only. Nothing here can be edited or removed.
      </p>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          className={`${inputClass} max-w-xs`}
          placeholder="Search by email, action or record"
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
                <th>Who (email)</th>
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
                  <td className="text-soft">
                    <Detail a={a} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  )
}
