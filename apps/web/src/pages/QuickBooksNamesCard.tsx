import { useMemo, useState } from 'react'
import {
  aliasKey,
  type LineAliasDto,
  type LineAliasesDto,
  type LineAliasesMergeDto,
} from '@ad/types'
import { useApi, useLoad } from '@/hooks/useApi'
import { BulkAddModal } from '@/components/BulkAddModal'
import { Button, Card, ErrorNote, Field, Modal, Notice, inputClass } from '@/components/ui'

/** Where an entry goes, as the list shows it. */
const goesTo = (a: Pick<LineAliasDto, 'unallowable' | 'budgetLineName'>) =>
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
 * The QuickBooks names list (owner's decisions, 2026-11-27, #132): each account or category as QuickBooks writes it,
 * and the budget line it goes to (by the line's name) or Unallowable, for every engagement, with an engagement's own
 * override where it differs. Import transactions and Month End Close both read it. Owners and bookkeepers keep it.
 */
export function QuickBooksNamesCard({ workspaceId }: { workspaceId: string }) {
  const api = useApi()
  const path = `/workspaces/${workspaceId}/line-aliases`
  const { data, error: loadError, setData } = useLoad<LineAliasesDto>(path)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [editing, setEditing] = useState<LineAliasDto | 'new' | null>(null)
  const [search, setSearch] = useState('')
  const [removing, setRemoving] = useState<LineAliasDto | null>(null)
  const [removeBusy, setRemoveBusy] = useState(false)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const remove = async (a: LineAliasDto) => {
    setRemoveBusy(true)
    setRemoveError(null)
    try {
      setData(await api.del<LineAliasesDto>(`${path}/${a.id}`))
      setRemoving(null)
      setError(null)
      setDone(`${a.name} removed.`)
    } catch (e) {
      setRemoveError((e as Error).message)
    } finally {
      setRemoveBusy(false)
    }
  }

  const aliases = data?.aliases ?? []
  const engagements = data?.engagements ?? []
  const engagementName = (id: string | null) =>
    id ? (engagements.find((e) => e.id === id)?.name ?? 'An engagement') : 'Every engagement'

  // Each workspace entry, its engagements' overrides under it; an override with no workspace entry stands alone.
  const groups = useMemo(() => {
    const byKey = new Map<string, LineAliasDto[]>()
    for (const a of aliases)
      byKey.set(aliasKey(a.name), [...(byKey.get(aliasKey(a.name)) ?? []), a])
    // The search counts only while its box shows.
    const q = aliases.length > 8 ? aliasKey(search) : ''
    return [...byKey.values()]
      .map((rows) =>
        rows.sort((x, y) =>
          x.engagementId === null
            ? -1
            : y.engagementId === null
              ? 1
              : engagementName(x.engagementId).localeCompare(engagementName(y.engagementId))
        )
      )
      .filter((rows) => !q || rows.some((a) => aliasKey(`${a.name} ${goesTo(a)}`).includes(q)))
      .sort((x, y) => x[0]!.name.localeCompare(y[0]!.name))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aliases, search, engagements])

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

  return (
    <Card
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
              {groups.flatMap((rows) =>
                rows.map((a, i) => (
                  <tr key={a.id}>
                    <td className={i > 0 && rows[0]!.engagementId === null ? 'pl-8 text-soft' : ''}>
                      {i > 0 && rows[0]!.engagementId === null ? '↳ same name' : a.name}
                    </td>
                    <td>
                      {a.unallowable ? (
                        <span className="ad-chip ad-chip-warn">Unallowable</span>
                      ) : (
                        a.budgetLineName
                      )}
                    </td>
                    <td>{engagementName(a.engagementId)}</td>
                    <td className="whitespace-nowrap text-right">
                      <Button
                        kind="navy"
                        size="sm"
                        onClick={() => setEditing(a)}
                        aria-label={`Edit ${a.name}`}
                      >
                        Edit
                      </Button>
                      <Button
                        kind="ghost"
                        size="sm"
                        className="text-danger"
                        onClick={() => setRemoving(a)}
                        aria-label={`Remove ${a.name}`}
                      >
                        Remove
                      </Button>
                    </td>
                  </tr>
                ))
              )}
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
              {goesTo(removing)} for{' '}
              {removing.engagementId ? engagementName(removing.engagementId) : 'every engagement'}.
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

/** Add or change one name: what QuickBooks calls it, for every engagement or one, and where it goes. */
function AliasModal({
  path,
  editing,
  data,
  onClose,
  onSaved,
}: {
  path: string
  editing: LineAliasDto | null
  data: LineAliasesDto
  onClose: () => void
  onSaved: (out: LineAliasesDto, said: string) => void
}) {
  const api = useApi()
  const [name, setName] = useState(editing?.name ?? '')
  const [engagementId, setEngagementId] = useState(editing?.engagementId ?? '')
  const [goes, setGoes] = useState(
    editing ? (editing.unallowable ? UNALLOWABLE : (editing.budgetLineName ?? '')) : ''
  )
  const [error, setError] = useState<string | null>(null)
  const [tried, setTried] = useState(false)
  const [busy, setBusy] = useState(false)

  // The budget line names to point at: the engagement's own, or every engagement's for the workspace's entry.
  const lineNames = useMemo(() => {
    const from = engagementId
      ? data.engagements.filter((e) => e.id === engagementId)
      : data.engagements
    const seen = new Map<string, string>()
    for (const e of from)
      for (const n of e.budgetLines) if (!seen.has(aliasKey(n))) seen.set(aliasKey(n), n)
    return [...seen.values()].sort((a, b) => a.localeCompare(b))
  }, [data.engagements, engagementId])

  // Renaming a workspace entry (decision 6): its engagements' overrides of the old name move with it.
  const renamed =
    !!editing && editing.engagementId === null && aliasKey(name) !== aliasKey(editing.name)
  const followers = renamed
    ? data.aliases.filter(
        (a) => a.engagementId !== null && aliasKey(a.name) === aliasKey(editing!.name)
      )
    : []
  const engagementName = (id: string | null) =>
    data.engagements.find((e) => e.id === id)?.name ?? 'An engagement'

  // A name already on the list for the same engagements is changed there, never overwritten from here.
  const taken = data.aliases.some(
    (a) =>
      a.id !== editing?.id &&
      (a.engagementId ?? '') === engagementId &&
      aliasKey(a.name) === aliasKey(name)
  )
  // A line that is no longer one of the engagement's (renamed or removed since) is not a choice.
  const goesOk = goes === UNALLOWABLE || lineNames.some((n) => aliasKey(n) === aliasKey(goes))
  const problems = {
    name: !name.trim()
      ? 'Give the category as your financial system writes it'
      : taken
        ? 'That category is on the list already: edit that entry instead'
        : null,
    goes: !goes
      ? 'Choose a budget category, or Unallowable'
      : !goesOk
        ? `${goes} is no longer a budget line here. Choose another.`
        : null,
  }
  const left = [problems.name && 'Financial Category', problems.goes && 'Maps to'].filter(Boolean)
  // Every problem shows at once: as soon as there is something to say, and all of them once Save was pressed.
  const shown = (p: string | null, filled: boolean) => (tried || filled ? p : null)
  const save = async () => {
    setTried(true)
    if (problems.name || problems.goes) return
    setBusy(true)
    setError(null)
    const body = {
      name: name.trim(),
      engagementId: engagementId || null,
      unallowable: goes === UNALLOWABLE,
      budgetLineName: goes === UNALLOWABLE ? null : goes,
    }
    try {
      const out = editing
        ? await api.patch<LineAliasesDto>(`${path}/${editing.id}`, body)
        : await api.post<LineAliasesDto>(path, body)
      onSaved(out, `${body.name} saved.`)
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }
  return (
    <Modal
      title={editing ? 'Edit a financial category' : 'Add a financial category'}
      onClose={onClose}
    >
      <ErrorNote message={error} />
      {tried && left.length > 0 && (
        <p className="ad-field-error-sum" role="status">
          Still to fix: {left.join(' and ')}.
        </p>
      )}
      {editing && (
        <p className="mb-3 text-sm text-soft">
          Now: <strong>{editing.name}</strong> maps to <strong>{goesTo(editing)}</strong> for{' '}
          {editing.engagementId ? engagementName(editing.engagementId) : 'every engagement'}.
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
        <Field label="Applies to">
          <select
            className={inputClass}
            value={engagementId}
            onChange={(e) => {
              const id = e.target.value
              setEngagementId(id)
              // A budget category chosen first stays when the engagement has it too.
              const has = (
                id ? data.engagements.filter((x) => x.id === id) : data.engagements
              ).some((x) => x.budgetLines.some((n) => aliasKey(n) === aliasKey(goes)))
              setGoes((g) => (g === UNALLOWABLE || has ? g : ''))
            }}
            disabled={!!editing}
          >
            <option value="">Every engagement</option>
            {data.engagements.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name} only
              </option>
            ))}
          </select>
        </Field>
        {followers.length > 0 && (
          <div className="text-sm">
            <p className="font-semibold">These use the old name and will move to the new one:</p>
            <ul className="ml-5 list-disc">
              {followers.map((a) => (
                <li key={a.id}>
                  {a.name} → {goesTo(a)} for {engagementName(a.engagementId)}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <div className="mt-4 flex items-center justify-between gap-2">
        <span />
        <div className="flex gap-2">
          <Button kind="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button kind="navy" onClick={() => void save()} disabled={busy}>
            Save
          </Button>
        </div>
      </div>
    </Modal>
  )
}
