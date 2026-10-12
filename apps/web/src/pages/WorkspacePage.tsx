import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  ENGAGEMENT_KIND_LABELS,
  ROLES,
  ROLE_HELP,
  ROLE_LABELS,
  type EngagementSummary,
  type Role,
  type WorkspaceDetail,
} from '@ad/types'
import { useApi, useLoad } from '@/hooks/useApi'
import { money, periodLabel, shortDate } from '@/lib/format'
import { nextDue, workflow } from '@/lib/workflow'
import {
  Button,
  Card,
  Chip,
  Empty,
  ErrorNote,
  Field,
  Modal,
  Notice,
  inputClass,
} from '@/components/ui'
import { ActivityModal } from '@/components/ActivityModal'
import { HandCard } from '@/components/HandCard'
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
      value: String(w.fundingSources.length),
      label: 'sources of funds in the list',
    },
  ]
  const hand = (
    <HandCard lead="One workspace per team.">
      <p>Everyone you invite sees the same records. Invite the auditor to pull what they need.</p>
    </HandCard>
  )

  return (
    <>
      <nav className="ad-crumbs" aria-label="Breadcrumb">
        <Link to="/workspaces">Manage workspaces</Link> / {w.name}
      </nav>
      <div className="ad-head">
        <div className="flex items-start gap-4">
          <span className="ad-ws-avatar" aria-hidden="true">
            {initials(w.name)}
          </span>
          <div>
            <p className="ad-eyebrow">Workspace</p>
            <h1 className="ad-h1">{w.name}</h1>
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
                              <i style={{ width: `${(f.doneCount / f.steps.length) * 100}%` }} />
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
                Who opened, downloaded or exported what, and when. Searchable, exportable, never
                editable.
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

      {/* Row 3: settings */}
      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <section className="ad-section lg:col-span-2">
          <SectionHead icon="sliders" title="Settings" />
          <div className="grid gap-4">
            <Lists w={w} onChange={reload} />
            <MoreLists w={w} onChange={reload} />
          </div>
        </section>
      </div>
    </>
  )
}

function People({ w, onChange }: { w: WorkspaceDetail; onChange: () => Promise<void> }) {
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
                          api.patch(`/workspaces/${w.id}/members/${m.userId}`, {
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
                        void run(() => api.del(`/workspaces/${w.id}/members/${m.userId}`))
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
          onClose={() => setOpen(false)}
          onInvite={async (body) => {
            const ok = await run(() => api.post(`/workspaces/${w.id}/members`, body))
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
  onClose,
  onInvite,
}: {
  w: WorkspaceDetail
  onClose: () => void
  onInvite: (body: { email: string; displayName: string; role: Role }) => Promise<boolean>
}) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
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
        <Field label="Name">
          <input
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
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

function Lists({ w, onChange }: { w: WorkspaceDetail; onChange: () => Promise<void> }) {
  const api = useApi()
  const [sources, setSources] = useState<string[]>(w.fundingSources)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => setSources(w.fundingSources), [w.fundingSources])
  const dirty = sources.join('\n') !== w.fundingSources.join('\n')
  const add = () => {
    const v = draft.trim()
    if (v && !sources.includes(v)) setSources([...sources, v])
    setDraft('')
  }
  const save = async () => {
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      await api.patch(`/workspaces/${w.id}/lists`, { fundingSources: sources })
      await onChange()
      setSaved(true)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card title="Sources of funds">
      <p className="mb-3 text-sm text-soft">
        The funding programs you propose to, the boxes an engagement ticks, and the boxes printed on
        the monthly report form. Owners keep this list for the whole workspace.
      </p>
      <ErrorNote message={error} />
      {saved && !dirty && <Notice tone="ok">Saved.</Notice>}
      <ul className="ad-taglist">
        {sources.map((s) => (
          <li key={s}>
            <span>{s}</span>
            {w.canManage && (
              <button
                type="button"
                aria-label={`Remove ${s}`}
                onClick={() => setSources(sources.filter((x) => x !== s))}
              >
                ✕
              </button>
            )}
          </li>
        ))}
        {sources.length === 0 && <li className="text-soft">No sources yet.</li>}
      </ul>
      {w.canManage && (
        <>
          <div className="mt-3 flex gap-2">
            <input
              className={inputClass}
              placeholder="Add a source"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  add()
                }
              }}
            />
            <Button onClick={add} disabled={!draft.trim()}>
              Add
            </Button>
          </div>
          <div className="mt-3 flex justify-end">
            <Button kind="primary" size="sm" onClick={save} disabled={busy || !dirty}>
              Save list
            </Button>
          </div>
        </>
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
    <Card eyebrow="Coming soon" title="More lists">
      <p className="text-sm text-soft">
        Budget categories, the report lines and the funder's review checklist will be lists here
        too, so a funder's own forms can be matched without changing the product. Missing something
        today? Say so.
      </p>
      <ErrorNote message={error} />
      {thanks && <Notice tone="ok">Noted. We keep these and will follow up.</Notice>}
      {w.myRole !== 'auditor' && (
        <form onSubmit={suggest} className="mt-3 flex gap-2">
          <input
            className={inputClass}
            placeholder="Suggest an addition, e.g. a fund or a form your funder uses"
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

/** The access log, newest first: every read, download and export leaves a line here. */
