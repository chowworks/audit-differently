import type { BudgetChange, EngagementDetail } from '@ad/types'
import { periodLabel } from '@/lib/format'

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
