import type { ProgramNames } from '@ad/types'
import { booksTransactions } from './books'
import {
  allocationNote,
  planBooks,
  savedBills,
  type PlanEngagement,
  type PlanMapping,
} from './books-plan'
import { BOOKS, rows } from './books.testing'

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
      "$50.00 of $200.00, as the books' allocation entry 9005 shares it out"
    )
    expect(rent!.allocation).toMatchObject({
      total: 1000,
      percent: 60,
      how: 'split',
      sourceIds: ['9002'],
    })
    expect(allocationNote(rent!)).toBe(
      '$600.00 of $1,000.00, as the books split transaction 9002 by class'
    )
  })

  it("keeps how the books charge a shared cost to every program, in the books' dollars", () => {
    const [rent, pixel, fees] = plan().filter((l) => l.status === 'billed')
    expect(fees!.split).toEqual({
      how: 'entry',
      transactionId: '9005',
      date: '2026-09-30',
      account: '63301 Payroll Fees',
      total: 200,
      rows: [
        { className: 'Youth Coding Program', amount: 50, mine: true },
        { className: 'Adult Bootcamp', amount: 150, mine: false },
      ],
      less: [],
      billed: 50,
      // The entry's rows on the export, the pool's too.
      at: [
        { page: 1, row: 14 },
        { page: 1, row: 15 },
        { page: 1, row: 16 },
      ],
    })
    expect(rent!.split).toMatchObject({
      how: 'split',
      transactionId: '9002',
      total: 1000,
      rows: [
        { className: 'Youth Coding Program', amount: 600, mine: true },
        { className: 'Adult Bootcamp', amount: 400, mine: false },
      ],
    })
    // A cost all one program's has none.
    expect(pixel!.split).toBeNull()
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
      booksBills: savedBills(l),
      booksSplit: l.split,
    })
    const again = plan({ existing: [saved(first[0]!), saved(first[1]!, 79)] })
    expect(again.filter((l) => l.status === 'billed').map((l) => l.saved)).toEqual([
      'same',
      'changed',
      null,
    ])
    // Read back from the database, whose JSON keeps its keys in an order of its own: the same.
    const reordered = (l: (typeof first)[number]) =>
      savedBills(l).map(
        ({ dropped, payment, documentId, amount, vendor, date, transactionId }) => ({
          dropped,
          payment,
          documentId,
          amount,
          vendor,
          date,
          transactionId,
        })
      )
    expect(
      plan({ existing: [{ ...saved(first[0]!), booksBills: reordered(first[0]!) }] }).find(
        (l) => l.key === first[0]!.key
      )?.saved
    ).toBe('same')
    // Saved before its split was kept: saved again once, to keep it.
    const unsplit = plan({ existing: [{ ...saved(first[0]!), booksSplit: null }] })
    expect(unsplit.find((l) => l.key === first[0]!.key)?.saved).toBe('changed')
    // Saved before its bills were kept: saved again once, to keep them.
    const older = plan({ existing: [{ ...saved(first[0]!), booksBills: null }] })
    expect(older.find((l) => l.key === first[0]!.key)?.saved).toBe('changed')
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

  it('keeps a line saved by another month’s upload where it is, from an export that overlaps this one', () => {
    // September's upload saved the 09/05 software (its key starts with the month uploaded); an export of August that
    // runs on into September holds it too.
    const saved = {
      id: 'x-9003',
      engagementId: 'e-ycp',
      booksKey: '2026-09:9003:60301:youth coding program:1',
      date: '2026-09-05',
      allocatedAmount: 80,
      totalCost: 80,
      budgetLineId: 'b-ind',
      allocationNote: null,
    }
    const august = plan({ period: '2026-08', existing: [saved] })
    expect(august.find((l) => l.transactionId === '9003')?.status).toBe('already-entered')
    expect(august.filter((l) => l.status === 'billed').map((l) => l.transactionId)).toEqual([
      '9002',
      '9005',
    ])
    // Its own month's upload knows it as its own.
    const september = plan({ existing: [saved] }).find((l) => l.transactionId === '9003')!
    expect([september.status, september.saved]).toEqual(['billed', 'changed'])
  })
})

/** A month's books of the rows given, under the export's header. */
const books = (...texts: string[]) =>
  booksTransactions(
    rows(
      ' | Transaction date | Transaction type | Num | Posting (Y/N) | Name | Class full name | Description | Account Name | Amount | Transaction ID',
      ...texts
    )
  )

describe('a reclass, and several allocation entries on one pool (owner’s decision, 2026-11-12)', () => {
  it('reads a journal entry moving a cost between programs as ordinary lines, never an allocation', () => {
    const lines = plan({
      transactions: books(
        ' | 09/05/2026 | Expense |  | Yes | Pixel Tools |  |  | 22000 Card:22001 Morgan Lee - Card | -120 | 9101',
        ' | 09/05/2026 | Expense |  | Yes | Pixel Tools | Adult Bootcamp |  | 60301 Software and Subscription | 120 | 9101',
        ' | 09/30/2026 | Journal Entry | JE-3 | Yes |  | Adult Bootcamp |  | 60301 Software and Subscription | -80 | 9102',
        ' | 09/30/2026 | Journal Entry | JE-3 | Yes |  | Youth Coding Program |  | 60301 Software and Subscription | 80 | 9102'
      ),
    })
    expect(lines.map((l) => [l.transactionId, l.className, l.status])).toEqual([
      ['9101', 'Adult Bootcamp', 'not-ours'],
      ['9102', 'Adult Bootcamp', 'credit'],
      ['9102', 'Youth Coding Program', 'billed'],
    ])
    const moved = lines[2]!
    expect(moved.allocation).toBeNull()
    expect(moved.bills.map((b) => b.transactionId)).toEqual(['9102'])
  })

  const pool = (second: number) =>
    books(
      ' | 09/04/2026 | Expense |  | Yes | PayPeople |  |  | 10000 Lakeside Checking 1234 | -200 | 9201',
      ' | 09/04/2026 | Expense |  | Yes | PayPeople | Allocation Required |  | 63301 Payroll Fees | 200 | 9201',
      ' | 09/18/2026 | Expense |  | Yes | PayPeople |  |  | 10000 Lakeside Checking 1234 | -300 | 9202',
      ' | 09/18/2026 | Expense |  | Yes | PayPeople | Allocation Required |  | 63301 Payroll Fees | 300 | 9202',
      ' | 09/30/2026 | Journal Entry | JE-A | Yes |  | Allocation Required |  | 63301 Payroll Fees | -200 | 9203',
      ' | 09/30/2026 | Journal Entry | JE-A | Yes |  | Youth Coding Program |  | 63301 Payroll Fees | 50 | 9203',
      ' | 09/30/2026 | Journal Entry | JE-A | Yes |  | Adult Bootcamp |  | 63301 Payroll Fees | 150 | 9203',
      ` | 09/30/2026 | Journal Entry | JE-B | Yes |  | Allocation Required |  | 63301 Payroll Fees | -${second} | 9204`,
      ' | 09/30/2026 | Journal Entry | JE-B | Yes |  | Youth Coding Program |  | 63301 Payroll Fees | 100 | 9204',
      ` | 09/30/2026 | Journal Entry | JE-B | Yes |  | Adult Bootcamp |  | 63301 Payroll Fees | ${second - 100} | 9204`
    )
  const billed = (transactions: ReturnType<typeof books>, dropped: string[] = []) =>
    plan({
      transactions,
      choices: dropped.map((transactionId) => ({ transactionId, documentId: null, dropped: true })),
    }).filter((l) => l.engagementId === 'e-ycp')

  it('gives each entry on one pool the bills that come to its total', () => {
    const [a, b] = billed(pool(300))
    expect([a!.allocation?.sourceIds, b!.allocation?.sourceIds]).toEqual([['9201'], ['9202']])
    expect(a!.bills.map((x) => x.amount)).toEqual([200])
    // Dropping the $300 bill takes JE-B's line, never JE-A's.
    const [a2, b2] = billed(pool(300), ['9202'])
    expect([a2!.status, a2!.amount]).toEqual(['billed', 50])
    expect([b2!.status, b2!.amount]).toEqual(['dropped', 0])
  })

  it('keeps every bill on each entry when no split comes to their totals, taking a dropped bill’s share of them', () => {
    // JE-B shares $250: no bills of the pool come to it.
    const [a, b] = billed(pool(250))
    expect([a!.allocation?.sourceIds, b!.allocation?.sourceIds]).toEqual([
      ['9201', '9202'],
      ['9201', '9202'],
    ])
    // The $300 bill is three fifths of the $500 the bills come to: never more than the line.
    const [a2, b2] = billed(pool(250), ['9202'])
    expect([a2!.status, a2!.amount]).toEqual(['billed', 20])
    expect([b2!.status, b2!.amount]).toEqual(['billed', 40])
    expect(a2!.split?.less).toEqual([{ transactionId: '9202', amount: 300, off: 30 }])
  })
})

describe('matching among every bill of the month (owner’s decision, 2026-11-12)', () => {
  // Our software, and another program’s of the same amount the next day, both on the card.
  const month = books(
    ' | 09/05/2026 | Expense |  | Yes | Pixel Tools |  |  | 22000 Card:22001 Morgan Lee - Card | -80 | 9401',
    ' | 09/05/2026 | Expense |  | Yes | Pixel Tools | Youth Coding Program |  | 60301 Software and Subscription | 80 | 9401',
    ' | 09/06/2026 | Expense |  | Yes | Pixel Tools |  |  | 22000 Card:22001 Morgan Lee - Card | -80 | 9402',
    ' | 09/06/2026 | Expense |  | Yes | Pixel Tools | Adult Bootcamp |  | 60301 Software and Subscription | 80 | 9402'
  )
  const ours = (over: Partial<Parameters<typeof planBooks>[0]> = {}) =>
    plan({ transactions: month, ...over }).find((l) => l.transactionId === '9401')!
  const receipt = { id: 'r1', fileName: 'r1.pdf', amount: 80, date: '2026-09-05', vendor: '' }
  const statement = {
    id: 'card',
    fileName: 'card.pdf',
    card: true,
    lines: [{ page: 1, x: 0, y: 1, width: 1, height: 1, text: '09/05/2026 PIXEL TOOLS 80.00' }],
  }

  it('counts another program’s bill of the same amount a rival, for a receipt and a statement line', () => {
    const line = ours({ receipts: [receipt], statements: [statement] })
    expect(line.status).toBe('billed')
    expect(line.bills[0]!.receipt).toBeNull()
    expect(line.bills[0]!.payment).toBeNull()
    expect(line.bills[0]!.paymentChoices.map((p) => p?.line.text)).toEqual([
      '09/05/2026 PIXEL TOOLS 80.00',
    ])
  })

  it('still takes an owner’s choice', () => {
    const line = ours({
      receipts: [receipt],
      choices: [{ transactionId: '9401', documentId: 'r1', dropped: false }],
    })
    expect(line.bills[0]!.receipt).toEqual({ documentId: 'r1', fileName: 'r1.pdf', by: 'person' })
  })
})
