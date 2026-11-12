import { describe, expect, it } from 'vitest'
import type { BooksLineDto } from '@ad/types'
import {
  engagementGroups,
  notOnEngagements,
  paidWords,
  receiptWords,
  saveCounts,
  shareWords,
  unmatchedReceipts,
} from './workspace-expenses'

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
  bills: [],
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

  it('says where a line was paid from, and an account booked from when it is neither bank nor card', () => {
    expect(paidWords(line({ paidFrom: { account: '22001 Card', kind: 'card' } }))).toBe(
      'paid from a card'
    )
    expect(paidWords(line({ paidFrom: { account: '10000 Checking', kind: 'bank' } }))).toBe(
      'paid from the bank'
    )
    expect(
      paidWords(
        line({ paidFrom: { account: '13000 Assets:13100 Prepaid Expenses', kind: 'other' } })
      )
    ).toBe('booked from 13100 Prepaid Expenses')
    expect(paidWords(line({}))).toBeNull()
  })

  it('totals a pool and the entry that shares it out as 0, not -0', () => {
    const [pool] = notOnEngagements([
      line({ key: 'p1', status: 'allocation-pool', engagementId: null, amount: 496.14 }),
      line({ key: 'p2', status: 'allocation-pool', engagementId: null, amount: 195.95 }),
      line({ key: 'p3', status: 'allocation-pool', engagementId: null, amount: -692.09 }),
    ])
    expect(Object.is(pool!.total, 0)).toBe(true)
  })

  it("says how many of a line's bills have a receipt, dropped ones aside (owner's decision, 2026-11-12)", () => {
    const bill = (id: string, receipt: boolean, dropped = false) => ({
      transactionId: id,
      date: '2026-09-08',
      vendor: 'PayPeople',
      amount: 10,
      receipt: receipt
        ? { documentId: `r-${id}`, fileName: `${id}.pdf`, by: 'auto' as const }
        : null,
      dropped,
    })
    expect(receiptWords(line({}))).toBeNull()
    expect(receiptWords(line({ bills: [bill('1', true)] }))).toEqual({
      words: 'Receipt',
      complete: true,
    })
    expect(receiptWords(line({ bills: [bill('1', false)] }))).toEqual({
      words: 'No receipt',
      complete: false,
    })
    expect(receiptWords(line({ bills: [bill('1', false, true)] }))).toEqual({
      words: 'Dropped: no receipt',
      complete: false,
    })
    expect(
      receiptWords(line({ bills: [bill('1', true), bill('2', false), bill('3', false, true)] }))
    ).toEqual({ words: '1 of 2 bills have a receipt (1 dropped)', complete: false })
    expect(receiptWords(line({ bills: [bill('1', true), bill('2', false, true)] }))?.complete).toBe(
      true
    )
  })

  it('lists the receipts that prove no bill yet', () => {
    const r = (id: string, transactionIds: string[]) => ({
      documentId: id,
      fileName: `${id}.pdf`,
      amount: 10,
      date: null,
      vendor: null,
      transactionIds,
    })
    expect(
      unmatchedReceipts({ receipts: [r('a', ['1']), r('b', [])] }).map((x) => x.documentId)
    ).toEqual(['b'])
  })
})
