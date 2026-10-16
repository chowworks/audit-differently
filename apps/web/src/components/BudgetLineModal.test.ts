import { describe, expect, it } from 'vitest'
import type { ReportSummary } from '@ad/types'
import { recheckNotice, recheckWarning } from './BudgetLineModal'

const month = (period: string, status: ReportSummary['status']) =>
  ({ id: period, period, status }) as ReportSummary

describe('a budget change re-checks every month and puts closed and submitted ones back to draft', () => {
  it('says before saving how many closed and submitted months go back to draft', () => {
    expect(recheckWarning({ reports: [month('2026-10', 'draft')] })).toBeNull()
    expect(
      recheckWarning({
        reports: [
          month('2026-07', 'submitted'),
          month('2026-08', 'submitted'),
          month('2026-09', 'closed'),
          month('2026-10', 'draft'),
        ],
      })
    ).toBe(
      'Saving re-checks every month. 1 closed and 2 submitted months go back to draft: approve their closing again and send them again.'
    )
    expect(recheckWarning({ reports: [month('2026-09', 'closed')] })).toBe(
      'Saving re-checks every month. 1 closed month goes back to draft: approve its closing again and send it again.'
    )
    expect(
      recheckWarning({ reports: [month('2026-08', 'submitted'), month('2026-09', 'submitted')] })
    ).toBe(
      'Saving re-checks every month. 2 submitted months go back to draft: approve their closing again and send them again.'
    )
  })

  it('names the months the change put back to draft, and what each was', () => {
    expect(recheckNotice({ backToDraft: [] })).toBeNull()
    expect(
      recheckNotice({
        backToDraft: [
          { id: 'r-1', period: '2026-08', was: 'submitted' },
          { id: 'r-2', period: '2026-09', was: 'closed' },
        ],
      })
    ).toBe(
      'Back to draft: August 2026 (was submitted), September 2026 (was closed). Approve their closing again and send them again.'
    )
    expect(recheckNotice({ backToDraft: [{ id: 'r-2', period: '2026-09', was: 'closed' }] })).toBe(
      'Back to draft: September 2026 (was closed). Approve its closing again and send it again.'
    )
  })
})
