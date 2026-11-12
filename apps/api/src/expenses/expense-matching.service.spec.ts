import { DEFAULT_EXPENSE_MATCHING } from '@ad/types'
import { ExpenseMatchingService, matchingChanges } from './expense-matching.service'

describe("the expense matching's day windows (owner's decision, 2026-11-12)", () => {
  it('takes a whole number of days for each, 0 to 60, and names every problem at once', () => {
    expect(ExpenseMatchingService.check({ receiptDays: 10, paymentDays: 3 })).toEqual({
      matching: { receiptDays: 10, paymentDays: 3 },
      problems: [],
    })
    expect(
      ExpenseMatchingService.check({ receiptDays: 1.5, paymentDays: 61 }).problems.map(
        (p) => p.field
      )
    ).toEqual(['receiptDays', 'paymentDays'])
    expect(ExpenseMatchingService.check(null).problems).toHaveLength(2)
  })

  it('says what a save changed', () => {
    expect(matchingChanges(DEFAULT_EXPENSE_MATCHING, { receiptDays: 7, paymentDays: 10 })).toEqual([
      'Payment days from a bill: 5 → 10 days',
    ])
    expect(matchingChanges(DEFAULT_EXPENSE_MATCHING, DEFAULT_EXPENSE_MATCHING)).toEqual([
      'No change',
    ])
  })
})
