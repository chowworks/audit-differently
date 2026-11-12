import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ProgramNames } from '@ad/types'
import { AIT_CLASS, ISY_CLASS, RECEIPTS, expenseSampleFiles } from '../../prisma/expense-sample'
import { PROGRAM_NAMES } from '../../prisma/payroll-workspace-sample'
import { dbTestsEnabled } from '../core/testing/tenant-db'
import { isCardStatement } from '../payroll/card-statement'
import { payLinesOf } from '../payroll/pay-lines'
import { chargesOf, sheetLines } from '../payroll/payroll-details'
import { proofFile } from '../payroll/payroll-match.service'
import { readStatement } from '../payroll/statement-lines'
import { readReceipt } from '../receipts/read-receipt'
import { engagementOfMapping, readAccountMapping, type AccountMappingRead } from './account-mapping'
import { booksTransactions } from './books'
import { planBooks, type PlanEngagement } from './books-plan'

// The expenses half of the workspace payroll sample (prisma/expense-sample.ts, in
// apps/web/public/samples/payroll-workspace-sample.zip) read by the app's own readers. pdf.js needs Node's VM modules,
// as the database specs do (`npm test` sets the flag).
const suite = dbTestsEnabled ? describe : describe.skip
const DIR = join(__dirname, '../../../../docs/samples/payroll-2026-09-workspace')

/** The demo seed's two engagements, as the plan reads them. */
const lines = (p: string, l: [string, number][]) =>
  l.map(([name, amount], i) => ({ id: `${p}-${i}`, name, amount }))
const ENGAGEMENTS: (PlanEngagement & {
  number: string
  code: null
  budgets: number[]
})[] = [
  {
    id: 'e-isy',
    name: 'In-School Youth Coding Pathway',
    number: 'DEMO-26IS-RYS',
    code: null,
    periodStart: '2026-07-01',
    periodEnd: '2027-06-30',
    budgetLines: lines('isy', [
      ['Staff Salaries', 18000],
      ['Program Costs', 92000],
      ['Work Experience', 15000],
      ['Indirect Costs', 0],
    ]),
    months: [{ period: '2026-09', status: 'draft' }],
    budgets: [18000, 92000, 15000, 0],
  },
  {
    id: 'e-ait',
    name: 'Adult IT Training',
    number: 'DEMO-26AT-RYS',
    code: null,
    periodStart: '2026-07-01',
    periodEnd: '2027-06-30',
    budgetLines: lines('ait', [
      ['Staff Salaries', 3500],
      ['Program Costs', 24000],
      ['Indirect Costs', 0],
    ]),
    months: [{ period: '2026-09', status: 'draft' }],
    budgets: [3500, 24000, 0],
  },
]
/** The sample's Program names, as the tour ties them to the engagements. */
const PROGRAMS: ProgramNames[] = PROGRAM_NAMES.map(([books, payroll]) => ({
  names: [books, payroll],
  engagementId: books === ISY_CLASS ? 'e-isy' : books === AIT_CLASS ? 'e-ait' : null,
}))

suite("the workspace payroll sample's expenses", () => {
  let files: Awaited<ReturnType<typeof expenseSampleFiles>>
  beforeAll(async () => {
    files = await expenseSampleFiles()
    // The committed files are what the generator makes now (run `npm run sample:payroll -w @ad/api` after a change).
    for (const f of files)
      expect(readFileSync(join(DIR, f.folder, f.name)).equals(f.bytes)).toBe(true)
  })
  const file = (folder: string) => files.filter((f) => f.folder === folder)

  it("gives payroll nothing to read: the card's statement is a card's, and the books' transactions name no one's pay", async () => {
    const [card] = file('Bank & card statements')
    const read = await readStatement(card!.bytes)
    expect(read.scanned).toBe(false)
    expect(isCardStatement(read.lines)).toBe(true)
    const proof = proofFile({
      id: 'card',
      kind: 'bank-statement',
      fileName: card!.name,
      lines: read.lines,
      items: read.items,
    })
    expect(proof.kind).toBe('card-statement')
    expect(payLinesOf(proof)).toEqual([])
    const [books] = file('QuickBooks transactions')
    expect(chargesOf(await sheetLines(books!.bytes))).toEqual([])
  })

  it("names each mapping's engagement by its contract's total and period", async () => {
    const read = await Promise.all(
      file('Account mapping').map((m) => readAccountMapping(m.bytes, m.name))
    )
    expect(read.map((m) => engagementOfMapping(m, ENGAGEMENTS)?.id)).toEqual(['e-isy', 'e-ait'])
  })

  it('shows each way a line of the books is read', async () => {
    const [books] = file('QuickBooks transactions')
    const maps: AccountMappingRead[] = await Promise.all(
      file('Account mapping').map((m) => readAccountMapping(m.bytes, m.name))
    )
    const plan = planBooks({
      period: '2026-09',
      transactions: booksTransactions(await sheetLines(books!.bytes)),
      programs: PROGRAMS,
      engagements: ENGAGEMENTS,
      mappings: maps.map((read, i) => ({
        id: `m-${i}`,
        engagementId: engagementOfMapping(read, ENGAGEMENTS)?.id ?? null,
        read,
        chosen: {},
      })),
      existing: [],
    })
    expect(
      plan.map((l) => [
        l.transactionId,
        l.status,
        l.engagementId,
        l.budgetLineName,
        l.amount,
        l.paidFrom?.kind ?? null,
        l.allocation
          ? `${l.allocation.percent}% of ${l.allocation.total} (${l.allocation.how})`
          : null,
      ])
    ).toEqual([
      // Rent, split by class in the books.
      ['7101', 'billed', 'e-isy', 'Program Costs', 1440, 'card', '60% of 2400 (split)'],
      ['7101', 'billed', 'e-ait', 'Program Costs', 960, 'card', '40% of 2400 (split)'],
      ['7102', 'billed', 'e-isy', 'Program Costs', 80, 'card', null],
      // The payroll company's fee, held for allocation and shared out by the month-end entry.
      ['7103', 'allocation-pool', null, null, 210, 'card', null],
      // Paid from the bank: the statement's Hilltop Office Supply line.
      ['7104', 'billed', 'e-isy', 'Program Costs', 412.6, 'bank', null],
      ['7105', 'billed', 'e-ait', 'Program Costs', 450, 'card', null],
      ['7106', 'not-ours', null, null, 300, 'card', null],
      ['7107', 'not-billable', 'e-isy', null, 65, 'card', null],
      ['7108', 'allocation-pool', null, null, -210, null, null],
      ['7108', 'billed', 'e-isy', 'Program Costs', 140, null, '66.67% of 210 (entry)'],
      ['7108', 'billed', 'e-ait', 'Program Costs', 70, null, '33.33% of 210 (entry)'],
      ['7109', 'no-class', null, null, 120, 'other', null],
    ])
  })

  it("matches each receipt to its bill by its amount and date, the shared fee's too, and shows the rent's missing", async () => {
    const read = await Promise.all(
      file('Receipts').map(async (r, i) => ({
        id: `r-${i}`,
        fileName: r.name,
        ...(await readReceipt(
          { buffer: r.bytes, contentType: 'application/pdf', sensitivity: 'financial' },
          false
        )),
      }))
    )
    expect(read.map((r) => [r.fileName, r.amount, r.date, r.vendor, r.readBy])).toEqual([
      ['Pixel Tools invoice 4471.pdf', 80, '2026-09-03', 'Pixel Tools', 'text'],
      ['PayPeople invoice 0926.pdf', 210, '2026-09-06', 'PayPeople Payroll', 'text'],
      [
        'Hilltop Office Supply receipt.pdf',
        412.6,
        RECEIPTS[2]!.date,
        'Hilltop Office Supply',
        'text',
      ],
      ['CertPath invoice 3302.pdf', 450, '2026-09-09', 'CertPath Testing', 'text'],
    ])
    const [books] = file('QuickBooks transactions')
    const maps = await Promise.all(
      file('Account mapping').map((m) => readAccountMapping(m.bytes, m.name))
    )
    const plan = planBooks({
      period: '2026-09',
      transactions: booksTransactions(await sheetLines(books!.bytes)),
      programs: PROGRAMS,
      engagements: ENGAGEMENTS,
      mappings: maps.map((r, i) => ({
        id: `m-${i}`,
        engagementId: engagementOfMapping(r, ENGAGEMENTS)?.id ?? null,
        read: r,
        chosen: {},
      })),
      existing: [],
      receipts: read,
    })
    expect(
      plan
        .filter((l) => l.status === 'billed')
        .map((l) => [
          l.transactionId,
          l.engagementId,
          l.bills.map((b) => `${b.transactionId}: ${b.receipt?.fileName ?? 'no receipt'}`),
        ])
    ).toEqual([
      ['7101', 'e-isy', ['7101: no receipt']],
      ['7101', 'e-ait', ['7101: no receipt']],
      ['7102', 'e-isy', ['7102: Pixel Tools invoice 4471.pdf']],
      ['7104', 'e-isy', ['7104: Hilltop Office Supply receipt.pdf']],
      ['7105', 'e-ait', ['7105: CertPath invoice 3302.pdf']],
      // Each program's share of the fee: the one bill the entry shares out, and its invoice.
      ['7108', 'e-isy', ['7103: PayPeople invoice 0926.pdf']],
      ['7108', 'e-ait', ['7103: PayPeople invoice 0926.pdf']],
    ])
  })

  it("finds each bill's payment on the month's statements, the card's on the card's and the bank's on the bank's", async () => {
    // The zip's statements folder as the month keeps it: the bank's statement (of the payroll sample) and the card's.
    const folder = join(DIR, 'Bank & card statements')
    const statements = await Promise.all(
      readdirSync(folder)
        .sort()
        .map(async (name, i) => {
          const { lines } = await readStatement(readFileSync(join(folder, name)))
          return { id: `s-${i}`, fileName: name, card: isCardStatement(lines), lines }
        })
    )
    expect(statements.map((s) => [s.fileName, s.card])).toEqual([
      ['Lakeside Business Card statement 2026-09.pdf', true],
      ['Lakeside Community Bank statement 2026-09.pdf', false],
    ])
    const [books] = file('QuickBooks transactions')
    const maps = await Promise.all(
      file('Account mapping').map((m) => readAccountMapping(m.bytes, m.name))
    )
    const plan = planBooks({
      period: '2026-09',
      transactions: booksTransactions(await sheetLines(books!.bytes)),
      programs: PROGRAMS,
      engagements: ENGAGEMENTS,
      mappings: maps.map((r, i) => ({
        id: `m-${i}`,
        engagementId: engagementOfMapping(r, ENGAGEMENTS)?.id ?? null,
        read: r,
        chosen: {},
      })),
      existing: [],
      statements,
    })
    const bills = new Map(
      plan
        .filter((l) => l.status === 'billed')
        .flatMap((l) => l.bills)
        .map((b) => [b.transactionId, b])
    )
    expect(
      [...bills.values()].map((b) => [
        b.transactionId,
        b.paidFrom,
        b.payment?.fileName ?? null,
        b.payment?.by ?? null,
      ])
    ).toEqual([
      ['7101', 'card', 'Lakeside Business Card statement 2026-09.pdf', 'auto'],
      ['7102', 'card', 'Lakeside Business Card statement 2026-09.pdf', 'auto'],
      ['7104', 'bank', 'Lakeside Community Bank statement 2026-09.pdf', 'auto'],
      ['7105', 'card', 'Lakeside Business Card statement 2026-09.pdf', 'auto'],
      ['7103', 'card', 'Lakeside Business Card statement 2026-09.pdf', 'auto'],
    ])
    // Each found on the line that prints its amount.
    for (const b of bills.values())
      expect(b.payment!.line.text).toContain(
        b.amount.toLocaleString('en-US', { minimumFractionDigits: 2 })
      )
  })
})
