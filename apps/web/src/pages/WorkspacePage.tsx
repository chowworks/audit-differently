import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  ENGAGEMENT_KIND_LABELS,
  ROLES,
  ROLE_HELP,
  ROLE_LABELS,
  TAG_TARGETS,
  TAG_TARGET_LABELS,
  type EngagementSummary,
  type Role,
  type TagTarget,
  type TagType,
  type TagUses,
  type WorkspaceDetail,
  type WorkspaceMemberDto,
} from '@ad/types'
import { useApi, useLoad } from '@/hooks/useApi'
import { usePeopleSearch } from '@/hooks/usePeopleSearch'
import { TagsTable } from '@/pages/TagsTable'
import { money, periodLabel, shortDate } from '@/lib/format'
import { nextDue, workflow } from '@/lib/workflow'
import {
  FullDemoChip,
  Button,
  Card,
  Chip,
  Empty,
  ErrorNote,
  Field,
  Modal,
  Notice,
  SavedMark,
  inputClass,
} from '@/components/ui'
import { ActivityModal } from '@/components/ActivityModal'
import { HandCard } from '@/components/HandCard'
import { ReceiptsAddress, ReceiptsInbox } from '@/components/ReceiptsInbox'
import { WorkspaceActions } from '@/pages/WorkspaceActions'
import { Icon, type IconName } from '@/components/icons'

const ROLE_ICON: Record<Role, IconName> = { owner: 'key', bookkeeper: 'pencil', auditor: 'shield' }
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('')

function SectionHead({ icon, title, count }: { icon: IconName; title: string; count?: number }) {
  return (
    <div className="ad-section-head">
      <span className="ad-head-icon">
        <Icon name={icon} size={16} />
      </span>
      <h2>{title}</h2>
      {count != null && <span className="ad-count">{count}</span>}
    </div>
  )
}

/** One workspace, on one page: its engagements, the people who support it, and its settings. */
export function WorkspacePage() {
  const { id } = useParams()
  const {
    data: w,
    error,
    reload,
    setData,
  } = useLoad<WorkspaceDetail>(id ? `/workspaces/${id}` : null)
  const { data: all } = useLoad<EngagementSummary[]>('/engagements')
  const [filter, setFilter] = useState('')
  const [log, setLog] = useState(false)
  // Bumped when the inbox changes something, so Workspace Owner Actions counts again.
  const [actionsVersion, setActionsVersion] = useState(0)
  if (error) return <ErrorNote message={error} />
  if (!w) return <Empty>Loading…</Empty>
  const today = new Date()
  const engagements = (all ?? []).filter((c) => c.workspaceId === w.id)
  const active = engagements.filter(
    (c) => !c.periodEnd || c.periodEnd >= today.toISOString()
  ).length
  const q = filter.trim().toLowerCase()
  const shown = q
    ? engagements.filter((c) =>
        `${c.name} ${c.number ?? ''} ${c.funder ?? ''} ${ENGAGEMENT_KIND_LABELS[c.kind]}`
          .toLowerCase()
          .includes(q)
      )
    : engagements
  const mayAdd = w.canManage || w.myRole === 'bookkeeper'
  const flows = engagements.map((c) => workflow(c, null, today))
  const readiness = flows.length
    ? Math.round(flows.reduce((t, f) => t + f.readiness.pct, 0) / flows.length)
    : 0
  const count = (r: Role) => w.members.filter((m) => m.role === r).length
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
  const facts: { icon: IconName; value: string; label: string }[] = [
    {
      icon: 'briefcase',
      value: String(engagements.length),
      label: `engagement${engagements.length === 1 ? '' : 's'}, ${active} active`,
    },
    {
      icon: 'people',
      value: String(w.members.length),
      label: `${plural(count('owner'), 'owner')}, ${plural(count('bookkeeper'), 'bookkeeper')}, ${plural(count('auditor'), 'auditor')}`,
    },
    { icon: 'shield', value: `${readiness}%`, label: 'audit ready across engagements' },
    {
      icon: 'sliders',
      value: String(w.tagTypes.length),
      label: `tag type${w.tagTypes.length === 1 ? '' : 's'} in the list`,
    },
  ]
  const hand = (
    <HandCard title="What's a workspace?" icon="🗄️" lead="One workspace per team.">
      <p>Everyone you invite sees the same records. Invite the auditor to pull what they need.</p>
    </HandCard>
  )

  return (
    <>
      <nav className="ad-crumbs" aria-label="Breadcrumb">
        <Link to="/workspaces">Workspace Manager</Link> / {w.name}
      </nav>
      <div className="ad-head">
        <div className="flex items-start gap-4">
          <span className="ad-ws-avatar" aria-hidden="true">
            {initials(w.name)}
          </span>
          <div>
            <p className="ad-eyebrow">Workspace</p>
            <h1 className="ad-h1 flex flex-wrap items-center gap-3">
              {w.name} {w.featuredDemo && <FullDemoChip />}
            </h1>
            <p className="ad-sub">
              {plural(engagements.length, 'engagement')} ·{' '}
              {plural(w.memberCount, 'person').replace('persons', 'people')}
              {w.myRole ? ` · your role: ${ROLE_LABELS[w.myRole].toLowerCase()}` : ''}
            </p>
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <section className="ad-section flex flex-col lg:col-span-2">
          <SectionHead icon="shield" title="Workspace at a glance" />
          <div className="ad-glance-strip flex-1">
            {facts.map((f) => (
              <div key={f.icon} className="ad-glance-fact">
                <span className="ad-head-icon">
                  <Icon name={f.icon} size={16} />
                </span>
                <span>
                  <b>{f.value}</b> {f.label}
                </span>
              </div>
            ))}
          </div>
        </section>
        <div className="grid content-start gap-4 lg:col-span-1 lg:pt-[46px]">{hand}</div>
      </div>

      {/* What waits on the owners, when anything does. */}
      {w.myRole === 'owner' && (
        <WorkspaceActions
          key={actionsVersion}
          workspaceId={w.id}
          bookkeepersSeeStaffPayroll={w.bookkeepersSeeStaffPayroll !== false}
        />
      )}

      {/* Row 1: the engagements, full width */}
      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <section className="ad-section lg:col-span-3">
          <SectionHead icon="briefcase" title="Engagements" count={engagements.length} />
          <Card
            title="Your portfolio"
            aside={
              <>
                <input
                  className="ad-input ad-input-sm"
                  placeholder="Find an engagement"
                  aria-label="Find an engagement"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
                <span>
                  {q ? `${shown.length} of ${engagements.length} shown` : `${active} active`}
                </span>
                {w.myRole === 'owner' && (
                  <Link to={`/workspaces/${w.id}/staff`} className="ad-btn ad-btn-navy ad-btn-sm">
                    Tag Staff
                  </Link>
                )}
                {mayAdd && (
                  <Link to={`/engagements/new?workspace=${w.id}`} className="ad-btn ad-btn-sm">
                    + Add Engagement
                  </Link>
                )}
              </>
            }
          >
            {engagements.length === 0 && (
              <Empty>Nothing tracked yet. Add the first engagement.</Empty>
            )}
            {engagements.length > 0 && shown.length === 0 && (
              <Empty>Nothing matches “{filter.trim()}”.</Empty>
            )}
            {shown.length > 0 && (
              <div className="ad-tablewrap">
                <table className="ad-table">
                  <thead>
                    <tr>
                      <th>Engagement</th>
                      <th>Progress</th>
                      <th>Next report</th>
                      <th className="ad-num">Award</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((c) => {
                      const f = workflow(c, null, today)
                      const d = nextDue(c, today)
                      return (
                        <tr key={c.id}>
                          <td>
                            <Link
                              to={`/engagements/${c.id}`}
                              className="font-bold text-navy no-underline hover:underline"
                            >
                              {c.name}
                            </Link>
                            <span className="ad-table-sub">
                              {ENGAGEMENT_KIND_LABELS[c.kind]}
                              {c.number && (
                                <>
                                  {' · '}
                                  <span className="ad-mono">{c.number}</span>
                                </>
                              )}
                            </span>
                          </td>
                          <td className="min-w-[150px]">
                            <div className="ad-progress ad-progress-sm">
                              <i style={{ width: `${(f.doneCount / f.total) * 100}%` }} />
                            </div>
                            <span className="ad-table-sub">
                              step {f.current.n} of {f.steps.length} · {f.readiness.pct}% audit
                              ready
                            </span>
                          </td>
                          <td className="whitespace-nowrap">
                            {d ? (
                              <>
                                {periodLabel(d.period)}
                                <span className="ad-table-sub">due {shortDate(d.dueDate)}</span>
                              </>
                            ) : (
                              <span className="text-soft">—</span>
                            )}
                          </td>
                          <td className="ad-num">
                            {c.awardAmount != null ? (
                              money(c.awardAmount)
                            ) : (
                              <span className="text-soft">—</span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </section>
      </div>

      {/* Row 2: the people, with the three roles explained beside them */}
      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <section className="ad-section lg:col-span-2">
          <SectionHead icon="people" title="Who supports" count={w.members.length} />
          <People w={w} onChange={reload} />
          {w.myRole !== 'bookkeeper' && (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button size="sm" kind="navy" onClick={() => setLog(true)}>
                View Workspace Access Log
              </Button>
              <span className="text-xs text-soft">
                Who opened, downloaded, exported or changed what, and when. Searchable, exportable,
                never editable.
              </span>
            </div>
          )}
          {log && (
            <ActivityModal
              workspaceId={w.id}
              workspaceName={w.name}
              onClose={() => setLog(false)}
            />
          )}
        </section>
        <div className="flex flex-col gap-4 lg:col-span-1 lg:pt-[46px]">
          <Card eyebrow="Three roles" title="What each role can do" className="flex-1">
            <ul className="ad-roles-compact">
              {ROLES.map((r) => (
                <li key={r}>
                  <span className="ad-role-icon">
                    <Icon name={ROLE_ICON[r]} size={14} />
                  </span>
                  <b>{ROLE_LABELS[r]}</b>
                  <span>{ROLE_HELP[r]}</span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>

      {/* Row 3: emailed receipts */}
      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        {/* min-w-0: a grid item is otherwise as wide as its table, and the page scrolls sideways. */}
        <section id="receipts" className="ad-section min-w-0 lg:col-span-3">
          <SectionHead icon="mail" title="Reconcile emailed receipts" />
          <ReceiptsInbox
            workspaceId={w.id}
            address={w.receiptsEmail}
            engagements={engagements}
            onChange={() => setActionsVersion((v) => v + 1)}
          />
        </section>
      </div>

      {/* Row 4: the workspace's own settings */}
      <div className="mt-6 grid gap-4">
        <section className="ad-section">
          <SectionHead icon="sliders" title="Workspace Settings" />
          <div className="grid gap-4">
            {w.canManage && <Rename w={w} onChange={reload} />}
            <ReceiptsAddress w={w} onChange={setData} />
            {(w.myRole === 'owner' || w.myRole === 'auditor') && (
              <MonthEnd w={w} onChange={reload} />
            )}
          </div>
        </section>
      </div>

      {/* Row 5: the lists records are kept against */}
      <div className="mt-6 grid gap-4">
        <section className="ad-section">
          <SectionHead icon="sliders" title="Configuration Data" />
          <div className="grid gap-4">
            <Tags w={w} onChange={reload} />
            <MoreLists w={w} onChange={reload} />
          </div>
        </section>
      </div>
    </>
  )
}

/** What People and Lists need of a workspace; the admin view (AdminWorkspacePage) passes its own. */
type Managed = {
  id: string
  name: string
  canManage: boolean
  members: WorkspaceMemberDto[]
  tagTypes: TagType[]
  /** How many records hold each tag, for the warning before a removal; the admin view has none. */
  tagUses?: TagUses
}

/** The people of a workspace; `base` is where their routes are (`/admin/workspaces` for the platform admin). */
export function People({
  w,
  onChange,
  base = '/workspaces',
  findPeople = false,
}: {
  w: Managed
  onChange: () => Promise<void>
  base?: string
  /** Platform admins only (Admin tools): find the person among everyone who has signed in, instead of typing. */
  findPeople?: boolean
}) {
  const api = useApi()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      await onChange()
      return true
    } catch (e) {
      setError((e as Error).message)
      return false
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card
      title="People"
      aside={
        w.canManage && (
          <Button kind="primary" size="sm" onClick={() => setOpen(true)}>
            + Invite someone
          </Button>
        )
      }
    >
      <ErrorNote message={error} />
      <table className="ad-table">
        <thead>
          <tr>
            <th>Person</th>
            <th>Role</th>
            {w.canManage && <th></th>}
          </tr>
        </thead>
        <tbody>
          {w.members.map((m) => (
            <tr key={m.userId}>
              <td>
                <span className="font-semibold">{m.displayName}</span>{' '}
                {m.pending && <Chip tone="warn">invited</Chip>}
                {m.email && <span className="ad-table-sub">{m.email}</span>}
              </td>
              <td>
                <span className="ad-role-chip">
                  <span className="ad-role-icon">
                    <Icon name={ROLE_ICON[m.role]} size={14} />
                  </span>
                  {w.canManage ? (
                    <select
                      className="ad-input ad-input-sm"
                      value={m.role}
                      disabled={busy}
                      onChange={(e) =>
                        run(() =>
                          api.patch(`${base}/${w.id}/members/${m.userId}`, {
                            role: e.target.value,
                          })
                        )
                      }
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABELS[r]}
                        </option>
                      ))}
                    </select>
                  ) : (
                    ROLE_LABELS[m.role]
                  )}
                </span>
              </td>
              {w.canManage && (
                <td className="ad-num">
                  <Button
                    kind="ghost"
                    className="text-danger"
                    disabled={busy}
                    onClick={() => {
                      if (confirm(`Remove ${m.displayName} from ${w.name}?`))
                        void run(() => api.del(`${base}/${w.id}/members/${m.userId}`))
                    }}
                  >
                    remove
                  </Button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {open && (
        <InviteModal
          w={w}
          findPeople={findPeople}
          onClose={() => setOpen(false)}
          onInvite={async (body) => {
            const ok = await run(() => api.post(`${base}/${w.id}/members`, body))
            if (ok) setOpen(false)
            return ok
          }}
        />
      )}
    </Card>
  )
}

function InviteModal({
  w,
  findPeople,
  onClose,
  onInvite,
}: {
  w: Managed
  findPeople: boolean
  onClose: () => void
  onInvite: (body: { email: string; displayName: string; role: Role }) => Promise<boolean>
}) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  // A platform admin finds the person first; an owner types the address (no search across workspaces).
  const [query, setQuery] = useState('')
  const { found, error: searchError } = usePeopleSearch(findPeople ? query : '')
  const memberEmails = new Set(w.members.map((m) => m.email?.toLowerCase()).filter(Boolean))
  const [role, setRole] = useState<Role>('bookkeeper')
  const [busy, setBusy] = useState(false)
  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault()
    setBusy(true)
    const ok = await onInvite({ email, displayName: name, role })
    if (!ok) setBusy(false)
  }
  return (
    <Modal title={`Invite someone to ${w.name}`} onClose={onClose}>
      <form onSubmit={submit} className="grid gap-4">
        {findPeople && (
          <div>
            <Field
              label="Find a person"
              hint="Type part of a name or email; * is a wildcard. Only people who have signed in at least once are found: for anyone else, type their email below."
              error={searchError}
            >
              <input
                type="search"
                className={inputClass}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                autoFocus
              />
            </Field>
            {found?.length === 0 && <Empty>Nobody matches.</Empty>}
            {!!found?.length && (
              <table className="ad-table mt-2">
                <tbody>
                  {found.slice(0, 8).map((u) => {
                    const member = !!u.email && memberEmails.has(u.email.toLowerCase())
                    return (
                      <tr key={u.id}>
                        <td>
                          <span className="font-semibold">{u.displayName ?? u.email ?? u.id}</span>
                          {u.email && <span className="ad-table-sub">{u.email}</span>}
                          {!u.displayName && (
                            <span className="ad-table-sub">No name on their account</span>
                          )}
                        </td>
                        <td className="ad-num">
                          {member ? (
                            <Chip tone="muted">already here</Chip>
                          ) : (
                            <Button
                              type="button"
                              kind="navy"
                              size="sm"
                              disabled={!u.email}
                              onClick={() => {
                                setEmail(u.email ?? '')
                                setName(u.displayName ?? '')
                                setQuery('')
                              }}
                            >
                              Choose
                            </Button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}
        <Field label="Name">
          <input
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus={!findPeople}
          />
        </Field>
        <Field
          label="Email"
          required
          hint="They sign in with this address and the invitation is waiting"
        >
          <input
            type="email"
            className={inputClass}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </Field>
        <fieldset className="ad-field">
          <span>
            Role<i className="ad-req">*</i>
          </span>
          <div className="grid gap-2">
            {ROLES.map((r) => (
              <label key={r} className="ad-role-row">
                <input
                  type="radio"
                  name="role"
                  value={r}
                  checked={role === r}
                  onChange={() => setRole(r)}
                />
                <span className="ad-role-icon">
                  <Icon name={ROLE_ICON[r]} size={14} />
                </span>
                <span>
                  <b>{ROLE_LABELS[r]}</b>
                  <br />
                  {ROLE_HELP[r]}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" kind="primary" disabled={busy || !email}>
            Send invite
          </Button>
        </div>
      </form>
    </Modal>
  )
}

/** The workspace's name, for its owners and, from Admin tools, the platform admin. Up to 120 characters. */
export function Rename({
  w,
  onChange,
  base = '/workspaces',
}: {
  w: Managed
  onChange: () => Promise<void>
  base?: string
}) {
  const api = useApi()
  const [name, setName] = useState(w.name)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => setName(w.name), [w.name])
  const clean = name.trim()
  const dirty = clean !== w.name
  const save = async (ev: React.FormEvent) => {
    ev.preventDefault()
    setBusy(true)
    setError(null)
    setSaved(null)
    try {
      await api.patch(`${base}/${w.id}`, { name: clean })
      await onChange()
      setSaved(Date.now())
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card title="Workspace name">
      <ErrorNote message={error} />
      <form onSubmit={save} className="flex items-center gap-2">
        <input
          className={inputClass}
          aria-label="Workspace name"
          value={name}
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
        />
        <Button type="submit" kind="navy" disabled={busy || !clean || !dirty}>
          Rename
        </Button>
        <SavedMark at={saved}>Renamed</SavedMark>
      </form>
    </Card>
  )
}

/** An item being edited: one without a key is new, and the API gives it one when the list is saved. */
/** A tag type being edited: one without a key (or a value without one) is new; the API keys it on save. */
export type DraftType = {
  key?: string
  label: string
  appliesTo: TagTarget[]
  values: { key?: string; label: string }[]
}

const USE_WORDS: Record<TagTarget, [string, string]> = {
  expense: ['expense', 'expenses'],
  payroll: ['payroll item', 'payroll items'],
  participant: ['participant', 'participants'],
  engagement: ['engagement', 'engagements'],
}

/** "3 expenses, 1 participant and 2 engagements", or "no record". */
export function usesWords(uses: Partial<Record<TagTarget, number>> = {}): string {
  const parts = (Object.keys(USE_WORDS) as TagTarget[])
    .filter((k) => (uses[k] ?? 0) > 0)
    .map((k) => `${uses[k]} ${USE_WORDS[k][uses[k] === 1 ? 0 : 1]}`)
  if (!parts.length) return 'no record'
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
}

/**
 * What saving `after` over `before` removes, one line per value: "Old Fund (Funding source), on 3 expenses and
 * 1 participant", or just "Old Fund (Funding source)" when it is on no record or the counts are unknown (the admin
 * view).
 */
export function tagRemovals(before: TagType[], after: DraftType[], uses?: TagUses): string[] {
  const kept = new Set(
    after.flatMap((t) =>
      t.key ? t.values.filter((v) => v.key).map((v) => `${t.key}:${v.key}`) : []
    )
  )
  return before.flatMap((t) =>
    t.values
      .filter((v) => !kept.has(`${t.key}:${v.key}`))
      .map((v) => {
        const on = uses?.[`${t.key}:${v.key}`]
        const used = on && Object.values(on).some((n) => (n ?? 0) > 0)
        return `${v.label} (${t.label})${used ? `, on ${usesWords(on)}` : ''}`
      })
  )
}

/**
 * The workspace's tags: each type ("Funding source" is one like any other) with the records it applies to and its
 * values. Owners add, rename and remove values and types; a removed one comes off every record that has it, after a
 * warning that says how many. On an admin tool it takes the tools' solid look, and removes nothing saved (the tagged
 * records are the owners').
 */
export function Tags({
  w,
  onChange,
  base = '/workspaces',
}: {
  w: Managed
  onChange: () => Promise<void>
  base?: string
}) {
  const api = useApi()
  const [types, setTypes] = useState<DraftType[]>(w.tagTypes)
  const [label, setLabel] = useState('')
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<number | null>(null)
  const [drafts, setDrafts] = useState<Record<number, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // What saving would take off records, and the list that would be saved, waiting for the owner's yes.
  const [confirming, setConfirming] = useState<{ removals: string[]; next: DraftType[] } | null>(
    null
  )
  useEffect(() => setTypes(w.tagTypes), [w.tagTypes])
  const admin = base.startsWith('/admin')
  const solid = admin ? 'navy' : 'primary'
  const change = (at: number, next: Partial<DraftType>) =>
    setTypes(types.map((t, n) => (n === at ? { ...t, ...next } : t)))
  const taken = types.some((t) => t.label.toLowerCase() === label.trim().toLowerCase())
  const addValue = (at: number) => {
    const v = (drafts[at] ?? '').trim()
    const t = types[at]!
    if (v && !t.values.some((x) => x.label.toLowerCase() === v.toLowerCase()))
      change(at, { values: [...t.values, { label: v }] })
    setDrafts({ ...drafts, [at]: '' })
  }
  /**
   * Saves `next` as the workspace's tags. A save that takes a value off records waits for the owner's yes first (the
   * confirm dialog), then runs again with `confirmed`. True once saved.
   */
  const save = async (next: DraftType[], confirmed = false): Promise<boolean> => {
    const removals = tagRemovals(w.tagTypes, next, w.tagUses)
    if (removals.length && !confirmed) {
      setConfirming({ removals, next })
      return false
    }
    setConfirming(null)
    setBusy(true)
    setError(null)
    try {
      await api.patch(`${base}/${w.id}/lists`, { tagTypes: next })
      await onChange()
      return true
    } catch (e) {
      setError((e as Error).message)
      return false
    } finally {
      setBusy(false)
    }
  }
  const closeEdit = () => {
    setTypes(w.tagTypes)
    setDrafts({})
    setError(null)
    setEditing(null)
  }
  const closeAdd = () => {
    setAdding(false)
    setLabel('')
    setError(null)
  }
  // A new group is saved at once, then opens in Edit so its values go in next.
  const addType = async () => {
    const v = label.trim()
    if (!v || taken) return
    const next = [...types, { label: v, appliesTo: [...TAG_TARGETS], values: [] }]
    if (await save(next)) {
      closeAdd()
      setEditing(next.length - 1)
    }
  }
  const saveEdit = async () => {
    if (await save(types)) setEditing(null)
  }
  const removeType = async (at: number) => {
    if (await save(types.filter((_, n) => n !== at))) setEditing(null)
  }
  // One tag group's editor in the Edit dialog: its name, what it applies to, its values.
  const editor = (t: DraftType, at: number) => (
    <>
      <Field label="Tag Group" required>
        <input
          className={inputClass}
          value={t.label}
          onChange={(e) => change(at, { label: e.target.value })}
        />
      </Field>
      {/* A group of checkboxes: the field's look without a <label> around them. */}
      <div className="ad-field mt-2">
        <span>Applies To</span>
        <div className="flex flex-wrap gap-3 text-sm">
          {TAG_TARGETS.map((x) => (
            <label key={x} className="inline-flex items-center gap-1">
              <input
                type="checkbox"
                checked={t.appliesTo.includes(x)}
                onChange={(e) =>
                  change(at, {
                    appliesTo: TAG_TARGETS.filter((y) =>
                      y === x ? e.target.checked : t.appliesTo.includes(y)
                    ),
                  })
                }
              />
              {TAG_TARGET_LABELS[x]}
            </label>
          ))}
        </div>
      </div>
      {/* A group of controls, not one: the field's look without a <label> around them. */}
      <div className="ad-field mt-2">
        <span>Tag Values</span>
        <ul className={`ad-taglist ${admin ? 'ad-taglist-solid' : ''}`}>
          {t.values.map((v, n) => (
            <li key={v.key ?? `new-${n}`} className={!(admin && v.key) ? undefined : 'pr-3'}>
              {/* Renaming keeps the value's key, so every record that has it shows the new name. */}
              <input
                aria-label={`Name of ${v.label || 'this value'} in ${t.label}`}
                value={v.label}
                size={Math.max(4, v.label.length)}
                onChange={(e) =>
                  change(at, {
                    values: t.values.map((x, i) => (i === n ? { ...x, label: e.target.value } : x)),
                  })
                }
              />
              {!(admin && v.key) && (
                <button
                  type="button"
                  aria-label={`Remove ${v.label}`}
                  onClick={() => change(at, { values: t.values.filter((_, x) => x !== n) })}
                >
                  ✕
                </button>
              )}
            </li>
          ))}
          {t.values.length === 0 && <li className="text-soft">No values yet.</li>}
        </ul>
        <div className="mt-2 flex gap-2">
          <input
            className={`${inputClass} ad-input-sm`}
            placeholder="Add a value, e.g. Under 18"
            aria-label={`Add a value to ${t.label || 'this tag group'}`}
            value={drafts[at] ?? ''}
            onChange={(e) => setDrafts({ ...drafts, [at]: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addValue(at)
              }
            }}
          />
          <Button size="sm" kind="navy" onClick={() => addValue(at)} disabled={!drafts[at]?.trim()}>
            Add Value
          </Button>
        </div>
      </div>
    </>
  )
  const t = editing == null ? undefined : types[editing]
  return (
    <Card
      title="Tags"
      aside={
        w.canManage && (
          <Button kind={solid} size="sm" onClick={() => setAdding(true)}>
            + Add Tag Group
          </Button>
        )
      }
    >
      <p className="mb-3 text-sm text-soft">
        Labels you put on engagements, expenses, payroll items and participants, such as a source of
        funds or an age group. A new engagement picks its sources of funds from this list, and the
        monthly report form prints them. The month's ledger and the participants list can be
        filtered by a tag. Owners keep the list; a participant's tags are personal, and the access
        log names the field, never the tag.
      </p>
      {!adding && editing == null && <ErrorNote message={error} />}
      <TagsTable types={types} canManage={w.canManage} onEdit={setEditing} />
      {!w.canManage && (
        <p className="mt-3 text-xs text-soft">
          Need another tag? Suggest it under Suggest configuration data.
        </p>
      )}
      {w.canManage && admin && (
        <p className="mt-2 text-xs text-soft">
          Only the workspace's owners remove a saved tag: it comes off their records.
        </p>
      )}
      {t && editing != null && (
        <Modal title={`Edit ${t.label || 'tag group'}`} onClose={closeEdit}>
          <div className="grid gap-3">
            <ErrorNote message={error} />
            {editor(t, editing)}
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <div>
                {!(admin && t.key) && (
                  <Button
                    kind="ghost"
                    className="text-danger"
                    onClick={() => void removeType(editing)}
                    disabled={busy}
                  >
                    Remove tag group
                  </Button>
                )}
              </div>
              <div className="flex gap-2">
                <Button kind="ghost" onClick={closeEdit} disabled={busy}>
                  Cancel
                </Button>
                <Button
                  kind="navy"
                  onClick={() => void saveEdit()}
                  disabled={busy || !t.label.trim()}
                >
                  Save
                </Button>
              </div>
            </div>
          </div>
        </Modal>
      )}
      {adding && (
        <Modal title="Add a tag group" onClose={closeAdd}>
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault()
              void addType()
            }}
          >
            <ErrorNote message={error} />
            <Field
              label="Name"
              required
              hint="For example Age group. Its values go in next."
              error={taken ? 'This workspace already has a tag group of that name' : null}
            >
              <input
                className={inputClass}
                value={label}
                autoFocus
                onChange={(e) => setLabel(e.target.value)}
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Button type="button" kind="ghost" onClick={closeAdd} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" kind="navy" disabled={busy || !label.trim() || taken}>
                Add
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {confirming && (
        <Modal title="Remove these tags?" onClose={() => setConfirming(null)}>
          <div className="grid gap-3 text-sm">
            <p className="font-bold">
              <span aria-hidden="true">⚠️</span> Removing a tag value removes it from every record
              that has it today. This is a permanent action and is recorded in the workspace
              history.
            </p>
            <p>Removing the following tags:</p>
            <ul className="list-disc pl-5">
              {confirming.removals.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            <div className="flex justify-end gap-2">
              <Button kind="ghost" onClick={() => setConfirming(null)}>
                Cancel
              </Button>
              <Button
                kind="danger"
                onClick={() =>
                  void save(confirming.next, true).then((ok) => ok && setEditing(null))
                }
                disabled={busy}
              >
                Remove and save
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </Card>
  )
}

function MoreLists({ w, onChange }: { w: WorkspaceDetail; onChange: () => Promise<void> }) {
  const api = useApi()
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [thanks, setThanks] = useState(false)
  const suggest = async (ev: React.FormEvent) => {
    ev.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.post(`/workspaces/${w.id}/suggestions`, { text })
      await onChange()
      setText('')
      setThanks(true)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card title="Suggest configuration data">
      <p className="text-sm text-soft">
        Need a piece of configuration data we don't have, such as a list your funder's forms use?
        Suggest it.
      </p>
      <ErrorNote message={error} />
      {thanks && (
        <Notice tone="ok" fade>
          Noted. We keep these and will follow up.
        </Notice>
      )}
      {w.myRole !== 'auditor' && (
        <form onSubmit={suggest} className="mt-3 flex gap-2">
          <input
            className={inputClass}
            placeholder="e.g. the report lines of our funder's own form"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <Button type="submit" kind="primary" disabled={busy || !text.trim()}>
            Suggest
          </Button>
        </form>
      )}
      {w.suggestions.length > 0 && (
        <ul className="ad-rows mt-3">
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
  )
}

/** The access log, newest first: every read, download, export and change leaves a line here. */

/**
 * "Bookkeepers see staff payroll" (GitHub issue #22): on by default. Off, a bookkeeper's monthly report pages show the
 * payroll section with its proofs as labels, not links to the files. The screen only. Owners change it; the access log
 * says who.
 */
/**
 * The owner's part in month end: what the workspace payroll match is, the way into it and to engagement staffing, and
 * whether bookkeepers see staff payroll. Auditors read it and open the results.
 */
function MonthEnd({ w, onChange }: { w: WorkspaceDetail; onChange: () => Promise<void> }) {
  const api = useApi()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<number | null>(null)
  const owner = w.myRole === 'owner'
  const on = w.bookkeepersSeeStaffPayroll !== false
  const set = async (value: boolean) => {
    setBusy(true)
    setError(null)
    try {
      await api.patch(`/workspaces/${w.id}/payroll`, { bookkeepersSeeStaffPayroll: value })
      await onChange()
      setSaved(Date.now())
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card title="Your role in month end reporting">
      <ErrorNote message={error} />
      {owner && (
        <div className="ad-me-setting">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={on}
              disabled={busy}
              onChange={(e) => void set(e.target.checked)}
            />
            <b>Bookkeepers see and process payroll</b>
            <SavedMark at={saved}>Saved</SavedMark>
          </label>
          <small className="text-soft">
            {on
              ? "Bookkeepers match each engagement's payroll on its month. You can also do the whole workspace at once below."
              : "Bookkeepers see the month's payroll, but not the files behind it. Month end waits on you."}
          </small>
        </div>
      )}
      <ol className="ad-me-steps">
        <li>
          <span className="ad-me-n">1</span>
          <span>
            <b>Tag your staff to their engagements</b>
            <small>
              Each person&apos;s timecard and pay go to the engagements they are tagged to.
            </small>
          </span>
          <Link to={`/workspaces/${w.id}/staff`} className="ad-btn ad-btn-navy ad-btn-sm">
            {owner ? 'Manage staff' : 'See staff'}
          </Link>
        </li>
        <li>
          <span className="ad-me-n">2</span>
          <span>
            <b>Upload the company&apos;s payroll once a month</b>
            <small>
              Filed to every engagement; participants&apos; pay is read from their pay stubs.
            </small>
          </span>
          <Link to={`/workspaces/${w.id}/payroll`} className="ad-btn ad-btn-navy ad-btn-sm">
            {owner ? 'Process month end' : 'See month end results'}
          </Link>
        </li>
      </ol>
    </Card>
  )
}
