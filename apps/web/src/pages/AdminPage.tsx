import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useUser } from '@clerk/clerk-react'
import {
  ROLE_LABELS,
  type AdminListDto,
  type AdminUserDto,
  type AdminWorkspaceDetail,
  type AdminWorkspaceDto,
  type CreateWorkspaceRequest,
  type PlatformRoleChangeDto,
} from '@ad/types'
import { useApi, useLoad } from '@/hooks/useApi'
import { ME_CHANGED_EVENT } from '@/services/api'
import { shortDate } from '@/lib/format'
import {
  Button,
  Card,
  Chip,
  Empty,
  ErrorNote,
  Field,
  Modal,
  SavedMark,
  inputClass,
} from '@/components/ui'
import { HandCard } from '@/components/HandCard'

/**
 * Admin tools, for the platform admin (Clerk publicMetadata.role = admin): every workspace with its people, creating
 * one for a customer, and who else is an admin. Workspace level only: nothing here reads an engagement, a record or
 * an access log.
 */
export function AdminPage() {
  return (
    <>
      <div className="ad-head">
        <div>
          <p className="ad-eyebrow">Platform admin</p>
          <h1 className="ad-h1">Admin tools</h1>
          <p className="ad-sub">
            Set up a workspace for each customer and its first owner, and keep its people and lists.
            What a workspace records stays its own: nothing here opens an engagement or a document.
          </p>
        </div>
      </div>
      <div className="grid gap-6">
        <Workspaces />
        <Admins />
      </div>
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
                              {m.pending && <Chip tone="warn">invited</Chip>}
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
          <Button type="button" onClick={onClose}>
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

/** Who is a platform admin. Nobody changes their own role, so the platform always keeps one. */
function Admins() {
  const api = useApi()
  const { user } = useUser()
  const admins = useLoad<AdminListDto>('/admin/admins')
  const changes = useLoad<PlatformRoleChangeDto[]>('/admin/role-changes')
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<AdminUserDto[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<{ at: number; text: string } | null>(null)
  const search = async (ev: React.FormEvent) => {
    ev.preventDefault()
    setBusy(true)
    setError(null)
    try {
      setFound(await api.get<AdminUserDto[]>(`/admin/users?q=${encodeURIComponent(query.trim())}`))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const setRole = async (u: AdminUserDto, role: 'admin' | null) => {
    const who = u.email ?? u.displayName ?? u.id
    if (!confirm(role ? `Make ${who} a platform admin?` : `Remove ${who} as a platform admin?`))
      return
    setBusy(true)
    setError(null)
    try {
      await api.put<AdminUserDto>(`/admin/users/${u.id}/role`, { role })
      // The admins list is the one place a person shows as an admin: the search is done with.
      setFound(null)
      setQuery('')
      setDone({
        at: Date.now(),
        text: role ? `${who} is now a platform admin` : `${who} is no longer a platform admin`,
      })
      await admins.reload()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      // A failed attempt is kept too.
      await changes.reload()
      setBusy(false)
    }
  }
  const row = (u: AdminUserDto, inSearch = false) => (
    <tr key={u.id}>
      <td>
        <span className="font-semibold">{u.displayName ?? u.email ?? u.id}</span>
        {u.email && <span className="ad-table-sub">{u.email}</span>}
      </td>
      <td>{u.role === 'admin' ? <Chip tone="accent">admin</Chip> : null}</td>
      <td className="ad-num">
        {u.id === user?.id ? (
          // Nobody changes their own role (the API refuses it too).
          <Chip tone="muted">you</Chip>
        ) : u.role === 'admin' && inSearch ? (
          // Removing is done from the admins list above, so there is one place for it.
          <span className="text-xs text-soft">already an admin</span>
        ) : u.role === 'admin' ? (
          <Button
            kind="ghost"
            className="text-danger"
            disabled={busy}
            onClick={() => setRole(u, null)}
          >
            remove admin
          </Button>
        ) : (
          <Button size="sm" disabled={busy} onClick={() => setRole(u, 'admin')}>
            Make admin
          </Button>
        )}
      </td>
    </tr>
  )
  const head = (
    <thead>
      <tr>
        <th>Person</th>
        <th>Role</th>
        <th className="ad-num">Change</th>
      </tr>
    </thead>
  )
  return (
    <div className="grid gap-4 lg:grid-cols-4">
      <div className="lg:col-span-3">
        <Card title="Admins">
          <ErrorNote message={error ?? admins.error} />
          {admins.loading && !admins.data && <Empty>Loading…</Empty>}
          {admins.data && (
            <>
              <table className="ad-table">
                {head}
                <tbody>{admins.data.admins.map((u) => row(u))}</tbody>
              </table>
              {!admins.data.complete && (
                <p className="mt-2 text-xs text-soft">
                  Too many accounts to read them all: search to find anyone else who is an admin.
                </p>
              )}
            </>
          )}
          <form onSubmit={search} className="mt-4 flex gap-2">
            <input
              className={inputClass}
              placeholder="Find a person by name or email"
              aria-label="Find a person by name or email"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <Button type="submit" disabled={busy || !query.trim()}>
              Search
            </Button>
          </form>
          <p className="mt-2 text-xs text-soft">
            Only people who have signed in to Audit Differently at least once can be found. Someone
            new signs in first (they will see that they are not in a workspace yet), then search
            again.
          </p>
          {done && (
            <p className="mt-2">
              <SavedMark at={done.at}>{done.text}</SavedMark>
            </p>
          )}
          {found?.length === 0 && (
            <Empty>
              Nobody matches. If they have never signed in, ask them to sign in once, then search
              again.
            </Empty>
          )}
          {!!found?.length && (
            <>
              <p className="ad-group-title mt-4">Search results</p>
              <table className="ad-table">
                {head}
                <tbody>{found.map((u) => row(u, true))}</tbody>
              </table>
            </>
          )}
        </Card>
        <div className="mt-4">
          <AdminChanges changes={changes} />
        </div>
      </div>
      <div className="grid content-start gap-4">
        <HandCard lead="Admins run the platform, not the records.">
          <p>
            An admin sets up workspaces and their people. You cannot change your own role, so there
            is always at least one admin, and there can be at most 20. To make someone an admin,
            they sign in once first, then you find them here.
          </p>
        </HandCard>
      </div>
    </div>
  )
}

/** Who made or unmade an admin, newest first (the last 50), with the attempts Clerk refused. */
function AdminChanges({
  changes,
}: {
  changes: { data: PlatformRoleChangeDto[] | null; error: string | null; loading: boolean }
}) {
  const role = (r: string | null) => (r === 'admin' ? 'admin' : 'none')
  return (
    <Card title="Admin changes">
      <ErrorNote message={changes.error} />
      {changes.loading && !changes.data && <Empty>Loading…</Empty>}
      {changes.data?.length === 0 && <Empty>No admin has been made or unmade yet.</Empty>}
      {!!changes.data?.length && (
        <div className="ad-tablewrap">
          <table className="ad-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>Change</th>
              </tr>
            </thead>
            <tbody>
              {changes.data.map((c) => (
                <tr key={c.id}>
                  <td className="whitespace-nowrap">{shortDate(c.at)}</td>
                  <td>
                    <span className="font-semibold">{c.targetEmail ?? 'someone'}</span>
                    <span className="ad-table-sub">by {c.actorEmail ?? 'an admin'}</span>
                  </td>
                  <td>
                    {role(c.oldRole)} → {role(c.newRole)}{' '}
                    {c.outcome === 'failed' && (
                      <Chip tone="warn" title={c.error ?? undefined}>
                        failed
                      </Chip>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}
