import { useParams } from 'react-router-dom'
import type { AdminWorkspaceDetail } from '@ad/types'
import { useLoad } from '@/hooks/useApi'
import { shortDate } from '@/lib/format'
import { Card, Empty, ErrorNote } from '@/components/ui'
import { BudgetItems, People, Rename, Tags } from '@/pages/WorkspacePage'
import { ReceiptsAddress } from '@/components/ReceiptsInbox'
import { AdminCrumbs } from '@/pages/AdminPage'

const BASE = '/admin/workspaces'

/**
 * One workspace as the platform admin sees it: its people and its lists, through the admin routes. Workspace level
 * only, on purpose: it fetches no engagement and no access log, and has no delete.
 */
export function AdminWorkspacePage() {
  const { id } = useParams()
  const { data, error, status, reload } = useLoad<AdminWorkspaceDetail>(id ? `${BASE}/${id}` : null)
  const crumbs = (here?: string) => <AdminCrumbs tool="Manage workspaces" to={BASE} here={here} />
  if (error)
    return (
      <>
        {crumbs()}
        <ErrorNote
          message={
            // The role is checked with Clerk on every request; it may have been taken away since the page loaded.
            status === 403 ? 'You are no longer a platform admin. Reload the page.' : error
          }
        />
      </>
    )
  if (!data)
    return (
      <>
        {crumbs()}
        <Empty>Loading…</Empty>
      </>
    )
  const w = { ...data, canManage: true }
  return (
    <>
      {crumbs(w.name)}
      <div className="ad-head">
        <div>
          <p className="ad-eyebrow">Workspace</p>
          <h1 className="ad-h1">{w.name}</h1>
          <p className="ad-sub">
            Created {shortDate(w.createdAt)} ·{' '}
            {w.termsAcceptedAt
              ? `Terms accepted by its first owner ${shortDate(w.termsAcceptedAt)}`
              : 'Terms not yet accepted by an owner'}
          </p>
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-4">
        <div className="grid content-start gap-4 lg:col-span-3">
          <People w={w} onChange={reload} base={BASE} findPeople />
          <Rename w={w} onChange={reload} base={BASE} />
          <ReceiptsAddress w={{ ...w, canManage: false }} onChange={reload} />
          <BudgetItems w={w} onChange={reload} base={BASE} />
          <Tags w={w} onChange={reload} base={BASE} />
          <Card title="Suggestions">
            {w.suggestions.length === 0 && <Empty>No suggestions yet.</Empty>}
            {w.suggestions.length > 0 && (
              <ul className="ad-rows">
                {w.suggestions.map((s) => (
                  <li key={s.id} className="ad-row">
                    <span className="ad-row-main">
                      <b>{s.text}</b>
                      <span>
                        {s.by} · {shortDate(s.createdAt)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  )
}
