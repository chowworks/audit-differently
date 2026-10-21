import { describe, expect, it } from 'vitest'
import type { CheckDto, ReportDetail } from '@ad/types'
import { placeChecks } from './LayoutC'

const check = (id: string, on: Partial<CheckDto>): CheckDto => ({
  id,
  code: 'missing-proof' as CheckDto['code'],
  severity: 'blocker',
  source: 'rule' as CheckDto['source'],
  message: `Check ${id}`,
  status: 'open' as CheckDto['status'],
  expenseId: null,
  participantId: null,
  wexPaymentId: null,
  ...on,
})

const month = (seeStaffPayroll: boolean | undefined) =>
  ({
    expenses: [
      { id: 'supplies', reportLine: 'supplies' },
      { id: 'salary', reportLine: 'staff-salaries' },
    ],
    wexPayments: [{ id: 'wex', participantId: 'p1' }],
    budgetLines: [],
    checks: [
      check('on-supplies', { expenseId: 'supplies' }),
      check('on-salary', { expenseId: 'salary' }),
      check('on-wex', { wexPaymentId: 'wex' }),
      check('on-participant', { participantId: 'p1' }),
      check('whole-month', {}),
    ],
    can: { seeStaffPayroll },
  }) as unknown as ReportDetail

const ids = (r: ReportDetail) => placeChecks(r).loose.map((k) => k.id)

describe('the checks on the whole month', () => {
  // "Bookkeepers see staff payroll" off still shows the payroll rows (as labels), so their checks stay on them.
  it('leaves row checks on their rows, whether the payroll files show or not', () => {
    expect(ids(month(true))).toEqual(['whole-month'])
    expect(ids(month(undefined))).toEqual(['whole-month'])
    expect(ids(month(false))).toEqual(['whole-month'])
  })
})
