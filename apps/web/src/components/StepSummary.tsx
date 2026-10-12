import { Button } from '@/components/ui'

export interface SummaryRow {
  key: string
  label: string
  note?: string
  done: boolean
  /** Something blocking, not merely pending. */
  bad?: boolean
  /** Jumps to the place where this one gets fixed. */
  onClick: () => void
}

/**
 * A recurring step (participants, months): how many are complete, a bar, and what is still pending as red
 * chips that jump straight to the fix. The full list stays in a dialog: sixty participants or twelve months
 * would bury the steps around it.
 */
export function StepSummary({
  rows,
  unit,
  empty,
  action,
  extra,
}: {
  rows: SummaryRow[]
  /** Singular, e.g. "participant" or "month". */
  unit: string
  /** Shown instead of a count when there is nothing to count yet. */
  empty: string
  action: { label: string; onClick: () => void }
  extra?: React.ReactNode
}) {
  const have = rows.filter((r) => r.done).length
  const total = rows.length
  const pending = rows.filter((r) => !r.done)
  const pct = total === 0 ? 0 : Math.round((have / total) * 100)
  const more = pending.length - 3
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-3">
      <div className="min-w-[220px] flex-1">
        {total === 0 ? (
          <p className="text-sm text-soft">{empty}</p>
        ) : (
          <>
            <div className="mb-1 flex justify-between text-sm">
              <b>
                {have} of {total} {unit}
                {total === 1 ? '' : 's'} complete
              </b>
              <span className="text-soft">{pct}%</span>
            </div>
            <div className="ad-progress">
              <i style={{ width: `${pct}%` }} />
            </div>
            {pending.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="ad-check-dot bad" aria-hidden="true">
                  !
                </span>
                <span className="text-xs font-bold text-danger">Pending</span>
                {pending.slice(0, 3).map((r) => (
                  <button
                    key={r.key}
                    type="button"
                    className={`ad-chip ad-chip-danger ${r.bad ? 'ad-chip-fill' : ''}`}
                    title={r.note ? `${r.label}: ${r.note}` : r.label}
                    onClick={r.onClick}
                  >
                    {r.label}
                    {r.note && (
                      <span className="font-medium normal-case tracking-normal"> · {r.note}</span>
                    )}
                  </button>
                ))}
                {more > 0 && (
                  <button type="button" className="ad-chip ad-chip-muted" onClick={action.onClick}>
                    +{more} more
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {extra}
        <Button size="sm" onClick={action.onClick}>
          {action.label}
        </Button>
      </div>
    </div>
  )
}
