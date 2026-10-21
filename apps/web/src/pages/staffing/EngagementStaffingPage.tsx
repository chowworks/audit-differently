import { Icon } from '@/components/icons'
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type {
  StaffInputProblem,
  StaffListDto,
  StaffMemberDto,
  StaffSuggestionDto,
  WorkspaceDetail,
  WorkspacePayrollPeriodDto,
} from '@ad/types'
import { useApi, useLoad } from '@/hooks/useApi'
import { ApiError } from '@/services/api'
import { engagementColors } from '@/lib/engagement-colors'
import { periodLabel } from '@/lib/format'
import { HandCard } from '@/components/HandCard'
import { NotFoundPage } from '@/pages/NotFoundPage'
import { Button, Card, Empty, ErrorNote, Field, Modal, Notice, inputClass } from '@/components/ui'
import {
  besideField,
  checkStaff,
  leftOutWords,
  problemsOf,
  readStaffPaste,
  type PastedRow,
} from './staff-paste'
import './engagement-staffing.css'

type View = 'engagement' | 'person'
type Engagement = StaffListDto['engagements'][number] & { color: string }

const onIt = (p: StaffMemberDto, engagementId: string) =>
  p.engagements.some((e) => e.id === engagementId)

/** A small "+ Add …" menu: pick one of the choices left. */
function AddMenu({
  label,
  choices,
  disabled,
  onPick,
}: {
  label: string
  choices: { id: string; name: string }[]
  disabled?: boolean
  onPick: (id: string) => void
}) {
  if (!choices.length) return null
  return (
    <select
      className="ss-add"
      value=""
      aria-label={label}
      disabled={disabled}
      onChange={(e) => e.target.value && onPick(e.target.value)}
    >
      <option value="">{label}</option>
      {choices.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
    </select>
  )
}

const personLine = (p: { role: string | null }) => p.role ?? ''

interface ViewProps {
  staff: StaffMemberDto[]
  engagements: Engagement[]
  /** Owners change it; auditors read. */
  change: boolean
  busy: boolean
  tag: (p: StaffMemberDto, e: Engagement) => void
  untag: (p: StaffMemberDto, e: Engagement) => void
  edit: (p: StaffMemberDto) => void
}

/** By engagement (the default): one card per engagement, the staff who work on it. */
function EngagementView({ staff, engagements, change, busy, tag, untag }: ViewProps) {
  if (!engagements.length) return <Empty>This workspace has no engagement yet.</Empty>
  return (
    <div className="ss-eng-grid">
      {engagements.map((e) => {
        const people = staff.filter((p) => onIt(p, e.id))
        return (
          <section key={e.id} className="ad-card ss-eng-card" style={{ borderTopColor: e.color }}>
            <header>
              <div>
                <b>{e.name}</b>
                {e.code && <small className="ss-code">{e.code}</small>}
              </div>
              <span className="ss-count">
                {people.length} {people.length === 1 ? 'person' : 'people'}
              </span>
            </header>
            <ul className="ss-people">
              {people.map((p) => (
                <li key={p.id}>
                  <span>
                    <b>{p.name}</b>
                    <small>{personLine(p)}</small>
                  </span>
                  {change && (
                    <button
                      type="button"
                      className="ss-remove"
                      disabled={busy}
                      onClick={() => untag(p, e)}
                      aria-label={`Take ${p.name} off ${e.name}`}
                    >
                      remove
                    </button>
                  )}
                </li>
              ))}
              {people.length === 0 && <li className="text-soft">Nobody on it yet.</li>}
            </ul>
            {change && (
              <AddMenu
                label="+ Add person"
                disabled={busy}
                choices={staff
                  .filter((p) => !onIt(p, e.id))
                  .map((p) => ({ id: p.id, name: p.name }))}
                onPick={(id) =>
                  tag(
                    staff.find((p) => p.id === id)!,
                    e
                  )
                }
              />
            )}
          </section>
        )
      })}
    </div>
  )
}

/** By person: one row per staff member, their engagements as chips. */
function PersonView({ staff, engagements, change, busy, tag, untag, edit }: ViewProps) {
  if (!staff.length) return <Empty>Nobody is on the staff list yet.</Empty>
  return (
    <Card>
      <ul className="ss-person-list">
        {staff.map((p) => (
          <li key={p.id}>
            <span>
              <b>{p.name}</b>
              <small>
                {personLine(p) || '—'}
                {change && (
                  <>
                    {' '}
                    <button
                      type="button"
                      className="ss-edit"
                      onClick={() => edit(p)}
                      aria-label={`Edit ${p.name}`}
                    >
                      Edit
                    </button>
                  </>
                )}
              </small>
            </span>
            <span className="ss-chips">
              {engagements
                .filter((e) => onIt(p, e.id))
                .map((e) => (
                  <span key={e.id} className="ss-tag" style={{ borderColor: e.color }}>
                    <span className="ss-dot" style={{ background: e.color }} />
                    {e.name}
                    {change && (
                      <button
                        type="button"
                        aria-label={`Take ${p.name} off ${e.name}`}
                        disabled={busy}
                        onClick={() => untag(p, e)}
                      >
                        remove
                      </button>
                    )}
                  </span>
                ))}
              {!p.engagements.length && <span className="text-soft">No engagement yet</span>}
              {change && (
                <AddMenu
                  label="+ Add engagement"
                  disabled={busy}
                  choices={engagements
                    .filter((e) => !onIt(p, e.id))
                    .map((e) => ({ id: e.id, name: e.name }))}
                  onPick={(id) =>
                    tag(
                      p,
                      engagements.find((e) => e.id === id)!
                    )
                  }
                />
              )}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  )
}

/**
 * People the newest month's payroll registers name who are not on the staff list (owners only). Nothing shows when
 * there are none, or no month has payroll files yet.
 */
function useSuggestions(workspaceId: string, owner: boolean) {
  const api = useApi()
  const [found, setFound] = useState<{ period: string; people: StaffSuggestionDto[] } | null>(null)
  useEffect(() => {
    if (!owner) return
    let gone = false
    void (async () => {
      try {
        const periods = await api.get<WorkspacePayrollPeriodDto[]>(
          `/workspaces/${workspaceId}/payroll`
        )
        const latest = periods.find((p) => p.payLines > 0)
        if (!latest || gone) return
        const people = await api.get<StaffSuggestionDto[]>(
          `/workspaces/${workspaceId}/payroll/${latest.period}/staff-suggestions`
        )
        if (!gone) setFound({ period: latest.period, people })
      } catch {
        // Suggestions are a help only: without them the paste works the same.
      }
    })()
    return () => {
      gone = true
    }
  }, [api, workspaceId, owner])
  return found
}

function AddStaffModal({
  list,
  suggestions,
  onAdded,
  onClose,
}: {
  list: StaffListDto
  suggestions: { period: string; people: StaffSuggestionDto[] } | null
  onAdded: (out: StaffListDto, count: number) => void
  onClose: () => void
}) {
  const api = useApi()
  const [text, setText] = useState('')
  const [suggesting, setSuggesting] = useState(false)
  const [ticked, setTicked] = useState<Set<number>>(new Set())
  const [server, setServer] = useState<StaffInputProblem[]>([])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // Someone added since the suggestions were read is not offered again.
  const listed = (s: StaffSuggestionDto) =>
    list.staff.some((p) => p.name.toLowerCase() === s.name.toLowerCase())
  const offered = (suggestions?.people ?? []).filter((s) => !listed(s))
  const paste = readStaffPaste(text)
  const leftOut = leftOutWords(paste)
  const rows: PastedRow[] = [
    ...paste.rows,
    ...offered.filter((_, i) => ticked.has(i)).map((s) => ({ name: s.name, role: '' })),
  ]
  const local = checkStaff(rows, list.staff)
  // The server's answer is for the rows it was sent: once they change, the screen's own checks speak again.
  const problems = server.length ? server : local
  const problemsAt = (row: number) => problems.filter((p) => p.row === row)
  const badRows = [...new Set(problems.map((p) => p.row))]
  const tick = (i: number) => {
    const next = new Set(ticked)
    if (next.has(i)) next.delete(i)
    else next.add(i)
    setTicked(next)
    setServer([])
  }
  const add = async () => {
    setSaving(true)
    setError(null)
    try {
      const out = await api.post<StaffListDto>(`/workspaces/${list.workspaceId}/staff`, {
        staff: rows.map((r) => ({
          name: r.name,
          role: r.role || null,
        })),
      })
      onAdded(out, rows.length)
    } catch (e) {
      const sent = e instanceof ApiError ? problemsOf(e.body) : null
      if (sent?.length) setServer(sent)
      else setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }
  return (
    <Modal title="Add All Staff" onClose={onClose} wide>
      <div className="grid gap-4">
        <ErrorNote message={error} />
        <p className="text-sm">
          <b>Paste or type your staff: one person per line.</b> Name, then role (optional),
          separated by a comma or a tab. Any other column is left out.
        </p>
        <Field label="Staff">
          <textarea
            className={`${inputClass} ss-paste`}
            rows={6}
            autoFocus
            placeholder={'Morgan Lee, Lead instructor\nPriya Shah, Case manager'}
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              setServer([])
            }}
          />
        </Field>
        {offered.length > 0 && suggestions && (
          <div className="grid gap-2">
            {!suggesting ? (
              <div>
                <Button kind="navy" size="sm" onClick={() => setSuggesting(true)}>
                  Suggest from a register
                </Button>
              </div>
            ) : (
              <div className="ss-suggest">
                <p className="text-sm font-semibold">
                  On the {periodLabel(suggestions.period)} registers, not on your staff list
                </p>
                <ul>
                  {offered.map((s, i) => (
                    <li key={`${s.name}-${i}`}>
                      <label>
                        <input type="checkbox" checked={ticked.has(i)} onChange={() => tick(i)} />
                        <span>
                          <b>{s.name}</b>
                          <small>{s.fileName}</small>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
        {rows.length === 0 && (
          <p className="text-sm text-soft">People you paste show here before they&apos;re added.</p>
        )}
        {rows.length > 0 && (
          <>
            <p className="text-sm">
              <b>
                Will be added: {rows.length} {rows.length === 1 ? 'person' : 'people'}
              </b>
            </p>
            {badRows.length > 0 && (
              <p className="ad-field-error" role="alert">
                Fix {badRows.length === 1 ? 'row' : 'rows'} {badRows.join(', ')} to add them.
              </p>
            )}
            <div className="ad-tablewrap">
              <table className="ad-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Role</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => {
                    const at = problemsAt(i + 1)
                    const cell = (field: StaffInputProblem['field'], value: string) => (
                      <td>
                        {value || <span className="text-soft">—</span>}
                        {at
                          .filter((p) => p.field === field)
                          .map((p, j) => (
                            <small key={j} className="ad-field-error block">
                              {besideField(p)}
                            </small>
                          ))}
                      </td>
                    )
                    return (
                      <tr key={i}>
                        {cell('name', r.name)}
                        {cell('role', r.role)}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
        {leftOut && <p className="text-sm text-soft">{leftOut}</p>}
        <div className="flex justify-end gap-2">
          <Button kind="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            kind="navy"
            disabled={!rows.length || saving || badRows.length > 0}
            onClick={() => void add()}
          >
            {saving
              ? 'Adding…'
              : `Add ${rows.length || ''} ${rows.length === 1 ? 'person' : 'people'}`}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

/** One person's name and role; or taking them off the list. */
function EditStaffModal({
  person,
  list,
  onDone,
  onClose,
}: {
  person: StaffMemberDto
  list: StaffListDto
  onDone: (out: StaffListDto, words: string) => void
  onClose: () => void
}) {
  const api = useApi()
  const [name, setName] = useState(person.name)
  const [role, setRole] = useState(person.role ?? '')
  const [server, setServer] = useState<StaffInputProblem[]>([])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [removing, setRemoving] = useState(false)
  const local = checkStaff([{ name, role }], list.staff, person.id)
  const problems = server.length ? server : local
  const errorOf = (field: StaffInputProblem['field']) => {
    const p = problems.find((x) => x.field === field)
    return p ? besideField(p) : null
  }
  const edited = (f: (v: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
    f(e.target.value)
    setServer([])
  }
  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const out = await api.patch<StaffListDto>(`/staff/${person.id}`, {
        name,
        role: role.trim() || null,
      })
      onDone(out, `Saved ${name.trim()}.`)
    } catch (e) {
      const sent = e instanceof ApiError ? problemsOf(e.body) : null
      if (sent?.length) setServer(sent)
      else setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }
  const remove = async () => {
    setSaving(true)
    setError(null)
    try {
      const out = await api.del<StaffListDto>(`/staff/${person.id}`)
      onDone(out, `Removed ${person.name} from the staff list.`)
    } catch (e) {
      // 409: saved payroll proof names them, so they stay (the message says what to do instead).
      setError((e as Error).message)
      setRemoving(false)
    } finally {
      setSaving(false)
    }
  }
  return (
    <Modal title={`Edit ${person.name}`} onClose={onClose}>
      <form
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (!problems.length) void save()
        }}
      >
        <ErrorNote message={error} />
        <Field label="Name" required error={errorOf('name')}>
          <input className={inputClass} value={name} onChange={edited(setName)} autoFocus />
        </Field>
        <Field label="Role" error={errorOf('role')}>
          <input className={inputClass} value={role} onChange={edited(setRole)} />
        </Field>
        <div className="ad-actions justify-between">
          {removing ? (
            <span className="flex flex-wrap items-center gap-2 text-sm">
              <b>Remove {person.name}?</b>
              <button
                type="button"
                className="ss-remove"
                disabled={saving}
                onClick={() => void remove()}
              >
                Yes, remove
              </button>
              <Button kind="ghost" size="sm" onClick={() => setRemoving(false)}>
                Keep
              </Button>
            </span>
          ) : (
            <button
              type="button"
              className="ss-remove"
              disabled={saving}
              onClick={() => {
                setError(null)
                setRemoving(true)
              }}
            >
              Remove from staff list
            </button>
          )}
          <span className="flex gap-2">
            <Button kind="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button kind="navy" type="submit" disabled={saving || problems.length > 0}>
              {saving && !removing ? 'Saving…' : 'Save'}
            </Button>
          </span>
        </div>
      </form>
    </Modal>
  )
}

/**
 * Engagement staffing (GitHub issue #22): the workspace's staff and which engagements each works on. The workspace
 * payroll upload files each person's timecard and pay as proof for the engagements they are on. Owners change it,
 * auditors read it, and to anyone else the page is not there.
 */
export function EngagementStaffingPage() {
  const { id = '' } = useParams()
  const api = useApi()
  const { data: w } = useLoad<WorkspaceDetail>(`/workspaces/${id}`)
  const { data: list, error, status, setData } = useLoad<StaffListDto>(`/workspaces/${id}/staff`)
  const change = !!list?.can.change
  const suggestions = useSuggestions(id, change)
  const [view, setView] = useState<View>('engagement')
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<StaffMemberDto | null>(null)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  if (status === 404) return <NotFoundPage />
  if (error) return <ErrorNote message={error} />
  if (!list) return <Empty>Loading…</Empty>
  const colors = engagementColors(list.engagements.map((e) => e.id))
  const engagements: Engagement[] = list.engagements.map((e) => ({
    ...e,
    color: colors.get(e.id)!,
  }))
  /** Each tag or untag is saved at once; the answer is the whole list. */
  const act = async (call: () => Promise<StaffListDto>, done: string) => {
    setBusy(true)
    setActionError(null)
    setNotice(null)
    try {
      setData(await call())
      setNotice(done)
    } catch (e) {
      setActionError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const tag = (p: StaffMemberDto, e: Engagement) =>
    void act(
      () => api.put<StaffListDto>(`/staff/${p.id}/engagements/${e.id}`),
      `Added ${p.name} to ${e.name}.`
    )
  const untag = (p: StaffMemberDto, e: Engagement) =>
    void act(
      () => api.del<StaffListDto>(`/staff/${p.id}/engagements/${e.id}`),
      `Took ${p.name} off ${e.name}.`
    )
  const props: ViewProps = {
    staff: list.staff,
    engagements,
    change,
    busy,
    tag,
    untag,
    edit: (p) => setEditing(p),
  }
  return (
    <>
      <nav className="ad-crumbs" aria-label="Breadcrumb">
        <Link to="/workspaces">Workspace Manager</Link> /{' '}
        <Link to={`/workspaces/${id}`}>{w?.name ?? 'Workspace'}</Link> / Engagement staffing
      </nav>
      <div className="ss-head">
        <div>
          <p className="ad-eyebrow">Workspace</p>
          <h1 className="ad-h1">Engagement staffing</h1>
          <p className="ss-month">
            Who works on which engagement. Their timecards and pay are filed to those engagements.
          </p>
        </div>
        {change && list.staff.length === 0 && (
          <div className="w-full">
            <HandCard
              title="Start your staff list"
              icon="📋"
              lead="Paste your staff, then tag them to the engagements they support."
            >
              <ol className="ad-hand-steps">
                <li>
                  Press + Add All Staff and quickly paste all of your employee names and optionally
                  their role (Instructor, Bootcamp leader, etc).
                </li>
                <li>Then for each engagement tag your staff who support.</li>
                <li>
                  Later payroll and our financial records will be auto-linked to these employees.
                </li>
              </ol>
            </HandCard>
          </div>
        )}
        <div className="flex w-full flex-wrap items-center gap-3 border-t border-line pt-4">
          <div className="ss-mode" role="group" aria-label="Show">
            {(
              [
                ['engagement', 'By engagement'],
                ['person', 'By person'],
              ] as [View, string][]
            ).map(([k, text]) => (
              <button
                key={k}
                type="button"
                className={view === k ? 'ss-on' : undefined}
                aria-pressed={view === k}
                onClick={() => setView(k)}
              >
                {text}
              </button>
            ))}
          </div>
          {change && (
            <Button kind="primary" size="sm" className="ml-auto" onClick={() => setAdding(true)}>
              + Add All Staff
            </Button>
          )}
        </div>
      </div>
      {change && (
        <details className="ss-help">
          <summary>
            <span className="ss-help-i">
              <Icon name="info" size={20} />
            </span>
            How to change your staff?
          </summary>
          <ul>
            <li>
              <b>Modify Name or Role:</b> switch to By person and press Edit beside the person.
            </li>
            <li>
              <b>Remove Staff from Engagement:</b> press remove beside them.
            </li>
            <li>
              <b>Add Staff to an Engagement:</b> + Add person on the engagement, or + Add engagement
              on the person.
            </li>
            <li>
              <b>Add More Staff:</b> + Add All Staff.
            </li>
          </ul>
        </details>
      )}
      <div className="grid gap-4">
        <ErrorNote message={actionError} />
        {notice && (
          <Notice tone="ok" fade>
            {notice}
          </Notice>
        )}
        {view === 'engagement' ? <EngagementView {...props} /> : <PersonView {...props} />}
      </div>
      {adding && (
        <AddStaffModal
          list={list}
          suggestions={suggestions}
          onClose={() => setAdding(false)}
          onAdded={(out, count) => {
            setData(out)
            setAdding(false)
            setActionError(null)
            setNotice(`Added ${count} ${count === 1 ? 'person' : 'people'} to the staff list.`)
            setView('person')
          }}
        />
      )}
      {editing && (
        <EditStaffModal
          person={editing}
          list={list}
          onClose={() => setEditing(null)}
          onDone={(out, words) => {
            setData(out)
            setEditing(null)
            setActionError(null)
            setNotice(words)
          }}
        />
      )}
    </>
  )
}
