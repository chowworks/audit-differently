import { describe, expect, it } from 'vitest'
import type { BooksLineDto } from '@ad/types'
import { engagementGroups, notOnEngagements, saveCounts, shareWords } from './workspace-expenses'

const line = (over: Partial<BooksLineDto>): BooksLineDto => ({
  key: 'k',
  transactionId: '9001',
  date: '2026-09-02',
  type: 'Expense',
  vendor: 'Maple Properties',
  description: '',
  account: '60901 Rent Expense',
  accountNo: '60901',
  className: 'Youth Coding Program',
  amount: 100,
  paidFrom: null,
  status: 'billed',
  engagementId: 'e-ycp',
  engagementName: 'Youth Coding Pathway',
  category: 'INDIRECT COSTS',
  budgetLineId: 'b-ind',
  budgetLineName: 'Indirect Costs',
  allocation: null,
  saved: null,
  ...over,
})

describe("the month's expenses from the books, on screen", () => {
  const lines = [
    line({ key: 'a', date: '2026-09-20', amount: 50, saved: 'same' }),
    line({ key: 'b', date: '2026-09-02', amount: 25.5, saved: 'changed' }),
    line({ key: 'c', status: 'already-entered', amount: 99 }),
    line({ key: 'd', status: 'not-ours', engagementId: null, amount: 10 }),
    line({ key: 'e', status: 'not-ours', engagementId: null, amount: 5.25 }),
    line({ key: 'f', status: 'no-class', engagementId: null, className: '', amount: 7 }),
  ]

  it("groups each engagement's lines in date order, totalling those Save writes", () => {
    const [g] = engagementGroups(lines)
    expect(g!.lines.map((l) => l.key)).toEqual(['b', 'c', 'a'])
    expect(g!.total).toBe(75.5)
  })

  it('lists the lines on no engagement by why, in the order the reasons are kept', () => {
    expect(notOnEngagements(lines).map((n) => [n.status, n.lines.length, n.total])).toEqual([
      ['no-class', 1, 7],
      ['not-ours', 2, 15.25],
    ])
  })

  it('counts what Save would add and change', () => {
    expect(saveCounts([...lines, line({ key: 'g' })])).toEqual({ add: 1, change: 1, same: 1 })
  })

  it("words a shared line's share", () => {
    const money = (n: number) => `$${n.toFixed(2)}`
    expect(
      shareWords(
        line({
          allocation: {
            total: 200,
            percent: 25,
            how: 'entry',
            entryId: '9005',
            sourceIds: ['9004'],
          },
        }),
        money
      )
    ).toBe('25.00% of $200.00 (allocation entry 9005)')
    expect(shareWords(line({}), money)).toBeNull()
  })
})
