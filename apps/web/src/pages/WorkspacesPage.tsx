import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ROLE_LABELS, type Role, type WorkspaceDto } from '@ad/types'
import { useLoad } from '@/hooks/useApi'
import { FullDemoChip, Empty, ErrorNote } from '@/components/ui'
import { DeleteModal } from '@/components/DeleteModal'
import { HandCard } from '@/components/HandCard'

const roleLabel = (role: Role | null) => (role ? ROLE_LABELS[role] : null)

/** Every workspace this person belongs to. A platform admin creates workspaces, on the Admin tools page. */
export function WorkspacesPage() {
  const { data, error, loading, reload } = useLoad<WorkspaceDto[]>('/workspaces')
  const [deleting, setDeleting] = useState<WorkspaceDto | null>(null)
  return (
    <>
      <div className="ad-head">
        <div>
          <h1 className="ad-h1">Workspace Manager</h1>
          <p className="ad-sub">
            A workspace is your team's set of grants and contracts, the people who work on them, and
            the lists they share. What one person records, the whole team sees.
          </p>
        </div>
      </div>
      <ErrorNote message={error} />
      {loading && !data && <Empty>Loading…</Empty>}
      <div className="grid gap-4 lg:grid-cols-5">
        <div className="grid content-start gap-4 lg:col-span-3">
          {data?.length === 0 && <Empty>No workspace yet.</Empty>}
          {data?.map((w) => (
            <section key={w.id} className="ad-card">
              <div className="ad-card-body ad-grant-card">
                <div className="ad-head !mb-0">
                  <div>
                    <h2 className="ad-card-title">
                      <Link
                        to={`/workspaces/${w.id}`}
                        className="text-navy no-underline hover:underline"
                      >
                        {w.name}
                      </Link>{' '}
                      {w.featuredDemo && <FullDemoChip />}
                    </h2>
                    <p className="mt-1 text-sm text-soft">
                      {w.engagementCount} engagement{w.engagementCount === 1 ? '' : 's'} ·{' '}
                      {w.memberCount} {w.memberCount === 1 ? 'person' : 'people'}
                    </p>
                  </div>
                  <div className="ad-actions">
                    {roleLabel(w.myRole) && (
                      <span className="text-sm text-soft">
                        Your role: <b className="text-ink">{roleLabel(w.myRole)}</b>
                      </span>
                    )}
                  </div>
                </div>
                <div className="ad-grant-foot">
                  <span className="text-soft">
                    {w.canManage ? 'You run this workspace.' : 'You work in this workspace.'}
                  </span>
                  <Link to={`/workspaces/${w.id}`} className="font-bold">
                    Open workspace →
                  </Link>
                </div>
                {w.myRole === 'owner' && (
                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      className="ad-quiet-delete"
                      onClick={() => setDeleting(w)}
                    >
                      Delete workspace…
                    </button>
                  </div>
                )}
              </div>
            </section>
          ))}
        </div>
        <div className="grid content-start gap-4 lg:col-span-2">
          <HandCard lead="One workspace per team.">
            <p>
              Everyone you invite sees the same records. Owners add staff and keep the lists,
              bookkeepers do the monthly work, and auditors read without changing anything.
            </p>
          </HandCard>
        </div>
      </div>
      {deleting && (
        <DeleteModal
          target={{ kind: 'workspace', id: deleting.id, name: deleting.name }}
          engagementsLeft={deleting.engagementCount}
          onClose={() => setDeleting(null)}
          onDeleted={async () => {
            setDeleting(null)
            await reload()
          }}
        />
      )}
    </>
  )
}
