import { useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import {
  aliasKey,
  type LineAliasDto,
  type LineAliasesDto,
  type LineAliasesMergeDto,
} from '@ad/types'
import { useApi, useLoad } from '@/hooks/useApi'
import { BulkAddModal } from '@/components/BulkAddModal'
import { MultiSelect } from '@/components/MultiSelect'
import { Button, Card, ErrorNote, Field, Modal, Notice, inputClass } from '@/components/ui'

/** Where an entry goes, as the list shows it. */
const goesTo = (a: { unallowable: boolean; budgetLineName: string | null }) =>
  a.unallowable ? 'Unallowable' : (a.budgetLineName ?? '')

const UNALLOWABLE = '__unallowable__'

/** Bulk Add Names' sample (the headings `names-file.ts` reads): fictional rows, meant to be replaced. */
const NAMES_SAMPLE = [
  'Financial category,Maps to,Applies to',
  '61200 Program Supplies,Program Costs,',
  'Staff Payroll,Staff Salaries,',
  'Entertainment,Unallowable,',
  'Local Travel,Program Costs,Summer Youth Works 2026',
].join('\r\n')

const NAMES_COLUMNS: [string, string][] = [
  [
    'Financial category',
    'exactly what your financial system calls it (QuickBooks, FreshBooks, etc.), such as "60901 Rent Expense"',
  ],
  ['Maps to', 'one of your budget categories, by its name, or Unallowable'],
  [
    'Applies to',
    "optional: an engagement's name, when only that engagement maps it there; blank for every engagement",
  ],
]

/**
 * One row of the list: a name and where it maps to, for every engagement (the workspace's entry) or for the engagements
 * that each keep their own entry mapping it to the same place (owner's decision, 2026-11-27: one row, Applies to listing
 * them). `except` names the engagements whose own entry maps the workspace's name elsewhere.
 */
interface Group {
  key: string
  name: string
  rows: LineAliasDto[]
  every: boolean
  engagementIds: string[]
  unallowable: boolean
  budgetLineName: string | null
  except: string[]
}

function groupsOf(aliases: LineAliasDto[], nameOf: (id: string) => string): Group[] {
  const target = (a: LineAliasDto) => (a.unallowable ? '!' : aliasKey(a.budgetLineName ?? ''))
  const byKey = new Map<string, LineAliasDto[]>()
  for (const a of aliases) {
    const k = `${aliasKey(a.name)}|${a.engagementId === null ? '*' : target(a)}`
    byKey.set(k, [...(byKey.get(k) ?? []), a])
  }
  return [...byKey.entries()]
    .map(([key, rows]) => {
      rows.sort((x, y) => nameOf(x.engagementId ?? '').localeCompare(nameOf(y.engagementId ?? '')))
      const first = rows[0]!
      const every = first.engagementId === null
      return {
        key,
        name: first.name,
        rows,
        every,
        engagementIds: every ? [] : rows.map((r) => r.engagementId!),
        unallowable: first.unallowable,
        budgetLineName: first.budgetLineName,
        except: every
          ? aliases
              .filter(
                (o) =>
                  o.engagementId !== null &&
                  aliasKey(o.name) === aliasKey(first.name) &&
                  target(o) !== target(first)
              )
              .map((o) => nameOf(o.engagementId!))
              .sort()
          : [],
      }
    })
    .sort((x, y) => x.name.localeCompare(y.name) || (x.every ? -1 : y.every ? 1 : 0))
}

/**
 * The financial categories list (owner's decisions, 2026-11-27, #132): each account or category exactly as the
 * financial system writes it, and the budget line it maps to (by the line's name) or Unallowable, for every engagement,
 * with engagements' own entries where they differ. Import transactions and Month End Close both read it. Owners and
 * bookkeepers keep it.
 */
export function QuickBooksNamesCard({ workspaceId }: { workspaceId: string }) {
  const api = useApi()
  const path = `/workspaces/${workspaceId}/line-aliases`
  const { data, error: loadError, setData } = useLoad<LineAliasesDto>(path)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [editing, setEditing] = useState<Group | 'new' | null>(null)
  const [search, setSearch] = useState('')
  const [removing, setRemoving] = useState<Group | null>(null)
  const [removeBusy, setRemoveBusy] = useState(false)
  const [removeError, setRemoveError] = useState<string | null>(null)

  const aliases = data?.aliases ?? []
  const engagements = data?.engagements ?? []
  const nameOf = (id: string) => engagements.find((e) => e.id === id)?.name ?? 'An engagement'
  const appliesTo = (g: Group) =>
    g.every
      ? `Every engagement${g.except.length ? ` except ${g.except.join(', ')}` : ''}`
      : g.engagementIds.map(nameOf).join(', ')

  const groups = useMemo(() => {
    // The search counts only while its box shows.
    const q = aliases.length > 8 ? aliasKey(search) : ''
    return groupsOf(aliases, nameOf).filter(
      (g) =>
        !q || aliasKey(`${g.name} ${goesTo(g)}`).includes(q) || aliasKey(appliesTo(g)).includes(q)
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aliases, search, engagements])

  const remove = async (g: Group) => {
    setRemoveBusy(true)
    setRemoveError(null)
    try {
      setData(
        await api.post<LineAliasesDto>(`${path}/group`, {
          ids: g.rows.map((r) => r.id),
          name: g.name,
          engagementIds: [],
          unallowable: g.unallowable,
          budgetLineName: g.budgetLineName,
        })
      )
      setRemoving(null)
      setError(null)
      setDone(`${g.name} removed.`)
    } catch (e) {
      setRemoveError((e as Error).message)
    } finally {
      setRemoveBusy(false)
    }
  }

  const [bulk, setBulk] = useState(false)
  const addFile = async (file: File) => {
    const form = new FormData()
    form.append('file', file)
    setError(null)
    setDone(null)
    const out = await api.upload<LineAliasesMergeDto>(`${path}/file`, form)
    setData(out)
    const parts = [
      `${out.added} ${out.added === 1 ? 'name' : 'names'} added or changed`,
      out.same ? `${out.same} already on the list` : '',
      out.skipped
        ? `${out.skipped} not added (blank, or a budget line or engagement not found)`
        : '',
    ].filter(Boolean)
    setDone(`${parts.join(', ')}${out.engagementName ? `, for ${out.engagementName}` : ''}.`)
  }

  // Opened from Review expenses (#financial-categories): brought into view once the list is read.
  const { hash } = useLocation()
  useEffect(() => {
    if (data && hash === '#financial-categories')
      document.getElementById('financial-categories')?.scrollIntoView({ block: 'start' })
  }, [data, hash])

  return (
    <Card
      id="financial-categories"
      title="Map Financial Categories"
      aside={
        <div className="flex flex-wrap items-center gap-2">
          <Button kind="navy" size="sm" onClick={() => setBulk(true)}>
            Bulk Add Names
          </Button>
          <Button kind="primary" size="sm" onClick={() => setEditing('new')}>
            + Add a name
          </Button>
        </div>
      }
    >
      <p className="mb-3 text-sm text-soft">
        Each financial category, written exactly as your financial system writes it, and the budget
        category it maps to. Import transactions and Month End Close both read this list. An
        engagement can map a category somewhere else, or mark it Unallowable there.
      </p>
      <ErrorNote message={error ?? loadError} />
      {done && (
        <Notice tone="ok" fade>
          {done}
        </Notice>
      )}
      {aliases.length > 8 && (
        <input
          className={`${inputClass} mb-3 max-w-xs`}
          placeholder="Search categories"
          aria-label="Search financial categories"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      )}
      {aliases.length === 0 ? (
        <p className="text-sm text-soft">
          No names yet. They are added as you map them on Import transactions and Month End Close.
        </p>
      ) : (
        <div className="ad-tablewrap">
          <table className="ad-table">
            <thead>
              <tr>
                <th>Financial Category</th>
                <th>Maps to</th>
                <th>Applies to</th>
                <th aria-label="Edit or remove" />
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <tr key={g.key}>
                  <td>{g.name}</td>
                  <td>
                    {g.unallowable ? (
                      <span className="ad-chip ad-chip-warn">Unallowable</span>
                    ) : (
                      g.budgetLineName
                    )}
                  </td>
                  <td>{appliesTo(g)}</td>
                  <td className="whitespace-nowrap text-right">
                    <Button
                      kind="navy"
                      size="sm"
                      onClick={() => setEditing(g)}
                      aria-label={`Edit ${g.name}`}
                    >
                      Edit
                    </Button>
                    <Button
                      kind="ghost"
                      size="sm"
                      className="text-danger"
                      onClick={() => setRemoving(g)}
                      aria-label={`Remove ${g.name}`}
                    >
                      Remove
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {removing && (
        <Modal title="Remove this financial category?" onClose={() => setRemoving(null)}>
          <ErrorNote message={removeError} />
          <div className="grid gap-3 text-sm">
            <p className="font-bold">
              <span aria-hidden="true">⚠️</span> {removing.name} will no longer map to{' '}
              {goesTo(removing)} for {removing.every ? 'every engagement' : appliesTo(removing)}.
            </p>
            <p>
              Its expenses already imported keep their budget lines. The next import or month end
              that finds it asks where it goes. The removal is recorded in the workspace history.
            </p>
            <div className="flex justify-end gap-2">
              <Button kind="ghost" onClick={() => setRemoving(null)}>
                Cancel
              </Button>
              <Button kind="danger" onClick={() => void remove(removing)} disabled={removeBusy}>
                Remove
              </Button>
            </div>
          </div>
        </Modal>
      )}
      {bulk && (
        <BulkAddModal
          title="Bulk Add Names"
          lead="Add many financial categories at once, each with the budget category it maps to."
          columns={NAMES_COLUMNS}
          sample={{ fileName: 'financial-categories-sample.csv', csv: NAMES_SAMPLE }}
          onFile={addFile}
          onClose={() => setBulk(false)}
        />
      )}
      {editing && (
        <AliasModal
          path={path}
          editing={editing === 'new' ? null : editing}
          data={data ?? { aliases: [], engagements: [] }}
          onClose={() => setEditing(null)}
          onSaved={(out, said) => {
            setData(out)
            setEditing(null)
            setError(null)
            setDone(said)
          }}
        />
      )}
    </Card>
  )
}

/**
 * Add or edit one row: the category as the financial system writes it, where it maps to, and the engagements it applies
 * to (every engagement, or the ones ticked). Saved as a whole: an engagement unticked loses its entry for the name.
 */
function AliasModal({
  path,
  editing,
  data,
  onClose,
  onSaved,
}: {
  path: string
  editing: Group | null
  data: LineAliasesDto
  onClose: () => void
  onSaved: (out: LineAliasesDto, said: string) => void
}) {
  const api = useApi()
  const [name, setName] = useState(editing?.name ?? '')
  const [every, setEvery] = useState(editing ? editing.every : true)
  const [picked, setPicked] = useState<string[]>(editing?.engagementIds ?? [])
  const [goes, setGoes] = useState(
    editing ? (editing.unallowable ? UNALLOWABLE : (editing.budgetLineName ?? '')) : ''
  )
  const [error, setError] = useState<string | null>(null)
  const [tried, setTried] = useState(false)
  const [busy, setBusy] = useState(false)
  const nameOf = (id: string | null) =>
    data.engagements.find((e) => e.id === id)?.name ?? 'An engagement'
  const mine = new Set(editing?.rows.map((r) => r.id) ?? [])

  // The budget lines to point at: any engagement's for every engagement, else the ones every ticked engagement has.
  const lineNames = useMemo(() => {
    const from = every ? [] : data.engagements.filter((e) => picked.includes(e.id))
    const seen = new Map<string, string>()
    if (!from.length) {
      for (const e of data.engagements)
        for (const n of e.budgetLines) if (!seen.has(aliasKey(n))) seen.set(aliasKey(n), n)
    } else {
      for (const n of from[0]!.budgetLines)
        if (from.every((e) => e.budgetLines.some((m) => aliasKey(m) === aliasKey(n))))
          seen.set(aliasKey(n), n)
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b))
  }, [data.engagements, every, picked])

  // Renaming the workspace's entry (decision 6): its engagements' own entries of the old name move with it.
  const renamed = !!editing && editing.every && every && aliasKey(name) !== aliasKey(editing.name)
  const followers = renamed
    ? data.aliases.filter(
        (a) => a.engagementId !== null && aliasKey(a.name) === aliasKey(editing!.name)
      )
    : []

  // Another row with the name for the same engagements is edited there, never overwritten from here.
  const clash = data.aliases.filter(
    (a) =>
      !mine.has(a.id) &&
      aliasKey(a.name) === aliasKey(name) &&
      (every ? a.engagementId === null : !!a.engagementId && picked.includes(a.engagementId))
  )
  const goesOk = goes === UNALLOWABLE || lineNames.some((n) => aliasKey(n) === aliasKey(goes))
  const problems = {
    name: !name.trim()
      ? 'Give the category as your financial system writes it'
      : clash.length
        ? every
          ? 'That category is on the list for every engagement already: edit that row instead'
          : `${clash.map((a) => nameOf(a.engagementId)).join(', ')} already map${clash.length === 1 ? 's' : ''} it on another row: edit that row instead`
        : null,
    goes: !goes
      ? 'Choose a budget category, or Unallowable'
      : !goesOk
        ? `${goes} is not a budget category of every engagement ticked. Choose another.`
        : null,
    applies: !every && !picked.length ? 'Tick at least one engagement' : null,
  }
  const left = [
    problems.name && 'Financial Category',
    problems.goes && 'Maps to',
    problems.applies && 'Applies to',
  ].filter(Boolean)
  // Every problem shows at once: as soon as there is something to say, and all of them once Save was pressed.
  const shown = (p: string | null, filled: boolean) => (tried || filled ? p : null)
  const save = async () => {
    setTried(true)
    if (problems.name || problems.goes || problems.applies) return
    setBusy(true)
    setError(null)
    try {
      const out = await api.post<LineAliasesDto>(`${path}/group`, {
        ids: [...mine],
        name: name.trim(),
        engagementIds: every ? null : picked,
        unallowable: goes === UNALLOWABLE,
        budgetLineName: goes === UNALLOWABLE ? null : goes,
      })
      onSaved(out, `${name.trim()} saved.`)
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }
  // With every engagement ticked, an engagement with its own row for the name keeps it: shown unticked, with where.
  const ownRow = (id: string) =>
    data.aliases.find(
      (a) => !mine.has(a.id) && a.engagementId === id && aliasKey(a.name) === aliasKey(name)
    )
  const excepted = data.engagements.filter((e) => ownRow(e.id))
  return (
    <Modal
      title={editing ? 'Edit a financial category' : 'Add a financial category'}
      onClose={onClose}
    >
      <ErrorNote message={error} />
      {tried && left.length > 0 && (
        <p className="ad-field-error-sum" role="status">
          Still to fix: {left.join(', ')}.
        </p>
      )}
      <div className="grid gap-3">
        <Field
          label="Financial Category"
          required
          hint='Whatever your financial system calls it (QuickBooks, FreshBooks, etc.). Add exactly what it calls it, such as "60901 Rent Expense".'
          error={shown(problems.name, !!name.trim())}
        >
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Maps to" required error={shown(problems.goes, !!goes)}>
          <select
            className={inputClass}
            value={goesOk ? goes : ''}
            onChange={(e) => setGoes(e.target.value)}
          >
            <option value="">Choose…</option>
            {lineNames.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
            <option value={UNALLOWABLE}>
              Unallowable (not imported, not included in reports/budget)
            </option>
          </select>
        </Field>
        <fieldset
          className="ad-field"
          aria-describedby={problems.applies ? 'applies-error' : undefined}
        >
          <legend className="mb-1 font-bold">Applies to</legend>
          <div className="grid gap-2 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={every} onChange={(e) => setEvery(e.target.checked)} />
              Every engagement
            </label>
            {every ? (
              excepted.length > 0 && (
                <p className="text-soft">
                  Except{' '}
                  {excepted
                    .map((e) => `${e.name} (maps it to ${goesTo(ownRow(e.id)!)} on its own row)`)
                    .join(', ')}
                </p>
              )
            ) : (
              <MultiSelect
                label="Engagements"
                placeholder="Search and choose engagements"
                options={data.engagements.map((e) => ({ value: e.id, label: e.name }))}
                value={picked}
                onChange={setPicked}
              />
            )}
          </div>
          {shown(problems.applies, false) && (
            <small id="applies-error" className="ad-field-error" role="alert">
              {problems.applies}
            </small>
          )}
        </fieldset>
        {followers.length > 0 && (
          <div className="text-sm">
            <p className="font-semibold">These use the old name and will move to the new one:</p>
            <ul className="ml-5 list-disc">
              {followers.map((a) => (
                <li key={a.id}>
                  {a.name} → {goesTo(a)} for {nameOf(a.engagementId)}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button kind="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button kind="navy" onClick={() => void save()} disabled={busy}>
          Save
        </Button>
      </div>
    </Modal>
  )
}
