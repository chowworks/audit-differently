import { useState } from 'react'
import { REPORT_LINE_LABELS, type BudgetChange, type EngagementDetail } from '@ad/types'
import { useApi } from '@/hooks/useApi'
import { periodLabel } from '@/lib/format'
import { Button, ErrorNote, Field, Modal, MoneyInput, Notice, inputClass } from '@/components/ui'

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
 * One line of the approved budget (step 4): add one of the workspace's budget items, or change or remove a line.
 * Owners and bookkeepers only; the page shows an auditor the lines without this.
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
  const unused = c.budgetOptions.filter((i) => !c.budgetLines.some((b) => b.category === i.key))
  const [category, setCategory] = useState(line?.category ?? unused[0]?.key ?? '')
  const [amount, setAmount] = useState<number | null>(line ? line.amount : null)
  const [narrative, setNarrative] = useState(line?.narrative ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const item = c.budgetOptions.find((i) => i.key === category)
  const warning = recheckWarning(c)
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
  const save = () =>
    run(() =>
      line
        ? api.patch<BudgetChange>(`${base}/${line.id}`, { amount, narrative })
        : api.post<BudgetChange>(base, { category, amount, narrative })
    )
  const remove = () => {
    if (!line || !confirm(`Remove ${line.label} from the approved budget?`)) return
    void run(() => api.del<BudgetChange>(`${base}/${line.id}`))
  }
  return (
    <Modal title={line ? line.label : 'Add a budget line'} onClose={onClose}>
      <ErrorNote message={error} />
      {warning && <Notice tone="warn">{warning}</Notice>}
      <div className="grid gap-4">
        {line ? (
          <p className="text-sm text-soft">Reports as {REPORT_LINE_LABELS[line.reportLine]}.</p>
        ) : unused.length === 0 ? (
          <p className="text-sm text-soft">
            Every budget item of the workspace is on this budget. An owner adds items in the
            workspace settings.
          </p>
        ) : (
          <Field
            label="Budget item"
            hint={item ? `Reports as ${REPORT_LINE_LABELS[item.reportLine]}` : undefined}
          >
            <select
              className={inputClass}
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              {unused.map((i) => (
                <option key={i.key} value={i.key}>
                  {i.label}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Approved amount" hint="As the approved budget states it. Blank is $0.">
          <MoneyInput value={amount} onChange={setAmount} autoFocus />
        </Field>
        <Field label="Narrative" hint="What the budget narrative says this line pays for">
          <textarea
            className={inputClass}
            rows={3}
            value={narrative}
            onChange={(e) => setNarrative(e.target.value)}
          />
        </Field>
      </div>
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
        <div>
          {line && (
            <Button kind="danger" onClick={remove} disabled={busy}>
              Remove line
            </Button>
          )}
        </div>
        <div className="ad-actions">
          <Button kind="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button kind="primary" onClick={save} disabled={busy || (!line && !item)}>
            {line ? 'Save' : 'Add line'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
