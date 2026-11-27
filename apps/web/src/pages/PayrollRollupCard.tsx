import { useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import {
  PAYROLL_BUDGET_DEFAULTS,
  PAYROLL_BUDGET_KINDS,
  PAYROLL_BUDGET_KIND_LABELS,
  REPORT_LINE_LABELS,
  lineKey,
  type PayrollBudgetKind,
  type PayrollRollupDto,
  type PayrollRollupInput,
  type PayrollRollupPreviewDto,
  type PayrollRollupSaved,
} from '@ad/types'
import { useApi, useLoad } from '@/hooks/useApi'
import { periodLabel } from '@/lib/format'
import { Button, Card, ErrorNote, Field, Modal, Notice, inputClass } from '@/components/ui'

const NOWHERE = 'Not on the budget'
/** The select's value for "Not on the budget". */
const NONE = '__none__'
/** An engagement's choice that follows the every-engagement one: it keeps no entry of its own. */
const SAME = '__same__'

const nameOr = (n: string | null) => n ?? NOWHERE

/**
 * The payroll rollup (owner's decisions, 2026-11-27, #138): which budget line holds each kind of payroll from the
 * match, by the line's name, for every engagement, with an engagement's own line where it differs. Saving a kind moves
 * that payroll on every engagement whose line changes, so the dialog lists those engagements, and the closed and
 * submitted months that go back to draft, before Save. Owners and bookkeepers.
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
    entries.find((e) => e.kind === k && e.engagementId === null)
  const own = (k: PayrollBudgetKind) =>
    entries.filter((e) => e.kind === k && e.engagementId !== null)

  return (
    <Card id="payroll-rollup" title="Map Payroll to Budget Lines">
      <p className="mb-3 text-sm text-soft">
        The budget line that holds each kind of payroll the payroll match proves. A line is found by
        its name on each engagement; an engagement can use another line, or keep it off the budget.
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
                <th>Payroll</th>
                <th>Maps to</th>
                <th>Engagements with their own line</th>
                <th aria-label="Edit" />
              </tr>
            </thead>
            <tbody>
              {PAYROLL_BUDGET_KINDS.map((k) => {
                const ws = every(k)
                return (
                  <tr key={k}>
                    <td>{PAYROLL_BUDGET_KIND_LABELS[k]}</td>
                    <td>
                      {!ws ? (
                        <span className="text-soft">
                          Each engagement&apos;s{' '}
                          {REPORT_LINE_LABELS[PAYROLL_BUDGET_DEFAULTS[k][0]!]} line
                        </span>
                      ) : ws.budgetLineName ? (
                        ws.budgetLineName
                      ) : (
                        <span className="ad-chip ad-chip-muted">{NOWHERE}</span>
                      )}
                    </td>
                    <td>
                      {own(k)
                        .map((o) => `${nameOf(o.engagementId!)}: ${nameOr(o.budgetLineName)}`)
                        .join(', ') || <span className="text-soft">None</span>}
                    </td>
                    <td className="text-right">
                      <Button
                        kind="navy"
                        size="sm"
                        onClick={() => setEditing(k)}
                        aria-label={`Edit ${PAYROLL_BUDGET_KIND_LABELS[k]}`}
                      >
                        Edit
                      </Button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
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
  const ws = data.entries.find((e) => e.kind === kind && e.engagementId === null)
  const [every, setEvery] = useState<string>(
    ws ? (ws.budgetLineName ?? NONE) : '' // no entry yet: chosen here
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

  const input: PayrollRollupInput | null = every
    ? {
        every: every === NONE ? null : every,
        own: Object.entries(own)
          .filter(([, v]) => v !== SAME)
          .map(([engagementId, v]) => ({ engagementId, budgetLineName: v === NONE ? null : v })),
      }
    : null
  const body = JSON.stringify(input)

  // What Save would change, worked out again as the choices change.
  useEffect(() => {
    if (!input) return setPreview(null)
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
    if (!input) return
    setBusy(true)
    setError(null)
    try {
      onSaved(await api.put<PayrollRollupSaved>(`${path}/${kind}`, input))
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  const months =
    preview?.changes.flatMap((c) => c.backToDraft.map((m) => ({ ...m, name: c.name }))) ?? []
  return (
    <Modal title={`Where ${label} goes`} onClose={onClose} wide>
      <ErrorNote message={error} />
      <div className="grid gap-4">
        <Field label="Every engagement" required error={!every ? 'Choose a budget line' : null}>
          <select className={inputClass} value={every} onChange={(e) => setEvery(e.target.value)}>
            <option value="" disabled>
              Choose a budget line
            </option>
            {lineNames.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
            <option value={NONE}>{NOWHERE}</option>
          </select>
        </Field>
        {data.engagements.length > 0 && (
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-semibold">Engagements with their own line</legend>
            {data.engagements.map((e) => (
              <label key={e.id} className="grid items-center gap-2 text-sm sm:grid-cols-[1fr_1fr]">
                <span>{e.name}</span>
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
              </label>
            ))}
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
        {preview && preview.changes.length === 0 && (
          <p className="text-sm text-soft">No engagement&apos;s line changes.</p>
        )}
      </div>
      <div className="mt-6 flex justify-end gap-3">
        <Button kind="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button kind="navy" onClick={() => void save()} disabled={busy || !preview}>
          Save
        </Button>
      </div>
    </Modal>
  )
}
