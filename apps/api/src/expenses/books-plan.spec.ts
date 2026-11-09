import type { ProgramNames } from '@ad/types'
import { booksTransactions } from './books'
import { allocationNote, planBooks, type PlanEngagement, type PlanMapping } from './books-plan'
import { BOOKS } from './books.testing'

/** A fictional workspace: two programs, one of them an engagement of the app, and its account mapping. */
const programs: ProgramNames[] = [
  { names: ['Youth Coding Program', 'YCP'], engagementId: 'e-ycp' },
  { names: ['Adult Bootcamp'], engagementId: null },
  { names: ['G&A'], engagementId: null },
]
const youth: PlanEngagement = {
  id: 'e-ycp',
  name: 'Youth Coding Pathway',
  periodStart: '2026-07-01',
  periodEnd: '2027-06-30',
  budgetLines: [
    { id: 'b-ind', name: 'Indirect Costs', amount: 4500 },
    { id: 'b-fr', name: 'Fringe', amount: 5000 },
  ],
  months: [{ period: '2026-09', status: 'draft' }],
}
const mapping: PlanMapping = {
  id: 'm-1',
  engagementId: 'e-ycp',
  read: {
    title: 'YCP',
    accounts: {
      '60901': 'INDIRECT COSTS',
      '60301': 'INDIRECT COSTS',
      '63301': 'FRINGE BENEFITS',
      '60202': null,
    },
    names: {},
    categories: [{ category: 'FRINGE BENEFITS', line: 'Fringe', amount: 5000 }],
    budget: null,
    start: null,
    end: null,
  },
  chosen: {},
}
const plan = (over: Partial<Parameters<typeof planBooks>[0]> = {}) =>
  planBooks({
    period: '2026-09',
    transactions: booksTransactions(BOOKS),
    programs,
    engagements: [youth],
    mappings: [mapping],
    existing: [],
    ...over,
  })

describe("where each books line goes (owner's decision, 2026-11-09)", () => {
  it('puts a line on the engagement its class is, on the budget line its account maps to', () => {
    const on = plan().filter((l) => l.status === 'billed')
    expect(on.map((l) => [l.transactionId, l.vendor, l.budgetLineName, l.amount])).toEqual([
      ['9002', 'Maple Properties', 'Indirect Costs', 600],
      ['9003', 'Pixel Tools', 'Indirect Costs', 80],
      ['9005', 'PayPeople', 'Fringe', 50],
    ])
  })

  it('says why every other line is on no engagement', () => {
    const why = Object.fromEntries(
      plan().map((l) => [`${l.transactionId}:${l.className}`, l.status])
    )
    expect(why).toEqual({
      '9002:Youth Coding Program': 'billed',
      '9002:Adult Bootcamp': 'not-ours',
      '9003:Youth Coding Program': 'billed',
      '9004:Allocation Required': 'allocation-pool',
      '9005:Allocation Required': 'allocation-pool',
      '9005:Youth Coding Program': 'billed',
      '9005:Adult Bootcamp': 'not-ours',
      '9007:G&A': 'not-ours',
    })
  })

  it("gives a shared cost's share: of a pool an allocation entry shares out, or of a transaction split by class", () => {
    const [rent, , fees] = plan().filter((l) => l.status === 'billed')
    expect(fees!.allocation).toEqual({
      total: 200,
      percent: 25,
      how: 'entry',
      entryId: '9005',
      sourceIds: ['9004'],
    })
    expect(allocationNote(fees!)).toBe(
      "25.00% of $200.00, shared out by the books' allocation entry 9005"
    )
    expect(rent!.allocation).toMatchObject({
      total: 1000,
      percent: 60,
      how: 'split',
      sourceIds: ['9002'],
    })
    expect(allocationNote(rent!)).toBe(
      '60.00% of $1,000.00, as the books split transaction 9002 by class'
    )
  })

  it('needs the engagement’s mapping, an account it bills and a budget line for the category', () => {
    expect(
      plan({ mappings: [] })
        .filter((l) => l.engagementId === 'e-ycp')
        .map((l) => l.status)
    ).toEqual(['no-mapping', 'no-mapping', 'no-mapping'])
    const noFringe = plan({
      engagements: [{ ...youth, budgetLines: youth.budgetLines.slice(0, 1) }],
    })
    expect(noFringe.find((l) => l.transactionId === '9005' && l.amount === 50)?.status).toBe(
      'no-budget-line'
    )
    const skipped = plan({ mappings: [{ ...mapping, chosen: { 'INDIRECT COSTS': 'skip' } }] })
    expect(skipped.filter((l) => l.status === 'billed').map((l) => l.transactionId)).toEqual([
      '9005',
    ])
    const chosen = plan({ mappings: [{ ...mapping, chosen: { 'FRINGE BENEFITS': 'b-ind' } }] })
    expect(chosen.find((l) => l.transactionId === '9005' && l.amount === 50)?.budgetLineName).toBe(
      'Indirect Costs'
    )
  })

  it('leaves a month that is not a draft as it is, and a date outside the contract', () => {
    const closed = plan({
      engagements: [{ ...youth, months: [{ period: '2026-09', status: 'closed' }] }],
    })
    expect(
      closed.filter((l) => l.engagementId === 'e-ycp').every((l) => l.status === 'month-closed')
    ).toBe(true)
    const later = plan({ engagements: [{ ...youth, periodStart: '2026-10-01' }] })
    expect(
      later.filter((l) => l.engagementId === 'e-ycp').every((l) => l.status === 'outside-contract')
    ).toBe(true)
  })

  it('knows a line saved before (unchanged or changed) and one entered on the month by hand', () => {
    const first = plan().filter((l) => l.status === 'billed')
    const saved = (l: (typeof first)[number], amount = l.amount) => ({
      id: `x-${l.key}`,
      engagementId: 'e-ycp',
      booksKey: l.key,
      date: l.date,
      allocatedAmount: amount,
      totalCost: l.allocation?.total ?? l.amount,
      budgetLineId: l.budgetLineId,
      allocationNote: allocationNote(l),
    })
    const again = plan({ existing: [saved(first[0]!), saved(first[1]!, 79)] })
    expect(again.filter((l) => l.status === 'billed').map((l) => l.saved)).toEqual([
      'same',
      'changed',
      null,
    ])
    const typed = plan({
      existing: [
        {
          id: 'typed',
          engagementId: 'e-ycp',
          booksKey: null,
          date: '2026-09-05',
          allocatedAmount: 80,
          totalCost: 80,
          budgetLineId: 'b-ind',
          allocationNote: null,
        },
      ],
    })
    expect(typed.find((l) => l.transactionId === '9003')?.status).toBe('already-entered')
  })

  it('keys each line by the month, transaction, account, class and place, so the same file gives the same keys', () => {
    expect(plan().map((l) => l.key)).toEqual(plan().map((l) => l.key))
    expect(plan()[0]!.key).toBe('2026-09:9002:60901:youth coding program:1')
  })
})
