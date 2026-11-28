import { useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import {
  PAYROLL_BUDGET_KINDS,
  PAYROLL_BUDGET_KIND_LABELS,
  lineKey,
  payrollPlace,
  type PayrollBudgetKind,
  type PayrollRollupDto,
  type PayrollRollupInput,
  type PayrollRollupPreviewDto,
  type PayrollRollupSaved,
} from '@ad/types'
import { useApi, useLoad } from '@/hooks/useApi'
import { periodLabel } from '@/lib/format'
import { Button, Card, ErrorNote, Field, Modal, Notice, inputClass } from '@/components/ui'
import { MultiSelect } from '@/components/MultiSelect'

const NOWHERE = 'Not linked to a Budget Line Item'
/** The select's value for "Not linked to a Budget Line Item". */
const NONE = '__none__'

const nameOr = (n: string | null) => n ?? NOWHERE

/** A kind the workspace has no row for: no line until each engagement is given one. */
const NOT_SET = 'Not set yet: each engagement is asked to choose'

/**
 * One row of the card, as Map Financial Categories shows them: a payroll category, the budget line names it maps to
 * (null: Not linked), and the engagements it applies to: every engagement (the workspace's row, `every`), or the
 * engagements of their own that map it to the same line.
 */
interface Row {
  key: string
  kind: PayrollBudgetKind
  every: boolean
  engagementIds: string[]
  /** The line names; null: Not linked to a Budget Line Item. On the every row, none: no row yet (by report line). */
  names: string[] | null
}

function rowsOf(data: PayrollRollupDto): Row[] {
  return PAYROLL_BUDGET_KINDS.flatMap((kind) => {
    const of = data.entries.filter((e) => e.kind === kind)
    const ws = of.filter((e) => e.engagementId === null)
    const own = of.filter((e) => e.engagementId !== null)
    const targets = [...new Set(own.map((o) => o.budgetLineName ?? NONE))]
    return [
      {
        key: kind,
        kind,
        every: true,
        engagementIds: [],
        names: ws.some((e) => !e.budgetLineName) ? null : ws.map((e) => e.budgetLineName!),
      },
      ...targets.map((to) => ({
        key: `${kind}|${to}`,
        kind,
        every: false,
        engagementIds: own
          .filter((o) => (o.budgetLineName ?? NONE) === to)
          .map((o) => o.engagementId!),
        names: to === NONE ? null : [to],
      })),
    ]
  })
}

/**
 * A kind's entries as Save sends them, with `row` taken out and `next` (if any) put in its place: the workspace's
 * names, and each engagement's own line (the one of `next`'s names it has), plus `chosen` lines for engagements that
 * would otherwise be unclear.
 */
function inputOf(
  data: PayrollRollupDto,
  kind: PayrollBudgetKind,
  row: Row | null,
  next: { every: boolean; engagementIds: string[]; names: string[] | null } | null,
  chosen: Record<string, string> = {}
): PayrollRollupInput {
  const of = data.entries.filter((e) => e.kind === kind)
  const ws = of.filter((e) => e.engagementId === null)
  let every: string[] | null = ws.some((e) => !e.budgetLineName)
    ? null
    : ws.map((e) => e.budgetLineName!)
  const own = new Map(
    of.filter((e) => e.engagementId).map((e) => [e.engagementId!, e.budgetLineName])
  )
  if (row?.every) every = []
  else if (row) for (const id of row.engagementIds) own.delete(id)
  if (next?.every) every = next.names
  else if (next)
    for (const id of next.engagementIds)
      own.set(id, next.names ? lineOn(data, id, next.names) : null)
  for (const [id, v] of Object.entries(chosen)) own.set(id, v === NONE ? null : v)
  return {
    every,
    own: [...own].map(([engagementId, budgetLineName]) => ({
      engagementId,
      budgetLineName: budgetLineName ?? null,
    })),
  }
}

/** "A", "A or B", "A, B or C". */
function orList(items: string[], word: 'and' | 'or'): string {
  return items.length < 2
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} ${word} ${items[items.length - 1]}`
}

/** The one of `names` an engagement has as a line (its own spelling), or null when it has none or two. */
function lineOn(data: PayrollRollupDto, engagementId: string, names: string[]): string | null {
  const keys = new Set(names.map(lineKey))
  const hits = (data.engagements.find((e) => e.id === engagementId)?.lines ?? []).filter((l) =>
    keys.has(lineKey(l.name))
  )
  return hits.length === 1 ? hits[0]!.name : null
}

/**
 * Map Payroll Budget Line Items (owner's decisions, 2026-11-27, #138), laid out as Map Financial Categories: each row a
 * payroll category from the match, the budget line names it maps to (several, no order: each engagement uses the one it
 * has) or Not linked to a Budget Line Item, and the engagements it applies to. An engagement with two of the names, or
 * none that fits, gets no line until someone chooses, so the card names it and its months can't be closed. Saving moves
 * that payroll on every engagement whose line changes, so the dialog lists those engagements, and the closed and
 * submitted months that go back to draft, before Save. Owners and bookkeepers.
 */
export function PayrollRollupCard({ workspaceId }: { workspaceId: string }) {
  const path = `/workspaces/${workspaceId}/payroll-rollup`
  const { data, error, setData } = useLoad<PayrollRollupDto>(path)
  const [editing, setEditing] = useState<{ row: Row | null; start?: Partial<Row> } | null>(null)
  const [removing, setRemoving] = useState<Row | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const { hash } = useLocation()
  useEffect(() => {
    if (data && hash === '#payroll-rollup')
      document.getElementById('payroll-rollup')?.scrollIntoView({ block: 'start' })
  }, [data, hash])

  const nameOf = (id: string) => data?.engagements.find((e) => e.id === id)?.name ?? 'An engagement'
  const names = (ids: string[]) => ids.map(nameOf).sort().join(', ')
  const rows = data ? rowsOf(data) : []
  const appliesTo = (r: Row) => {
    if (!r.every) return names(r.engagementIds)
    const except = (data?.entries ?? [])
      .filter((e) => e.kind === r.kind && e.engagementId)
      .map((e) => e.engagementId!)
    return `Every engagement${except.length ? ` except ${names(except)}` : ''}`
  }
  // Each engagement with budget lines whose line for a category is unclear.
  const unclear = (data?.engagements ?? []).flatMap((e) =>
    e.lines.length
      ? PAYROLL_BUDGET_KINDS.flatMap((k) => {
          const p = payrollPlace(k, e.id, data!.entries, e.lines)
          return p.by === 'unclear'
            ? [{ kind: k, id: e.id, name: e.name, choices: p.choices.map((l) => l.name) }]
            : []
        })
      : []
  )
  const saved = (out: PayrollRollupSaved, what: string) => {
    setData(out)
    setEditing(null)
    setRemoving(null)
    const back = out.backToDraft.map(
      (m) => `${m.engagementName} ${periodLabel(m.period)} (was ${m.was})`
    )
    setDone(`${what}${back.length ? ` Back to draft: ${back.join(', ')}.` : ''}`)
  }

  return (
    <Card
      id="payroll-rollup"
      title="Map Payroll Budget Line Items"
      aside={
        <Button kind="primary" size="sm" onClick={() => setEditing({ row: null })}>
          + Add a row
        </Button>
      }
    >
      <p className="mb-3 text-sm text-soft">
        The budget line items that hold each payroll category the payroll match proves, by name.
        Each engagement uses the one it has. An engagement can map a category to another of its
        lines on a row of its own.
      </p>
      <ErrorNote message={error} />
      {done && (
        <Notice tone="ok" fade>
          {done}
        </Notice>
      )}
      {data && (
        <div className="ad-tablewrap">
          <table className="ad-table">
            <thead>
              <tr>
                <th>Payroll Category</th>
                <th>Maps to Budget Line Item</th>
                <th>Applies to</th>
                <th aria-label="Edit or remove" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td>{PAYROLL_BUDGET_KIND_LABELS[r.kind]}</td>
                  <td>
                    {r.names === null ? (
                      <span className="ad-chip ad-chip-muted">{NOWHERE}</span>
                    ) : r.names.length ? (
                      r.names.join(', ')
                    ) : (
                      <span className="text-soft">{NOT_SET}</span>
                    )}
                  </td>
                  <td>{appliesTo(r)}</td>
                  <td className="whitespace-nowrap text-right">
                    <Button
                      kind="navy"
                      size="sm"
                      onClick={() => setEditing({ row: r })}
                      aria-label={`Edit ${PAYROLL_BUDGET_KIND_LABELS[r.kind]}`}
                    >
                      Edit
                    </Button>
                    {!(r.every && r.names?.length === 0) && (
                      <Button
                        kind="ghost"
                        size="sm"
                        className="text-danger"
                        onClick={() => setRemoving(r)}
                        aria-label={`Remove ${PAYROLL_BUDGET_KIND_LABELS[r.kind]}`}
                      >
                        Remove
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {unclear.length > 0 && (
        <div className="mt-3 grid gap-1 text-sm">
          <p className="font-bold text-danger">
            <span aria-hidden="true">⚠️</span> Choose a line for these: until then the payroll
            counts on no line, and the month can&apos;t be closed.
          </p>
          <ul className="ml-5 list-disc">
            {unclear.map((u) => (
              <li key={`${u.kind}-${u.id}`}>
                {u.choices.length > 1
                  ? `${u.name}: ${PAYROLL_BUDGET_KIND_LABELS[u.kind].toLowerCase()} could go to ${u.choices.join(' or ').replace(/\.?$/, '.')}`
                  : `${u.name} has none of the budget line items listed for ${PAYROLL_BUDGET_KIND_LABELS[u.kind].toLowerCase()}.`}{' '}
                <button
                  type="button"
                  className="wpd-linkbtn"
                  onClick={() =>
                    setEditing({
                      row: null,
                      start: { kind: u.kind, every: false, engagementIds: [u.id] },
                    })
                  }
                >
                  Choose
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {editing && data && (
        <RowModal
          path={path}
          data={data}
          row={editing.row}
          start={editing.start}
          nameOf={nameOf}
          onClose={() => setEditing(null)}
          onSaved={(out, kind) => saved(out, `${PAYROLL_BUDGET_KIND_LABELS[kind]} saved.`)}
        />
      )}
      {removing && data && (
        <RemoveModal
          path={path}
          data={data}
          row={removing}
          appliesTo={appliesTo(removing)}
          onClose={() => setRemoving(null)}
          onSaved={(out) => saved(out, `${PAYROLL_BUDGET_KIND_LABELS[removing.kind]} row removed.`)}
        />
      )}
    </Card>
  )
}

/** What Save would change for `input`, worked out again whenever it changes; null while it is asked. */
function usePreview(path: string, kind: PayrollBudgetKind, input: PayrollRollupInput | null) {
  const api = useApi()
  const [preview, setPreview] = useState<PayrollRollupPreviewDto | null>(null)
  const [error, setError] = useState<string | null>(null)
  const body = JSON.stringify(input)
  useEffect(() => {
    setPreview(null)
    if (!input) return
    let stale = false
    api
      .post<PayrollRollupPreviewDto>(`${path}/${kind}/preview`, input)
      .then((p) => !stale && (setPreview(p), setError(null)))
      .catch((e: Error) => !stale && setError(e.message))
    return () => {
      stale = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body, kind])
  return { preview, error }
}

/** The engagements whose line moves, and the months that go back to draft, before Save. */
/**
 * What Save does that the form doesn't show (owner's wording, 2026-11-28): pay already on a line that moves, and closed or
 * submitted months that go back to draft. Settling a line nobody had chosen says nothing.
 */
function Changes({ label, preview }: { label: string; preview: PayrollRollupPreviewDto }) {
  const moved = preview.changes.filter((c) => c.from !== null)
  const months = preview.changes.flatMap((c) => c.backToDraft.map((m) => ({ ...m, name: c.name })))
  if (!moved.length && !months.length) return null
  const them = months.length === 1 ? 'it' : 'them'
  return (
    <div className="grid gap-2 text-sm">
      {moved.length > 0 && (
        <div>
          <p className="font-bold">
            <span aria-hidden="true">⚠️</span> Warning: Modifying this configuration shifts{' '}
            {label.toLowerCase()} on other engagements:
          </p>
          <ul className="ml-5 list-disc">
            {moved.map((c) => (
              <li key={c.engagementId}>
                {c.name}: {nameOr(c.from)} → {nameOr(c.to)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {months.length > 0 && (
        <p className="font-bold">
          <span aria-hidden="true">⚠️</span> Warning: Modifying this configuration will alter{' '}
          {months.map((m) => `already ${m.was} ${m.name}, ${periodLabel(m.period)}`).join('; ')},
          shifting {them} back to draft.
        </p>
      )}
      <p>Save to continue.</p>
    </div>
  )
}

/** "Which line holds it?" for each engagement the change leaves unclear: kept as its own row. */
function Chooser({
  label,
  preview,
  chosen,
  setChosen,
}: {
  label: string
  preview: PayrollRollupPreviewDto
  chosen: Record<string, string>
  setChosen: (c: Record<string, string>) => void
}) {
  if (!preview.unclear.length) return null
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-sm font-semibold">
        These engagements need a line for {label.toLowerCase()}
      </legend>
      {preview.unclear.map((u) => (
        <Field
          key={u.engagementId}
          label={u.name}
          required
          hint={`Choose which of its budget line items holds ${label.toLowerCase()}`}
          error={chosen[u.engagementId] ? null : 'Choose one'}
        >
          <select
            className={inputClass}
            value={chosen[u.engagementId] ?? ''}
            onChange={(e) => setChosen({ ...chosen, [u.engagementId]: e.target.value })}
          >
            <option value="" disabled>
              Choose a budget line
            </option>
            {u.choices.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
            <option value={NONE}>{NOWHERE}</option>
          </select>
        </Field>
      ))}
    </fieldset>
  )
}

function RowModal({
  path,
  data,
  row,
  start,
  nameOf,
  onClose,
  onSaved,
}: {
  path: string
  data: PayrollRollupDto
  /** The row to change; none to add one. */
  row: Row | null
  /** A new row's starting values ("Choose" beside an engagement). */
  start?: Partial<Row>
  nameOf: (id: string) => string
  onClose: () => void
  onSaved: (out: PayrollRollupSaved, kind: PayrollBudgetKind) => void
}) {
  const api = useApi()
  const [kind, setKind] = useState<PayrollBudgetKind | ''>(row?.kind ?? start?.kind ?? '')
  const [names, setNames] = useState<string[]>(row?.names ?? [])
  const [nowhere, setNowhere] = useState(row ? row.names === null : false)
  const [every, setEvery] = useState(row?.every ?? start?.every ?? false)
  const [picked, setPicked] = useState<string[]>(row?.engagementIds ?? start?.engagementIds ?? [])
  const [chosen, setChosen] = useState<Record<string, string>>({})
  const [tried, setTried] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const label = kind ? PAYROLL_BUDGET_KIND_LABELS[kind] : 'Payroll'

  // The line names of the engagements the row applies to (every engagement's when it applies to all or none is
  // ticked yet), each once (a line is found by its name, case aside), plus any already ticked.
  const lineNames = useMemo(() => {
    const seen = new Map<string, string>()
    const on =
      every || !picked.length
        ? data.engagements
        : data.engagements.filter((e) => picked.includes(e.id))
    for (const e of on)
      for (const l of e.lines) if (!seen.has(lineKey(l.name))) seen.set(lineKey(l.name), l.name)
    for (const n of names) if (!seen.has(lineKey(n))) seen.set(lineKey(n), n)
    return [...seen.values()].sort((a, b) => a.localeCompare(b))
  }, [data.engagements, every, picked, names])

  const of = data.entries.filter((e) => e.kind === kind)
  // The engagements with a row of their own for the category, other than this one.
  const ownElsewhere = of
    .filter(
      (e) => e.engagementId && !(row && !row.every && row.engagementIds.includes(e.engagementId))
    )
    .map((e) => e.engagementId!)
  const everyTaken = !row?.every && of.some((e) => e.engagementId === null)
  const problems = {
    kind: !kind ? 'Choose a payroll category' : null,
    names: !nowhere && !names.length ? `Choose budget lines, or ${NOWHERE}` : null,
    applies: every
      ? everyTaken
        ? `${label} has an every-engagement row already: edit that row instead`
        : null
      : !picked.length
        ? 'Tick at least one engagement'
        : picked.some((id) => ownElsewhere.includes(id))
          ? `${names2(picked.filter((id) => ownElsewhere.includes(id)))} already ${picked.filter((id) => ownElsewhere.includes(id)).length === 1 ? 'has' : 'have'} a row of ${label.toLowerCase()}: edit that row instead`
          : !nowhere && names.length
            ? (() => {
                const off = picked.filter((id) => !lineOn(data, id, names))
                return off.length
                  ? `Invalid configuration: ${off.map((id) => offWords(id)).join(' ')}`
                  : null
              })()
            : null,
  }
  // Why an engagement can't use this row's names, in one sentence: none of them, or two.
  function offWords(id: string) {
    const lines = data.engagements.find((e) => e.id === id)?.lines ?? []
    const keys = new Set(names.map(lineKey))
    const hits = lines.filter((l) => keys.has(lineKey(l.name))).map((l) => l.name)
    if (hits.length > 1)
      return `${nameOf(id)} has both ${orList(hits, 'and')} as budget line items. Tick only one.`
    return lines.length
      ? `${nameOf(id)} doesn't have ${orList(names, 'or')} as a budget line item. It has ${orList(
          lines.map((l) => l.name),
          'and'
        ).replace(/\.?$/, '.')}`
      : `${nameOf(id)} has no budget line items yet.`
  }
  function names2(ids: string[]) {
    return ids.map(nameOf).join(', ')
  }
  const left = [
    problems.kind && 'Payroll Category',
    problems.names && 'Maps to Budget Line Item',
    problems.applies && 'Applies to',
  ].filter(Boolean)
  const shown = (p: string | null, filled: boolean) => (tried || filled ? p : null)

  const input =
    kind && !left.length
      ? inputOf(
          data,
          kind,
          row,
          { every, engagementIds: picked, names: nowhere ? null : names },
          chosen
        )
      : null
  const { preview, error: previewError } = usePreview(path, kind || 'staff-pay', input)
  const waiting = !!preview && preview.unclear.some((u) => !chosen[u.engagementId])
  const save = async () => {
    setTried(true)
    if (!input || !kind || !preview || waiting) return
    setBusy(true)
    setError(null)
    try {
      onSaved(await api.put<PayrollRollupSaved>(`${path}/${kind}`, input), kind)
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }
  const excepted = every ? of.filter((e) => e.engagementId).map((e) => e.engagementId!) : []
  // What an edit takes away, as Map Financial Categories warns: the engagements this row covered and no longer will.
  const covered = (all: boolean, ids: string[]) =>
    all
      ? data.engagements.filter((e) => !of.some((o) => o.engagementId === e.id)).map((e) => e.id)
      : ids
  const kept = new Set(covered(every, picked))
  const lost = row ? covered(row.every, row.engagementIds).filter((id) => !kept.has(id)) : []

  return (
    <Modal
      title={row ? 'Edit a payroll category' : 'Add a payroll category row'}
      onClose={onClose}
      wide
    >
      <ErrorNote message={error ?? previewError} />
      {tried && left.length > 0 && (
        <p className="ad-field-error-sum" role="status">
          Still to fix: {left.join(', ')}.
        </p>
      )}
      <div className="grid gap-3">
        <Field label="Payroll Category" required error={shown(problems.kind, !!kind)}>
          <select
            className={inputClass}
            value={kind}
            disabled={!!row}
            onChange={(e) => setKind(e.target.value as PayrollBudgetKind)}
          >
            <option value="" disabled>
              Choose…
            </option>
            {PAYROLL_BUDGET_KINDS.map((k) => (
              <option key={k} value={k}>
                {PAYROLL_BUDGET_KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Maps to Budget Line Item"
          required
          hint={nowhere ? undefined : 'Any of these names: each engagement uses the one it has'}
          error={shown(problems.names, nowhere || names.length > 0)}
        >
          {!nowhere && (
            <MultiSelect
              label="Budget line items"
              options={lineNames.map((n) => ({ value: n, label: n }))}
              value={names}
              onChange={setNames}
              placeholder="Choose budget lines"
            />
          )}
          <label className="mt-2 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={nowhere}
              onChange={(e) => setNowhere(e.target.checked)}
            />
            {NOWHERE}
          </label>
        </Field>
        <fieldset className="ad-field">
          <legend className="mb-1 font-bold">Applies to</legend>
          <div className="grid gap-2 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={every} onChange={(e) => setEvery(e.target.checked)} />
              Every engagement
            </label>
            {every ? (
              excepted.length > 0 && (
                <p className="text-soft">
                  Except {excepted.map(nameOf).join(', ')} (on rows of their own)
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
          {shown(problems.applies, every || picked.length > 0) && (
            <small className="ad-field-error" role="alert">
              {problems.applies}
            </small>
          )}
        </fieldset>
        {lost.length > 0 && kind && (
          <div className="text-sm">
            <p className="font-semibold">
              <span aria-hidden="true">⚠️</span> {lost.map(nameOf).join(', ')} will no longer map{' '}
              {label.toLowerCase()} on this row.
            </p>
            <p className="text-soft">
              {of.some((e) => e.engagementId === null) && !row!.every
                ? `${lost.length === 1 ? 'It goes' : 'They go'} back to the every-engagement row.`
                : `${lost.length === 1 ? 'It then has' : 'They then have'} no line until someone chooses one.`}
            </p>
          </div>
        )}
        {preview && kind && (
          <>
            <Chooser label={label} preview={preview} chosen={chosen} setChosen={setChosen} />
            <Changes label={label} preview={preview} />
          </>
        )}
      </div>
      <div className="mt-6 flex justify-end gap-3">
        <Button kind="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button kind="navy" onClick={() => void save()} disabled={busy || (!!input && !preview)}>
          Save
        </Button>
      </div>
    </Modal>
  )
}

/** Removing a row: its engagements go back to the every-engagement row (or, for that row, to each one's report line). */
function RemoveModal({
  path,
  data,
  row,
  appliesTo,
  onClose,
  onSaved,
}: {
  path: string
  data: PayrollRollupDto
  row: Row
  appliesTo: string
  onClose: () => void
  onSaved: (out: PayrollRollupSaved) => void
}) {
  const api = useApi()
  const label = PAYROLL_BUDGET_KIND_LABELS[row.kind]
  const [chosen, setChosen] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input = inputOf(data, row.kind, row, null, chosen)
  const { preview, error: previewError } = usePreview(path, row.kind, input)
  const waiting = !preview || preview.unclear.some((u) => !chosen[u.engagementId])
  const remove = async () => {
    setBusy(true)
    setError(null)
    try {
      onSaved(await api.put<PayrollRollupSaved>(`${path}/${row.kind}`, input))
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }
  return (
    <Modal title="Remove this row?" onClose={onClose} wide>
      <ErrorNote message={error ?? previewError} />
      <div className="grid gap-3 text-sm">
        <p className="font-bold">
          <span aria-hidden="true">⚠️</span> {label} will no longer map to{' '}
          {row.names === null ? NOWHERE : row.names.join(', ')} for {appliesTo}.
        </p>
        <p>
          {row.every
            ? 'Each engagement without a row of its own then has no line until someone chooses one.'
            : 'They go back to the every-engagement row.'}{' '}
          The removal is recorded in the workspace history.
        </p>
        {preview && (
          <>
            <Chooser label={label} preview={preview} chosen={chosen} setChosen={setChosen} />
            <Changes label={label} preview={preview} />
          </>
        )}
        <div className="flex justify-end gap-2">
          <Button kind="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button kind="danger" onClick={() => void remove()} disabled={busy || waiting}>
            Remove
          </Button>
        </div>
      </div>
    </Modal>
  )
}
