import { useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import {
  PAYROLL_BUDGET_DEFAULTS,
  PAYROLL_BUDGET_KINDS,
  PAYROLL_BUDGET_KIND_LABELS,
  REPORT_LINE_LABELS,
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

const NOWHERE = 'Not on the budget'
/** The select's value for "Not on the budget". */
const NONE = '__none__'
/** An engagement's choice that follows the every-engagement one: it keeps no entry of its own. */
const SAME = '__same__'

const nameOr = (n: string | null) => n ?? NOWHERE

/** Where a kind goes when the workspace lists no name: each engagement's line of its report line. */
const byReportLine = (k: PayrollBudgetKind) =>
  `Each engagement's ${REPORT_LINE_LABELS[PAYROLL_BUDGET_DEFAULTS[k][0]!]} line`

/** "could go to A or B", or "no line fits it". */
const unclearWords = (choices: string[]) =>
  choices.length > 1 ? `could go to ${choices.join(' or ')}` : 'has no budget line it fits'

/**
 * Map Payroll Budget Line Items (owner's decisions, 2026-11-27, #138): for each payroll category from the match, the
 * budget line names that hold it (several, no order: any of them is that category's line on an engagement), or Not on
 * the budget, with an engagement's own line where it differs. An engagement with two of the names, or none that fits,
 * gets no line until someone chooses, so the card names it and its months can't be closed. Saving a category moves that
 * payroll on every engagement whose line changes, so the dialog lists those engagements, and the closed and submitted
 * months that go back to draft, before Save. Owners and bookkeepers.
 */
export function PayrollRollupCard({ workspaceId }: { workspaceId: string }) {
  const path = `/workspaces/${workspaceId}/payroll-rollup`
  const { data, error, setData } = useLoad<PayrollRollupDto>(path)
  const [editing, setEditing] = useState<PayrollBudgetKind | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const { hash } = useLocation()
  useEffect(() => {
    if (data && hash === '#payroll-rollup')
      document.getElementById('payroll-rollup')?.scrollIntoView({ block: 'start' })
  }, [data, hash])

  const entries = data?.entries ?? []
  const nameOf = (id: string) => data?.engagements.find((e) => e.id === id)?.name ?? 'An engagement'
  const every = (k: PayrollBudgetKind) =>
    entries.filter((e) => e.kind === k && e.engagementId === null)
  const own = (k: PayrollBudgetKind) =>
    entries.filter((e) => e.kind === k && e.engagementId !== null)
  // Each engagement with budget lines whose line for a category is unclear.
  const unclear = (data?.engagements ?? []).flatMap((e) =>
    e.lines.length
      ? PAYROLL_BUDGET_KINDS.flatMap((k) => {
          const p = payrollPlace(k, e.id, entries, e.lines)
          return p.by === 'unclear'
            ? [{ kind: k, name: e.name, choices: p.choices.map((l) => l.name) }]
            : []
        })
      : []
  )

  return (
    <Card id="payroll-rollup" title="Map Payroll Budget Line Items">
      <p className="mb-3 text-sm text-soft">
        The budget lines that hold each payroll category the payroll match proves, by name. An
        engagement uses the one it has; it can have its own line, or keep it off the budget.
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
                <th aria-label="Edit" />
              </tr>
            </thead>
            <tbody>
              {PAYROLL_BUDGET_KINDS.flatMap((k) => {
                const ws = every(k)
                const mine = own(k)
                // As Map Financial Categories: the every-engagement row, then one row per line that engagements of
                // their own map to, with Applies to naming them.
                const targets = [...new Set(mine.map((o) => o.budgetLineName ?? NONE))]
                const edit = (
                  <Button
                    kind="navy"
                    size="sm"
                    onClick={() => setEditing(k)}
                    aria-label={`Edit ${PAYROLL_BUDGET_KIND_LABELS[k]}`}
                  >
                    Edit
                  </Button>
                )
                const names = (ids: string[]) => ids.map(nameOf).sort().join(', ')
                return [
                  <tr key={k}>
                    <td>{PAYROLL_BUDGET_KIND_LABELS[k]}</td>
                    <td>
                      {!ws.length ? (
                        <span className="text-soft">{byReportLine(k)}</span>
                      ) : ws.some((e) => !e.budgetLineName) ? (
                        <span className="ad-chip ad-chip-muted">{NOWHERE}</span>
                      ) : (
                        ws.map((e) => e.budgetLineName).join(', ')
                      )}
                    </td>
                    <td>
                      Every engagement
                      {mine.length ? ` except ${names(mine.map((o) => o.engagementId!))}` : ''}
                    </td>
                    <td className="text-right">{edit}</td>
                  </tr>,
                  ...targets.map((to) => (
                    <tr key={`${k}-${to}`}>
                      <td>{PAYROLL_BUDGET_KIND_LABELS[k]}</td>
                      <td>
                        {to === NONE ? (
                          <span className="ad-chip ad-chip-muted">{NOWHERE}</span>
                        ) : (
                          to
                        )}
                      </td>
                      <td>
                        {names(
                          mine
                            .filter((o) => (o.budgetLineName ?? NONE) === to)
                            .map((o) => o.engagementId!)
                        )}
                      </td>
                      <td className="text-right">{edit}</td>
                    </tr>
                  )),
                ]
              })}
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
              <li key={`${u.kind}-${u.name}`}>
                {u.name}: {PAYROLL_BUDGET_KIND_LABELS[u.kind].toLowerCase()}{' '}
                {unclearWords(u.choices)}.{' '}
                <button type="button" className="wpd-linkbtn" onClick={() => setEditing(u.kind)}>
                  Choose
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {editing && data && (
        <RollupModal
          path={path}
          kind={editing}
          data={data}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setData(saved)
            setEditing(null)
            const back = saved.backToDraft.map(
              (m) => `${m.engagementName} ${periodLabel(m.period)} (was ${m.was})`
            )
            setDone(
              `${PAYROLL_BUDGET_KIND_LABELS[editing]} saved.${back.length ? ` Back to draft: ${back.join(', ')}.` : ''}`
            )
          }}
        />
      )}
    </Card>
  )
}

function RollupModal({
  path,
  kind,
  data,
  onClose,
  onSaved,
}: {
  path: string
  kind: PayrollBudgetKind
  data: PayrollRollupDto
  onClose: () => void
  onSaved: (saved: PayrollRollupSaved) => void
}) {
  const api = useApi()
  const label = PAYROLL_BUDGET_KIND_LABELS[kind]
  const ws = data.entries.filter((e) => e.kind === kind && e.engagementId === null)
  const [nowhere, setNowhere] = useState(ws.some((e) => !e.budgetLineName))
  const [names, setNames] = useState<string[]>(
    ws.flatMap((e) => (e.budgetLineName ? [e.budgetLineName] : []))
  )
  const [own, setOwn] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      data.engagements.map((e) => {
        const o = data.entries.find((x) => x.kind === kind && x.engagementId === e.id)
        return [e.id, o ? (o.budgetLineName ?? NONE) : SAME]
      })
    )
  )
  const [preview, setPreview] = useState<PayrollRollupPreviewDto | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Every engagement's line names, each once (a line is found by its name, case aside).
  const lineNames = useMemo(() => {
    const seen = new Map<string, string>()
    for (const e of data.engagements)
      for (const l of e.lines) if (!seen.has(lineKey(l.name))) seen.set(lineKey(l.name), l.name)
    return [...seen.values()].sort((a, b) => a.localeCompare(b))
  }, [data.engagements])

  const input: PayrollRollupInput = {
    every: nowhere ? null : names,
    own: Object.entries(own)
      .filter(([, v]) => v !== SAME)
      .map(([engagementId, v]) => ({ engagementId, budgetLineName: v === NONE ? null : v })),
  }
  const body = JSON.stringify(input)

  // What Save would change, worked out again as the choices change.
  useEffect(() => {
    let stale = false
    setPreview(null)
    api
      .post<PayrollRollupPreviewDto>(`${path}/${kind}/preview`, input)
      .then((p) => !stale && (setPreview(p), setError(null)))
      .catch((e: Error) => !stale && setError(e.message))
    return () => {
      stale = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body])

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      onSaved(await api.put<PayrollRollupSaved>(`${path}/${kind}`, input))
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  const unclearOf = (id: string) => preview?.unclear.find((u) => u.engagementId === id)
  const months =
    preview?.changes.flatMap((c) => c.backToDraft.map((m) => ({ ...m, name: c.name }))) ?? []
  return (
    <Modal title={`Where ${label} goes`} onClose={onClose} wide>
      <ErrorNote message={error} />
      {preview && preview.unclear.length > 0 && (
        <p className="mb-3 text-sm font-bold text-danger">
          Choose a line for {preview.unclear.map((u) => u.name).join(', ')} before saving.
        </p>
      )}
      <div className="grid gap-4">
        <Field
          label="Budget line items, for every engagement"
          hint={
            nowhere
              ? undefined
              : names.length
                ? 'Any of these names: each engagement uses the one it has'
                : `None chosen: ${byReportLine(kind).toLowerCase()}`
          }
        >
          {!nowhere && (
            <MultiSelect
              label={`Budget line items for ${label}`}
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
        {data.engagements.length > 0 && (
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-semibold">Engagements with their own line</legend>
            {data.engagements.map((e) => {
              const u = unclearOf(e.id)
              return (
                <label key={e.id} className="grid items-start gap-2 text-sm sm:grid-cols-[1fr_1fr]">
                  <span className="pt-2">{e.name}</span>
                  <span>
                    <select
                      className={inputClass}
                      aria-label={`${label} on ${e.name}`}
                      value={own[e.id]}
                      onChange={(x) => setOwn({ ...own, [e.id]: x.target.value })}
                    >
                      <option value={SAME}>Same as every engagement</option>
                      {e.lines.map((l) => (
                        <option key={l.name} value={l.name}>
                          {l.name}
                        </option>
                      ))}
                      <option value={NONE}>{NOWHERE}</option>
                    </select>
                    {u && (
                      <small className="mt-1 block font-semibold text-danger">
                        {label} {unclearWords(u.choices)} here: choose one
                      </small>
                    )}
                  </span>
                </label>
              )
            })}
          </fieldset>
        )}
        {preview && preview.changes.length > 0 && (
          <div className="grid gap-2 text-sm">
            <p className="font-bold">
              <span aria-hidden="true">⚠️</span> Save moves {label.toLowerCase()} on{' '}
              {preview.changes.length === 1
                ? 'one engagement'
                : `${preview.changes.length} engagements`}
              , with its payroll rows already imported:
            </p>
            <ul className="ml-5 list-disc">
              {preview.changes.map((c) => (
                <li key={c.engagementId}>
                  {c.name}: {nameOr(c.from)} → {nameOr(c.to)}
                </li>
              ))}
            </ul>
            {months.length > 0 && (
              <p className="font-bold">
                Back to draft:{' '}
                {months.map((m) => `${m.name} ${periodLabel(m.period)} (${m.was})`).join(', ')}.
                Approve {months.length === 1 ? 'its' : 'their'} closing again and send{' '}
                {months.length === 1 ? 'it' : 'them'} again.
              </p>
            )}
          </div>
        )}
        {preview && preview.changes.length === 0 && preview.unclear.length === 0 && (
          <p className="text-sm text-soft">No engagement&apos;s line changes.</p>
        )}
      </div>
      <div className="mt-6 flex justify-end gap-3">
        <Button kind="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          kind="navy"
          onClick={() => void save()}
          disabled={busy || !preview || preview.unclear.length > 0}
        >
          Save
        </Button>
      </div>
    </Modal>
  )
}
