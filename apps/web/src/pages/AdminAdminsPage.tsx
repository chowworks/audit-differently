import { useEffect, useRef, useState } from 'react'
import { useUser } from '@clerk/clerk-react'
import type { AdminListDto, AdminUserDto, PlatformRoleChangeDto } from '@ad/types'
import { useApi, useLoad } from '@/hooks/useApi'
import { shortDate } from '@/lib/format'
import { Button, Card, Chip, Empty, ErrorNote, SavedMark, inputClass } from '@/components/ui'
import { HandCard } from '@/components/HandCard'
import { AdminHow, AdminToolHead } from '@/pages/AdminPage'

/** Admin tools → Manage admins: who is a platform admin, and every attempt to make or unmake one. */
export function AdminAdminsPage() {
  return (
    <>
      <AdminToolHead to="/admin/admins" />
      <Admins />
    </>
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
  const apiRef = useRef(api)
  apiRef.current = api
  // Searches as the admin types, a moment after the last key; an answer to an older query is dropped.
  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setFound(null)
      return
    }
    let current = true
    const timer = setTimeout(async () => {
      try {
        const people = await apiRef.current.get<AdminUserDto[]>(
          `/admin/users?q=${encodeURIComponent(q)}`
        )
        if (!current) return
        setError(null)
        setFound(people)
      } catch (e) {
        if (current) setError((e as Error).message)
      }
    }, 300)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [query])
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
      <td>
        {u.role === 'admin' ? (
          <Chip tone="accent" fill>
            admin
          </Chip>
        ) : null}
      </td>
      <td className="ad-num">
        {u.id === user?.id ? (
          // Nobody changes their own role (the API refuses it too).
          <Chip tone="muted" fill>
            you
          </Chip>
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
          <Button kind="navy" size="sm" disabled={busy} onClick={() => setRole(u, 'admin')}>
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
          <input
            type="search"
            className={`${inputClass} mt-4`}
            placeholder="Find a person by name or email"
            aria-label="Find a person by name or email"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <p className="mt-2 text-xs text-soft">
            Results appear as you type. Use * as a wildcard (<code>*</code> alone lists everyone,{' '}
            <code>*@example.org</code> a whole domain). Only people who have signed in at least once
            can be found.
          </p>
          {done && (
            <p className="mt-2">
              <SavedMark at={done.at}>{done.text}</SavedMark>
            </p>
          )}
          {found?.length === 0 && <Empty>Nobody matches.</Empty>}
          {!!found?.length && (
            <>
              <p className="ad-group-title mt-4">Search results</p>
              <table className="ad-table">
                {head}
                <tbody>{found.map((u) => row(u, true))}</tbody>
              </table>
              {found.length >= 100 && (
                <p className="mt-2 text-xs text-soft">Showing the first 100: narrow the search.</p>
              )}
            </>
          )}
          <AdminHow to="/admin/admins" />
        </Card>
        <div className="mt-4">
          <AdminChanges changes={changes} />
        </div>
      </div>
      <div className="grid content-start gap-4">
        <HandCard lead="Admins run the platform, not the records.">
          <p>
            An admin sets up workspaces and their people. You cannot change your own role, so there
            is always at least one admin, and there can be at most 20.
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
                      <Chip tone="warn" fill title={c.error ?? undefined}>
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
