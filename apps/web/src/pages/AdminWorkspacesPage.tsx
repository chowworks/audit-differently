import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  ROLE_LABELS,
  type AdminWorkspaceDetail,
  type AdminWorkspaceDto,
  type CreateWorkspaceRequest,
} from '@ad/types'
import { useApi, useLoad } from '@/hooks/useApi'
import { ME_CHANGED_EVENT } from '@/services/api'
import { shortDate } from '@/lib/format'
import { Button, Card, Chip, Empty, ErrorNote, Field, Modal, inputClass } from '@/components/ui'
import { HandCard } from '@/components/HandCard'
import { AdminHow, AdminToolHead } from '@/pages/AdminPage'

/**
 * Admin tools → Manage workspaces: every workspace with its people, creating one for a customer, and the way into each
 * (/admin/workspaces/:id). Workspace level only: nothing here reads an engagement, a record or an access log.
 */
export function AdminWorkspacesPage() {
  return (
    <>
      <AdminToolHead to="/admin/workspaces" />
      <Workspaces />
    </>
  )
}

function Workspaces() {
  const { data, error, loading, reload } = useLoad<AdminWorkspaceDto[]>('/admin/workspaces')
  const [creating, setCreating] = useState(false)
  const navigate = useNavigate()
  return (
    <div className="grid gap-4 lg:grid-cols-4">
      <div className="lg:col-span-3">
        <Card
          title="Workspaces"
          aside={
            <Button kind="primary" size="sm" onClick={() => setCreating(true)}>
              + Create a workspace
            </Button>
          }
        >
          <ErrorNote message={error} />
          {loading && !data && <Empty>Loading…</Empty>}
          {data?.length === 0 && <Empty>No workspace yet. Create the first one.</Empty>}
          {!!data?.length && (
            <div className="ad-tablewrap">
              <table className="ad-table">
                <thead>
                  <tr>
                    <th>Workspace</th>
                    <th>People</th>
                  </tr>
                </thead>
                <tbody>
                  {data.map((w) => (
                    <tr key={w.id}>
                      <td>
                        <Link
                          to={`/admin/workspaces/${w.id}`}
                          className="font-bold text-navy no-underline hover:underline"
                        >
                          {w.name}
                        </Link>
                        <span className="ad-table-sub">
                          Created {shortDate(w.createdAt)} · {w.memberCount}{' '}
                          {w.memberCount === 1 ? 'person' : 'people'}
                          {!w.termsAcceptedAt && ' · Terms not yet accepted by an owner'}
                        </span>
                      </td>
                      <td>
                        <ul className="grid gap-1">
                          {w.members.map((m) => (
                            <li key={m.userId} className="text-sm">
                              {m.email ?? m.displayName}{' '}
                              <span className="text-soft">{ROLE_LABELS[m.role].toLowerCase()}</span>{' '}
                              {m.pending && (
                                <Chip tone="warn" fill>
                                  invited
                                </Chip>
                              )}
                            </li>
                          ))}
                        </ul>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <AdminHow to="/admin/workspaces" />
        </Card>
      </div>
      <div className="grid content-start gap-4">
        <HandCard lead="One workspace per customer.">
          <p>
            Name its first owner by email. They see the workspace when they first sign in with that
            address, accept the Terms, and invite their own team.
          </p>
        </HandCard>
      </div>
      {creating && (
        <CreateWorkspaceModal
          onClose={() => setCreating(false)}
          onCreated={async (w) => {
            setCreating(false)
            await reload()
            // An admin who named themself the first owner is now a member: the app asks /me again.
            window.dispatchEvent(new Event(ME_CHANGED_EVENT))
            navigate(`/admin/workspaces/${w.id}`)
          }}
        />
      )}
    </div>
  )
}

function CreateWorkspaceModal({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: (w: AdminWorkspaceDetail) => void
}) {
  const api = useApi()
  const [form, setForm] = useState<CreateWorkspaceRequest>({
    name: '',
    ownerEmail: '',
    ownerName: '',
  })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const set = (k: keyof CreateWorkspaceRequest) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [k]: e.target.value })
  const save = async (ev: React.FormEvent) => {
    ev.preventDefault()
    setBusy(true)
    setError(null)
    try {
      onCreated(await api.post<AdminWorkspaceDetail>('/workspaces', form))
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }
  return (
    <Modal title="Create a workspace" onClose={onClose}>
      <form onSubmit={save} className="grid gap-4">
        <ErrorNote message={error} />
        <Field label="Workspace name" hint="Usually the customer's organization name" required>
          <input
            className={inputClass}
            value={form.name}
            onChange={set('name')}
            required
            autoFocus
          />
        </Field>
        <Field
          label="First owner's email"
          hint="They sign in with this address and the workspace is waiting"
          required
        >
          <input
            type="email"
            className={inputClass}
            value={form.ownerEmail}
            onChange={set('ownerEmail')}
            required
          />
        </Field>
        <Field label="First owner's name">
          <input className={inputClass} value={form.ownerName} onChange={set('ownerName')} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button kind="ghost" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            kind="primary"
            disabled={busy || !form.name.trim() || !form.ownerEmail.trim()}
          >
            Create workspace
          </Button>
        </div>
      </form>
    </Modal>
  )
}
