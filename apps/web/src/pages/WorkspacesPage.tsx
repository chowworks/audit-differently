import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ROLE_LABELS, type Role, type WorkspaceDetail, type WorkspaceDto } from '@ad/types'
import { useApi, useLoad } from '@/hooks/useApi'
import { Button, Empty, ErrorNote, Field, Modal, inputClass } from '@/components/ui'
import { HandCard } from '@/components/HandCard'

const roleLabel = (role: Role | null) => (role ? ROLE_LABELS[role] : null)

/** Every workspace this person belongs to. */
export function WorkspacesPage() {
  const { data, error, loading, reload } = useLoad<WorkspaceDto[]>('/workspaces')
  const [creating, setCreating] = useState(false)
  const navigate = useNavigate()
  return (
    <>
      <div className="ad-head">
        <div>
          <h1 className="ad-h1">Manage workspaces</h1>
          <p className="ad-sub">
            A workspace is your team's set of grants and contracts, the people who work on them, and
            the lists they share. What one person records, the whole team sees.
          </p>
        </div>
        <div className="ad-actions">
          <Button kind="primary" onClick={() => setCreating(true)}>
            + New workspace
          </Button>
        </div>
      </div>
      <ErrorNote message={error} />
      {loading && !data && <Empty>Loading…</Empty>}
      <div className="grid gap-4 lg:grid-cols-5">
        <div className="grid content-start gap-4 lg:col-span-3">
          {data?.length === 0 && <Empty>No workspace yet. Create the first one.</Empty>}
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
                      </Link>
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
      {creating && (
        <NewWorkspaceModal
          onClose={() => setCreating(false)}
          onCreated={async (w) => {
            setCreating(false)
            await reload()
            navigate(`/workspaces/${w.id}`)
          }}
        />
      )}
    </>
  )
}

function NewWorkspaceModal({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: (w: WorkspaceDetail) => void
}) {
  const api = useApi()
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const save = async (ev: React.FormEvent) => {
    ev.preventDefault()
    setBusy(true)
    setError(null)
    try {
      onCreated(await api.post<WorkspaceDetail>('/workspaces', { name }))
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }
  return (
    <Modal title="New workspace" onClose={onClose}>
      <form onSubmit={save} className="grid gap-4">
        <ErrorNote message={error} />
        <Field label="Workspace name" hint="Usually your organization's name">
          <input
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            autoFocus
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" kind="primary" disabled={busy || !name.trim()}>
            Create workspace
          </Button>
        </div>
      </form>
    </Modal>
  )
}
