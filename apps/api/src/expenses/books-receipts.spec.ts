import type { ProgramNames } from '@ad/types'
import { booksTransactions } from './books'
import { allocationNote, planBooks, type PlanEngagement, type PlanMapping } from './books-plan'
import { receiptsOfBills, type PlanBill, type PlanReceipt } from './books-receipts'
import { BOOKS, rows } from './books.testing'

/** A fictional workspace, as books-plan.spec.ts has it. */
const programs: ProgramNames[] = [
  { names: ['Youth Coding Program'], engagementId: 'e-ycp' },
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
    accounts: { '60901': 'INDIRECT COSTS', '60301': 'INDIRECT COSTS', '63301': 'FRINGE BENEFITS' },
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
  }).filter((l) => l.engagementId === 'e-ycp')

const receipt = (
  id: string,
  amount: number | null,
  date: string | null,
  vendor = ''
): PlanReceipt => ({
  id,
  fileName: `${id}.pdf`,
  amount,
  date,
  vendor,
})
const bill = (transactionId: string, amount: number, date: string): PlanBill => ({
  transactionId,
  amount,
  date,
  vendor: 'PayPeople',
})

describe("the receipts of the books' bills (owner's decision, 2026-11-12)", () => {
  it('matches a receipt and a bill when each is the only one that fits the other', () => {
    const found = receiptsOfBills(
      [bill('b1', 200, '2026-09-08'), bill('b2', 75.5, '2026-09-20')],
      [
        receipt('r1', 200, '2026-09-03'), // invoiced 5 days before it was paid
        receipt('r2', 75.51, '2026-09-20'), // a cent off
        receipt('r3', 999, '2026-09-08'),
      ],
      []
    )
    expect(Object.fromEntries(found)).toEqual({
      b1: { documentId: 'r1', by: 'auto' },
      b2: { documentId: 'r2', by: 'auto' },
    })
  })

  it('leaves a bill two receipts fit, or a receipt two bills fit, to an owner', () => {
    const twoReceipts = receiptsOfBills(
      [bill('b1', 200, '2026-09-08')],
      [receipt('r1', 200, '2026-09-07'), receipt('r2', 200, '2026-09-09')],
      []
    )
    expect(twoReceipts.size).toBe(0)
    const twoBills = receiptsOfBills(
      [bill('b1', 200, '2026-09-08'), bill('b2', 200, '2026-09-10')],
      [receipt('r1', 200, '2026-09-09')],
      []
    )
    expect(twoBills.size).toBe(0)
    // Too far apart, or no amount read: no match at all.
    expect(
      receiptsOfBills([bill('b1', 200, '2026-09-08')], [receipt('r1', 200, '2026-08-20')], []).size
    ).toBe(0)
    expect(
      receiptsOfBills([bill('b1', 200, '2026-09-08')], [receipt('r1', null, '2026-09-08')], []).size
    ).toBe(0)
  })

  it("takes an owner's choice first, and the rest then match among themselves", () => {
    const found = receiptsOfBills(
      [bill('b1', 200, '2026-09-08'), bill('b2', 200, '2026-09-10')],
      [receipt('r1', 200, '2026-09-09'), receipt('r2', 200, '2026-09-11')],
      [{ transactionId: 'b2', documentId: 'r1', dropped: false }]
    )
    expect(Object.fromEntries(found)).toEqual({
      b2: { documentId: 'r1', by: 'person' },
      b1: { documentId: 'r2', by: 'auto' },
    })
    // A dropped bill takes no receipt.
    const dropped = receiptsOfBills(
      [bill('b1', 200, '2026-09-08')],
      [receipt('r1', 200, '2026-09-08')],
      [{ transactionId: 'b1', documentId: null, dropped: true }]
    )
    expect(dropped.size).toBe(0)
  })

  it("names each line's bills: its own transaction, or each bill of the pool an entry shares out", () => {
    const lines = plan({ receipts: [receipt('rent', 1000, '2026-09-01', 'Maple Properties')] })
    expect(
      lines.map((l) => [
        l.transactionId,
        l.bills.map((b) => [b.transactionId, b.amount, b.receipt?.documentId ?? null]),
      ])
    ).toEqual([
      // Rent split by class: the whole $1,000 bill.
      ['9002', [['9002', 1000, 'rent']]],
      ['9003', [['9003', 80, null]]],
      // The payroll company's fee, shared out by entry 9005: its bill is 9004.
      ['9005', [['9004', 200, null]]],
    ])
  })

  it("takes a dropped bill's share off the line, and a line of only dropped bills bills nothing", () => {
    // Two bills in the pool, $200 and $100; the program's share is a quarter of the $300.
    const books = rows(
      ' | Transaction date | Transaction type | Num | Posting (Y/N) | Name | Class full name | Description | Account Name | Amount | Transaction ID',
      ' | 09/08/2026 | Expense |  | Yes | PayPeople |  |  | 10000 Lakeside Checking 1234 | -200 | 8001',
      ' | 09/08/2026 | Expense |  | Yes | PayPeople | Allocation Required |  | 63301 Payroll Fees | 200 | 8001',
      ' | 09/22/2026 | Expense |  | Yes | PayPeople |  |  | 10000 Lakeside Checking 1234 | -100 | 8002',
      ' | 09/22/2026 | Expense |  | Yes | PayPeople | Allocation Required |  | 63301 Payroll Fees | 100 | 8002',
      ' | 09/30/2026 | Journal Entry | JE-9 | Yes |  | Allocation Required |  | 63301 Payroll Fees | -300 | 8003',
      ' | 09/30/2026 | Journal Entry | JE-9 | Yes |  | Youth Coding Program |  | 63301 Payroll Fees | 75 | 8003',
      ' | 09/30/2026 | Journal Entry | JE-9 | Yes |  | Adult Bootcamp |  | 63301 Payroll Fees | 225 | 8003'
    )
    const pooled = (dropped: string[]) =>
      plan({
        transactions: booksTransactions(books),
        choices: dropped.map((transactionId) => ({
          transactionId,
          documentId: null,
          dropped: true,
        })),
      })[0]!
    expect(pooled([]).amount).toBe(75)
    const less = pooled(['8002'])
    expect([less.status, less.amount]).toEqual(['billed', 50])
    expect(less.bills.map((b) => [b.transactionId, b.dropped])).toEqual([
      ['8001', false],
      ['8002', true],
    ])
    expect(allocationNote(less)).toBe(
      "25.00% of $300.00, shared out by the books' allocation entry 8003, less its share of bill 8002 ($100.00), dropped for want of a receipt"
    )
    const none = pooled(['8001', '8002'])
    expect([none.status, none.amount]).toEqual(['dropped', 0])
    // A line that is its own bill goes when it is dropped.
    const own = plan({ choices: [{ transactionId: '9003', documentId: null, dropped: true }] })
    expect(own.find((l) => l.transactionId === '9003')?.status).toBe('dropped')
  })
})
