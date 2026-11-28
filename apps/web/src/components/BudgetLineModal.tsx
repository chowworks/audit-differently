import { useState } from 'react'
import { Link } from 'react-router-dom'
import {
  aliasKey,
  lineKey,
  type LineAliasesDto,
  PAYROLL_BUDGET_KINDS,
  PAYROLL_BUDGET_KIND_LABELS,
  payrollPlace,
  type PayrollRollupDto,
  REPORT_LINES,
  REPORT_LINE_LABELS,
  type BudgetChange,
  type EngagementDetail,
  type PayrollBudgetKind,
  type ReportLine,
} from '@ad/types'
import { useApi, useLoad } from '@/hooks/useApi'
import { periodLabel } from '@/lib/format'
import { Button, ErrorNote, Field, Modal, MoneyInput, inputClass } from '@/components/ui'

type Line = EngagementDetail['budgetLines'][number]

/**
 * Before saving: a budget change re-checks every month and puts every closed and submitted month back to draft, to
 * be approved and sent again.
 */
export function recheckWarning(c: Pick<EngagementDetail, 'reports'>): string | null {
  const closed = c.reports.filter((r) => r.status === 'closed').length
  const submitted = c.reports.filter((r) => r.status === 'submitted').length
  if (closed + submitted === 0) return null
  const which = [closed && `${closed} closed`, submitted && `${submitted} submitted`]
    .filter(Boolean)
    .join(' and ')
  const one = closed + submitted === 1
  return `Saving re-checks every month. ${which} ${one ? 'month goes' : 'months go'} back to draft: approve ${one ? 'its' : 'their'} closing again and send ${one ? 'it' : 'them'} again.`
}

/** After saving: the months the change put back to draft, by name. */
export function recheckNotice(saved: Pick<BudgetChange, 'backToDraft'>): string | null {
  const months = saved.backToDraft
  if (months.length === 0) return null
  const names = months.map((m) => `${periodLabel(m.period)} (was ${m.was})`)
  const one = months.length === 1
  return `Back to draft: ${names.join(', ')}. Approve ${one ? 'its' : 'their'} closing again and send ${one ? 'it' : 'them'} again.`
}

/**
 * One line of the approved budget (step 4): the line of the funder's monthly report it is, its approved amount, its
 * name (the report line's own, unless the contract's budget names it differently, e.g. a funder who itemizes) and a
 * note. Owners and bookkeepers only, from Manage Budget.
 */
export function BudgetLineModal({
  engagement: c,
  line,
  preset,
  onClose,
  onSaved,
}: {
  engagement: EngagementDetail
  /** The line to change; none to add one. */
  line?: Line
  /** Opened for payroll no line takes (the payroll page): its report line, and the payroll Save puts on this line. */
  preset?: { reportLine: ReportLine; payroll: PayrollBudgetKind[] }
  onClose: () => void
  /** Gets the engagement as saved, so the page shows it without fetching it again. */
  onSaved: (saved: BudgetChange) => void
}) {
  const api = useApi()
  const [reportLine, setReportLine] = useState<ReportLine | ''>(
    line?.reportLine ?? preset?.reportLine ?? ''
  )
  const [name, setName] = useState(
    line?.name ?? (preset ? REPORT_LINE_LABELS[preset.reportLine] : '')
  )
  const [amount, setAmount] = useState<number | null>(line ? line.amount : null)
  const [narrative, setNarrative] = useState(line?.narrative ?? '')
  // The payroll on a line comes from Map Payroll Budget Line Items (#138); the payroll page asks for its kind here.
  const asked = (preset?.payroll ?? []).filter((k) => !line?.payroll.includes(k))
  // A kind of payroll this change would leave with two lines it could be, or none, is asked about before Save
  // (owner's decision, 2026-11-27): "Which holds it?", kept as this engagement's own choice.
  const rollup = useLoad<PayrollRollupDto>(`/workspaces/${c.workspaceId}/payroll-rollup`)
  const [choices, setChoices] = useState<Partial<Record<PayrollBudgetKind, string>>>({})
  const unclear = (() => {
    const entries = rollup.data?.entries ?? []
    if (!rollup.data || !name.trim() || !reportLine) return []
    const before = c.budgetLines.map((b) => ({ name: b.name, reportLine: b.reportLine }))
    const after = line
      ? c.budgetLines.map((b) => (b.id === line.id ? { name: name.trim(), reportLine } : b))
      : [...before, { name: name.trim(), reportLine }]
    // As Save keeps it: what the line holds, and what the payroll page asks for, stay on it.
    const kept = new Set([...(line?.payroll ?? []), ...asked])
    const own = (k: PayrollBudgetKind) =>
      kept.has(k) ? [{ kind: k, engagementId: c.id, budgetLineName: name.trim() }] : []
    return PAYROLL_BUDGET_KINDS.flatMap((k) => {
      const was = payrollPlace(k, c.id, entries, before)
      const now = payrollPlace(k, c.id, [...entries, ...own(k)], after)
      if (now.by !== 'unclear' || was.by === 'unclear') return []
      return [{ kind: k, choices: (now.choices.length ? now.choices : after).map((l) => l.name) }]
    })
  })()
  const NOWHERE = '__none__'
  const choicesWait = unclear.some((u) => !choices[u.kind])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Renaming a line (decision 6 of #132): the QuickBooks names that go to its old name are shown, and follow it on Save.
  const list = useLoad<LineAliasesDto>(line ? `/workspaces/${c.workspaceId}/line-aliases` : null)
  const renamed = !!line && !!name.trim() && lineKey(name) !== lineKey(line.name)
  const following = renamed
    ? (list.data?.aliases ?? []).filter(
        (a) =>
          !a.unallowable &&
          (a.engagementId === null || a.engagementId === c.id) &&
          lineKey(a.budgetLineName ?? '') === lineKey(line!.name) &&
          // An override of this engagement wins over the workspace's entry of the same name.
          !(
            a.engagementId === null &&
            (list.data?.aliases ?? []).some(
              (o) => o.engagementId === c.id && aliasKey(o.name) === aliasKey(a.name)
            )
          )
      )
    : []
  const warning = recheckWarning(c)
  const taken = new Set(c.budgetLines.filter((b) => b.id !== line?.id).map((b) => lineKey(b.name)))
  const suggestions = c.budgetNameSuggestions.filter((n) => !taken.has(lineKey(n)))
  const nameTaken = taken.has(lineKey(name))
  // A rename waits for the list of what follows it, so Save never moves names the screen didn't show.
  const renameWaits = renamed && (list.loading || !!list.error)
  // The name follows the report line until the person gives it one of its own.
  const pickLine = (next: ReportLine) => {
    const own = name.trim() && name.trim() !== (reportLine ? REPORT_LINE_LABELS[reportLine] : '')
    setReportLine(next)
    if (!own) setName(REPORT_LINE_LABELS[next])
  }
  const run = async (fn: () => Promise<BudgetChange>) => {
    setBusy(true)
    setError(null)
    try {
      onSaved(await fn())
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }
  const base = `/engagements/${c.id}/budget-lines`
  const payrollChoices = Object.fromEntries(
    unclear.map((u) => [u.kind, choices[u.kind] === NOWHERE ? null : choices[u.kind]])
  )
  const body = {
    name,
    reportLine,
    amount,
    narrative,
    ...(asked.length ? { payroll: asked } : {}),
    ...(unclear.length ? { payrollChoices } : {}),
  }
  const save = () =>
    run(() =>
      line
        ? api.patch<BudgetChange>(`${base}/${line.id}`, body)
        : api.post<BudgetChange>(base, body)
    )
  const remove = () => {
    if (!line || !confirm(`Remove ${line.name} from the approved budget?`)) return
    void run(() => api.del<BudgetChange>(`${base}/${line.id}`))
  }
  const ready =
    !busy &&
    !!name.trim() &&
    !!reportLine &&
    !nameTaken &&
    !renameWaits &&
    !rollup.loading &&
    !choicesWait
  return (
    <Modal title={line ? `Edit ${line.name}` : 'Add a budget line'} onClose={onClose}>
      <ErrorNote message={error} />
      <div className="grid gap-4">
        <div className="grid gap-4 sm:grid-cols-[3fr_2fr]">
          <Field
            label="Monthly report line"
            required
            hint={line?.hasSpending ? 'Fixed: it has spending' : undefined}
          >
            <select
              className={inputClass}
              value={reportLine}
              disabled={line?.hasSpending}
              onChange={(e) => pickLine(e.target.value as ReportLine)}
              autoFocus={!line}
            >
              <option value="" disabled>
                Choose a line of the report
              </option>
              {REPORT_LINES.map((l) => (
                <option key={l} value={l}>
                  {REPORT_LINE_LABELS[l]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Approved amount">
            <MoneyInput value={amount} onChange={setAmount} />
          </Field>
        </div>
        <Field
          label="Name"
          required
          hint="The report line's own, unless the contract's budget names it differently"
          error={
            nameTaken
              ? 'This engagement already has a line of that name'
              : renamed && list.error
                ? "The financial categories that use this name couldn't be loaded, so it can't be renamed yet."
                : null
          }
        >
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
          <NameSuggestions names={suggestions} typed={name} onPick={setName} />
          {renamed && list.error && (
            <button type="button" className="wpd-linkbtn" onClick={() => void list.reload()}>
              Try again
            </button>
          )}
        </Field>
        {following.length > 0 && (
          <div className="text-sm">
            <p className="font-semibold">
              {following.length === 1
                ? 'This financial category maps'
                : 'These financial categories map'}{' '}
              to {line!.name} and will go to {name.trim()} after Save:
            </p>
            <ul className="ml-5 list-disc">
              {following.map((a) => (
                <li key={a.id}>
                  {a.name}
                  {a.engagementId ? ' (this engagement only)' : ''}
                </li>
              ))}
            </ul>
            <p className="text-soft">
              To send one somewhere else, change it under Map Financial Categories on the workspace
              page.
            </p>
          </div>
        )}
        <div className="text-sm">
          <p className="font-semibold">Payroll Category</p>
          {renamed && line!.payroll.length > 0 && (
            <p className="font-semibold">
              {line!.payroll.length === 1
                ? 'This payroll category maps'
                : 'These payroll categories map'}{' '}
              to {line!.name} and will go to {name.trim()} after Save.
            </p>
          )}
          {[...(line?.payroll ?? []), ...asked].length ? (
            <ul className="ml-5 list-disc">
              {[...(line?.payroll ?? []), ...asked].map((k) => (
                <li key={k}>
                  {PAYROLL_BUDGET_KIND_LABELS[k]}: Maps to Budget Line Item{' '}
                  <strong>{name.trim() || line?.name}</strong>
                  {asked.includes(k) && ' after Save, for this engagement'}
                </li>
              ))}
            </ul>
          ) : (
            <p>None maps to this line.</p>
          )}
          <small className="text-soft">
            Set by name under{' '}
            <Link to={`/workspaces/${c.workspaceId}#payroll-rollup`}>
              Map Payroll Budget Line Items
            </Link>{' '}
            on the workspace page.
          </small>
        </div>
        {unclear.map((u) => (
          <Field
            key={u.kind}
            label={`Which line holds ${PAYROLL_BUDGET_KIND_LABELS[u.kind].toLowerCase()}?`}
            required
            hint={
              u.choices.length > 1
                ? `After Save it could go to ${u.choices.join(' or ')}`
                : 'After Save no line fits it'
            }
            error={choices[u.kind] ? null : 'Choose one'}
          >
            <select
              className={inputClass}
              value={choices[u.kind] ?? ''}
              onChange={(e) => setChoices({ ...choices, [u.kind]: e.target.value })}
            >
              <option value="" disabled>
                Choose a budget line
              </option>
              {u.choices.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
              <option value={NOWHERE}>Not on the budget</option>
            </select>
          </Field>
        ))}
        <Field label="Note">
          <input
            className={inputClass}
            placeholder="Optional, e.g. reduced from $3,000 at award"
            value={narrative}
            onChange={(e) => setNarrative(e.target.value)}
          />
        </Field>
      </div>
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          {line &&
            (line.hasSpending ? (
              <span className="text-xs text-soft">Has spending, so it stays</span>
            ) : (
              <Button kind="ghost" className="text-danger" onClick={remove} disabled={busy}>
                Remove line
              </Button>
            ))}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3">
          {warning && <span className="max-w-[260px] text-right text-xs text-soft">{warning}</span>}
          <Button kind="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button kind="primary" onClick={() => void save()} disabled={!ready}>
            {line ? 'Save' : 'Add line'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

/**
 * The names this workspace's other engagements give their budget lines, as pills under the name: pressing one fills
 * it, so the same line is named the same everywhere. Filtered by what is typed; hidden once the name is one of them.
 */
function NameSuggestions({
  names,
  typed,
  onPick,
}: {
  names: string[]
  typed: string
  onPick: (name: string) => void
}) {
  const t = typed.trim().toLowerCase()
  if (names.some((n) => n.toLowerCase() === t)) return null
  const shown = names.filter((n) => !t || n.toLowerCase().includes(t)).slice(0, 8)
  if (!shown.length) return null
  return (
    <span className="mt-2 flex flex-wrap items-center gap-2 text-xs">
      <span className="text-soft">Used in other engagements:</span>
      {shown.map((n) => (
        <button key={n} type="button" className="ad-chip ad-chip-muted" onClick={() => onPick(n)}>
          {n}
        </button>
      ))}
    </span>
  )
}
