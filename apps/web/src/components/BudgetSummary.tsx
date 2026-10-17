import { REPORT_LINE_LABELS, type EngagementDetail } from '@ad/types'
import { money } from '@/lib/format'
import { Button, Modal } from '@/components/ui'

type Line = EngagementDetail['budgetLines'][number]

const total = (lines: Line[], f: (l: Line) => number) => lines.reduce((t, l) => t + f(l), 0)

/** The lines as one table: approved, spent to date and what is left, a total, and Edit. */
function LinesTable({
  lines,
  canManage,
  onEdit,
}: {
  lines: Line[]
  canManage: boolean
  onEdit: (line: Line) => void
}) {
  return (
    <div className="ad-tablewrap">
      <table className="ad-table">
        <thead>
          <tr>
            <th>Budget line</th>
            <th>Rolls up to</th>
            <th className="ad-num">Approved</th>
            <th className="ad-num">Spent</th>
            <th className="ad-num">Left</th>
            {canManage && <th></th>}
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => {
            const left = l.amount - l.spent
            return (
              <tr key={l.id}>
                <td>
                  <span className="font-semibold">{l.name}</span>
                  {l.narrative && <span className="ad-table-sub">{l.narrative}</span>}
                </td>
                <td className="text-sm">{REPORT_LINE_LABELS[l.reportLine]}</td>
                <td className="ad-num">{money(l.amount)}</td>
                <td className="ad-num">{money(l.spent)}</td>
                <td className={`ad-num ${left < 0 ? 'text-danger font-bold' : ''}`}>
                  {money(left)}
                </td>
                {canManage && (
                  <td className="ad-num">
                    <Button size="sm" onClick={() => onEdit(l)}>
                      Edit
                    </Button>
                  </td>
                )}
              </tr>
            )
          })}
          <tr>
            <td className="font-bold">Total</td>
            <td></td>
            <td className="ad-num font-bold">{money(total(lines, (l) => l.amount))}</td>
            <td className="ad-num font-bold">{money(total(lines, (l) => l.spent))}</td>
            <td className="ad-num font-bold">{money(total(lines, (l) => l.amount - l.spent))}</td>
            {canManage && <td></td>}
          </tr>
        </tbody>
      </table>
    </div>
  )
}

/**
 * Step 4's approved budget at a glance, as the participants and months steps show theirs: spent against approved, and
 * the lines over budget. The lines themselves are in Manage Budget.
 */
export function BudgetSummary({ lines, onManage }: { lines: Line[]; onManage: () => void }) {
  const approved = total(lines, (l) => l.amount)
  const spent = total(lines, (l) => l.spent)
  const pct = approved ? Math.min(100, Math.round((spent / approved) * 100)) : 0
  const over = lines.filter((l) => l.spent > l.amount)
  return (
    <div id="budget" className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-3">
      <div className="min-w-[220px] flex-1">
        {lines.length === 0 ? (
          <p className="text-sm text-soft">
            No approved budget yet. Add one line per line of the monthly report it uses.
          </p>
        ) : (
          <>
            <div className="mb-1 flex justify-between text-sm">
              <b>
                {money(spent)} of {money(approved)} spent · {lines.length} budget line
                {lines.length === 1 ? '' : 's'}
              </b>
              <span className="text-soft">{pct}%</span>
            </div>
            <div className="ad-progress">
              <i style={{ width: `${pct}%` }} />
            </div>
            {over.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="ad-check-dot bad" aria-hidden="true">
                  !
                </span>
                <span className="text-xs font-bold text-danger">Over budget</span>
                {over.map((l) => (
                  <button
                    key={l.id}
                    type="button"
                    className="ad-chip ad-chip-danger"
                    onClick={onManage}
                  >
                    {l.name} · {money(l.spent - l.amount)} over
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
      <Button size="sm" onClick={onManage}>
        Manage Budget
      </Button>
    </div>
  )
}

/** Manage Budget: every line with approved, spent and left; owners and bookkeepers add and edit lines here. */
export function ManageBudgetModal({
  lines,
  canManage,
  onAdd,
  onEdit,
  onClose,
}: {
  lines: Line[]
  canManage: boolean
  onAdd: () => void
  onEdit: (line: Line) => void
  onClose: () => void
}) {
  return (
    <Modal title="Manage Budget" onClose={onClose} wide>
      {lines.length === 0 ? (
        <p className="text-sm text-soft">No budget lines yet.</p>
      ) : (
        <LinesTable lines={lines} canManage={canManage} onEdit={onEdit} />
      )}
      {canManage && (
        <div className="mt-4">
          <Button size="sm" onClick={onAdd}>
            + Add line
          </Button>
        </div>
      )}
    </Modal>
  )
}
