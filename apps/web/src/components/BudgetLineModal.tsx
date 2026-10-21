import { useState } from 'react'
import {
  PAYROLL_BUDGET_KINDS,
  PAYROLL_BUDGET_KIND_LABELS,
  REPORT_LINES,
  REPORT_LINE_LABELS,
  type BudgetChange,
  type EngagementDetail,
  type PayrollBudgetKind,
  type ReportLine,
} from '@ad/types'
import { useApi } from '@/hooks/useApi'
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
  onClose,
  onSaved,
}: {
  engagement: EngagementDetail
  /** The line to change; none to add one. */
  line?: Line
  onClose: () => void
  /** Gets the engagement as saved, so the page shows it without fetching it again. */
  onSaved: (saved: BudgetChange) => void
}) {
  const api = useApi()
  const [reportLine, setReportLine] = useState<ReportLine | ''>(line?.reportLine ?? '')
  const [name, setName] = useState(line?.name ?? '')
  const [amount, setAmount] = useState<number | null>(line ? line.amount : null)
  const [narrative, setNarrative] = useState(line?.narrative ?? '')
  // A new line left as it is takes its report line's payroll by default (the server's); ticked, it is sent.
  const [payroll, setPayroll] = useState<PayrollBudgetKind[] | null>(line ? line.payroll : null)
  /** The other line holding each kind now: ticking it here moves it. */
  const heldBy = (k: PayrollBudgetKind) =>
    c.budgetLines.find((b) => b.id !== line?.id && b.payroll.includes(k))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const warning = recheckWarning(c)
  const taken = new Set(
    c.budgetLines.filter((b) => b.id !== line?.id).map((b) => b.name.toLowerCase())
  )
  const suggestions = c.budgetNameSuggestions.filter((n) => !taken.has(n.toLowerCase()))
  const nameTaken = taken.has(name.trim().toLowerCase())
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
  const body = { name, reportLine, amount, narrative, ...(payroll ? { payroll } : {}) }
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
  const ready = !busy && !!name.trim() && !!reportLine && !nameTaken
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
          error={nameTaken ? 'This engagement already has a line of that name' : null}
        >
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
          <NameSuggestions names={suggestions} typed={name} onPick={setName} />
        </Field>
        <Field
          label="Payroll from the match on this line"
          hint={
            payroll === null
              ? 'Left as it is, the line takes the payroll its report line holds, if no other line does.'
              : 'What Save puts here from the month’s payroll match. Each kind is on one line only.'
          }
        >
          <span className="grid gap-1 sm:grid-cols-2">
            {PAYROLL_BUDGET_KINDS.map((k) => {
              const other = heldBy(k)
              const on = (payroll ?? []).includes(k)
              return (
                <label key={k} className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={(e) =>
                      setPayroll(
                        PAYROLL_BUDGET_KINDS.filter((x) =>
                          x === k ? e.target.checked : (payroll ?? []).includes(x)
                        )
                      )
                    }
                  />
                  <span>
                    {PAYROLL_BUDGET_KIND_LABELS[k]}
                    {other && (
                      <small className="block text-soft">
                        {on ? `Moves here from ${other.name}` : `On ${other.name}`}
                      </small>
                    )}
                  </span>
                </label>
              )
            })}
          </span>
        </Field>
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
