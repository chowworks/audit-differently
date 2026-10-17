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
  const { data: w, error, reload } = useLoad<WorkspaceDetail>(id ? `/workspaces/${id}` : null)
  const { data: all } = useLoad<EngagementSummary[]>('/engagements')
  const [filter, setFilter] = useState('')
  const [log, setLog] = useState(false)
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
        {mayAdd && (
          <div className="ad-actions">
            <Link to={`/engagements/new?workspace=${w.id}`} className="ad-btn">
              + Set up an award
            </Link>
          </div>
        )}
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
              </>
            }
          >
            {engagements.length === 0 && (
              <Empty>Nothing tracked yet. Set up the first award from its letter.</Empty>
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
              <Button size="sm" onClick={() => setLog(true)}>
                Access log
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
        <section className="ad-section lg:col-span-3">
          <SectionHead icon="mail" title="Reconcile emailed receipts" />
          <ReceiptsInbox workspaceId={w.id} engagements={engagements} />
        </section>
      </div>

      {/* Row 4: the workspace's own settings */}
      <div className="mt-6 grid gap-4">
        <section className="ad-section">
          <SectionHead icon="sliders" title="Workspace Settings" />
          <div className="grid gap-4">
            {w.canManage && <Rename w={w} onChange={reload} />}
            <ReceiptsAddress w={w} onChange={reload} />
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
        <Button type="submit" kind="primary" disabled={busy || !clean || !dirty}>
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

const appliesWords = (a: TagTarget[]) => a.map((t) => TAG_TARGET_LABELS[t]).join(', ')

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
 * What saving `after` over `before` removes, one line per value: "Old Fund (Funding source) comes off 3 expenses and
 * 1 participant". Without counts (the admin view), it says every record that has it.
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
      .map(
        (v) =>
          `${v.label} (${t.label}) comes off ${uses ? usesWords(uses[`${t.key}:${v.key}`]) : 'every record that has it'}`
      )
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
  const [drafts, setDrafts] = useState<Record<number, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState<string[] | null>(null)
  useEffect(() => setTypes(w.tagTypes), [w.tagTypes])
  const dirty = JSON.stringify(types) !== JSON.stringify(w.tagTypes)
  const admin = base.startsWith('/admin')
  const solid = admin ? 'navy' : 'primary'
  const change = (at: number, next: Partial<DraftType>) =>
    setTypes(types.map((t, n) => (n === at ? { ...t, ...next } : t)))
  const addType = () => {
    const v = label.trim()
    if (v && !types.some((t) => t.label.toLowerCase() === v.toLowerCase()))
      setTypes([...types, { label: v, appliesTo: [...TAG_TARGETS], values: [] }])
    setLabel('')
  }
  const addValue = (at: number) => {
    const v = (drafts[at] ?? '').trim()
    const t = types[at]!
    if (v && !t.values.some((x) => x.label.toLowerCase() === v.toLowerCase()))
      change(at, { values: [...t.values, { label: v }] })
    setDrafts({ ...drafts, [at]: '' })
  }
  const save = async (confirmed = false) => {
    const removals = tagRemovals(w.tagTypes, types, w.tagUses)
    if (removals.length && !confirmed) {
      setConfirming(removals)
      return
    }
    setConfirming(null)
    setBusy(true)
    setError(null)
    setSaved(null)
    try {
      await api.patch(`${base}/${w.id}/lists`, { tagTypes: types })
      await onChange()
      setSaved(Date.now())
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  // One tag type's editor (its name, what it applies to, its values), whichever layout shows it.
  const editor = (t: DraftType, at: number) => (
    <>
      {w.canManage ? (
        <div className="flex flex-wrap items-center gap-2">
          <input
            className={`${inputClass} flex-1`}
            aria-label={`Name of ${t.label || 'tag type'}`}
            value={t.label}
            onChange={(e) => change(at, { label: e.target.value })}
          />
          {!(admin && t.key) && (
            <Button
              size="sm"
              kind="ghost"
              aria-label={`Remove ${t.label}`}
              onClick={() => setTypes(types.filter((_, n) => n !== at))}
            >
              ✕
            </Button>
          )}
        </div>
      ) : (
        <div className="flex flex-wrap items-baseline gap-2">
          <b>{t.label}</b>
          <span className="text-xs text-soft">{appliesWords(t.appliesTo)}</span>
        </div>
      )}
      {w.canManage && (
        <div className="mt-2 flex flex-wrap gap-3 text-sm">
          <span className="text-soft">Applies to</span>
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
      )}
      <ul className={`ad-taglist mt-2 ${admin ? 'ad-taglist-solid' : ''}`}>
        {t.values.map((v, n) => (
          <li
            key={v.key ?? `new-${n}`}
            className={w.canManage && !(admin && v.key) ? undefined : 'pr-3'}
          >
            {w.canManage ? (
              // Renaming keeps the value's key, so every record that has it shows the new name.
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
            ) : (
              <span>{v.label}</span>
            )}
            {w.canManage && !(admin && v.key) && (
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
      {w.canManage && (
        <div className="mt-2 flex gap-2">
          <input
            className={`${inputClass} ad-input-sm`}
            placeholder="Add a value, e.g. Under 18"
            aria-label={`Add a value to ${t.label || 'this tag type'}`}
            value={drafts[at] ?? ''}
            onChange={(e) => setDrafts({ ...drafts, [at]: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addValue(at)
              }
            }}
          />
          <Button
            size="sm"
            kind={admin ? 'navy' : undefined}
            onClick={() => addValue(at)}
            disabled={!drafts[at]?.trim()}
          >
            Add
          </Button>
        </div>
      )}
    </>
  )
  return (
    <Card title="Tags">
      <p className="mb-3 text-sm text-soft">
        Labels you put on engagements, expenses, payroll items and participants, such as a source of
        funds or an age group. A new engagement picks its sources of funds from this list, and the
        monthly report form prints them. The month's ledger and the participants list can be
        filtered by a tag. Owners keep the list; a participant's tags are personal, and the access
        log names the field, never the tag.
      </p>
      <ErrorNote message={error} />
      <TagsTable types={types} canManage={w.canManage} editor={editor} />
      {!w.canManage && (
        <p className="mt-3 text-xs text-soft">
          Need another tag? Suggest it under Suggest configuration data.
        </p>
      )}
      {w.canManage && (
        <>
          <div className="mt-3 flex gap-2">
            <input
              className={inputClass}
              placeholder="Add a tag type, e.g. Age group"
              aria-label="Add a tag type"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  addType()
                }
              }}
            />
            <Button kind={admin ? 'navy' : undefined} onClick={addType} disabled={!label.trim()}>
              Add
            </Button>
          </div>
          {admin && (
            <p className="mt-2 text-xs text-soft">
              Only the workspace's owners remove a saved tag: it comes off their records.
            </p>
          )}
          <div className="mt-3 flex items-center justify-end gap-3">
            <SavedMark at={saved}>Tags saved</SavedMark>
            <Button kind={solid} size="sm" onClick={() => void save()} disabled={busy || !dirty}>
              Save tags
            </Button>
          </div>
        </>
      )}
      {confirming && (
        <Modal title="Remove these tags?" onClose={() => setConfirming(null)}>
          <div className="grid gap-3 text-sm">
            <p>
              Each comes off every record that has it, and stays off. The access log keeps a line.
            </p>
            <ul className="list-disc pl-5">
              {confirming.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            <div className="flex justify-end gap-2">
              <Button kind="ghost" onClick={() => setConfirming(null)}>
                Cancel
              </Button>
              <Button kind="danger" onClick={() => void save(true)} disabled={busy}>
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
      {thanks && <Notice tone="ok">Noted. We keep these and will follow up.</Notice>}
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
