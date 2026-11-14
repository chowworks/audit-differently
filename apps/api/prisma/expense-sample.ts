import { zipFolder } from '@ad/types'
import * as ExcelJS from 'exceljs'
import { unzipSync, zipSync } from 'fflate'
import { layoutPdf } from './pdf'
import { COMPANY, SAMPLE_FOOTER, VENDOR, money, us } from './payroll-workspace-sample'

/**
 * The expenses half of the workspace payroll sample (owner's decision, 2026-11-09): Riverbend Youth Services'
 * September books as QuickBooks exports them (a Transaction List with Splits of the month's expenses), the business
 * card's September statement, and each engagement's account mapping. Kept apart from `sampleFiles`, which the payroll
 * sample's specs read whole: these files join the same zip (`scripts/make-payroll-sample.ts`) and never change what
 * payroll reads. Read by the app's own readers in `src/expenses/expense-sample.spec.ts`. Fictional people, companies
 * and amounts only (CLAUDE.md, "Data rules").
 */

/**
 * A workbook's bytes, the same every time: ExcelJS stamps each part of the xlsx (a zip) with the time it is written, so
 * each part is given a fixed time, in local terms as the payroll sample's sheet is (the same bytes in every time zone).
 */
async function steady(book: ExcelJS.Workbook): Promise<Buffer> {
  const parts = unzipSync(new Uint8Array(await book.xlsx.writeBuffer()))
  const at = new Date(2026, 9, 1, 12, 0, 0)
  return Buffer.from(
    zipSync(Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, [v, { mtime: at }]])))
  )
}

/** The books' classes, as the sample's Program names file gives them. */
export const ISY_CLASS = 'Demo Workforce Board (In-School Youth Coding Pathway)'
export const AIT_CLASS = 'Demo Workforce Board (Adult IT Training)'
const SUMMER_CLASS = 'Demo Workforce Board (Summer Youth)'
const POOL = 'Allocation Required'
export const CARD = 'Lakeside Community Bank Business Card (fictional)'
export const CARDHOLDER = 'DANA OKAFOR'
const BANK_ACCOUNT = '10000 Lakeside Checking 0000'
const CARD_ACCOUNT = '22000 Credit Cards:22001 Lakeside Business Card 0000'

const ACCOUNTS = {
  rent: '60000 General & Administrative:60901 Rent Expense',
  software: '60300 Technology:60301 Software and Subscription',
  supplies: '60400 Program Expenses:60401 Program Supplies',
  vouchers: '60400 Program Expenses:60501 Certification Vouchers',
  trips: '60400 Program Expenses:60601 Field Trips',
  meals: '60000 General & Administrative:60801 Meals',
  insurance: '60000 General & Administrative:60202 Insurance',
  fees: '63000 Payroll Expenses:63301 Payroll Fees',
  prepaid: '13100 Prepaid Expenses',
}

/** One transaction: its payment side (bank or card, the whole amount out), then its split lines. */
interface SampleTxn {
  id: string
  date: string
  type: 'Expense' | 'Journal Entry'
  num?: string
  vendor: string
  description: string
  from?: 'bank' | 'card'
  lines: { className: string; account: string; amount: number }[]
}

/** September's expenses, each one showing a way the Expenses step reads a line. */
export const TRANSACTIONS: SampleTxn[] = [
  // Rent on the card, split between the programs by class in the books.
  {
    id: '7101',
    date: '2026-09-02',
    type: 'Expense',
    vendor: 'Maple Street Properties',
    description: 'SEPT RENT SUITE 200',
    from: 'card',
    lines: [
      { className: ISY_CLASS, account: ACCOUNTS.rent, amount: 1440 },
      { className: AIT_CLASS, account: ACCOUNTS.rent, amount: 960 },
    ],
  },
  // Software on the card, all one program's.
  {
    id: '7102',
    date: '2026-09-05',
    type: 'Expense',
    vendor: 'Pixel Tools',
    description: 'PIXEL TOOLS CLASSROOM PLAN',
    from: 'card',
    lines: [{ className: ISY_CLASS, account: ACCOUNTS.software, amount: 80 }],
  },
  // The payroll company's fee: held for allocation, then shared out at month end by an allocation entry.
  {
    id: '7103',
    date: '2026-09-08',
    type: 'Expense',
    vendor: 'PayPeople Payroll',
    description: 'PAYPEOPLE MONTHLY FEE',
    from: 'card',
    lines: [{ className: POOL, account: ACCOUNTS.fees, amount: 210 }],
  },
  // The office supplier the bank statement pays.
  {
    id: '7104',
    date: VENDOR.date,
    type: 'Expense',
    vendor: 'Hilltop Office Supply',
    description: 'CLASSROOM SUPPLIES',
    from: 'bank',
    lines: [{ className: ISY_CLASS, account: ACCOUNTS.supplies, amount: VENDOR.out }],
  },
  // Certification vouchers on the card, Adult IT's.
  {
    id: '7105',
    date: '2026-09-15',
    type: 'Expense',
    vendor: 'CertPath Testing',
    description: 'CERTPATH VOUCHERS X3',
    from: 'card',
    lines: [{ className: AIT_CLASS, account: ACCOUNTS.vouchers, amount: 450 }],
  },
  // A program the app has no engagement for.
  {
    id: '7106',
    date: '2026-09-19',
    type: 'Expense',
    vendor: 'Bright Bus Tours',
    description: 'SUMMER YOUTH FIELD TRIP',
    from: 'card',
    lines: [{ className: SUMMER_CLASS, account: ACCOUNTS.trips, amount: 300 }],
  },
  // A meal the In-School Youth mapping says is not billable.
  {
    id: '7107',
    date: '2026-09-22',
    type: 'Expense',
    vendor: 'Corner Cafe',
    description: 'ADVISORY BOARD LUNCH',
    from: 'card',
    lines: [{ className: ISY_CLASS, account: ACCOUNTS.meals, amount: 65 }],
  },
  {
    id: '7108',
    date: '2026-09-30',
    type: 'Journal Entry',
    num: 'JE-0930-1',
    vendor: '',
    description: 'ALLOCATE PAYROLL FEES BY HOURS',
    lines: [
      { className: POOL, account: ACCOUNTS.fees, amount: -210 },
      { className: ISY_CLASS, account: ACCOUNTS.fees, amount: 140 },
      { className: AIT_CLASS, account: ACCOUNTS.fees, amount: 70 },
    ],
  },
  // Insurance booked out of a prepaid asset: no class, no payment this month.
  {
    id: '7109',
    date: '2026-09-30',
    type: 'Journal Entry',
    num: 'JE-0930-2',
    vendor: '',
    description: 'SEPT INSURANCE FROM PREPAID',
    lines: [{ className: '', account: ACCOUNTS.insurance, amount: 120 }],
  },
]

/** The card's charges: every expense the books paid from it. */
export const cardCharges = () =>
  TRANSACTIONS.filter((t) => t.from === 'card').map((t) => ({
    date: t.date,
    what: t.description,
    amount: t.lines.reduce((s, l) => s + l.amount, 0),
  }))
/** August's balance, paid in full by autopay in September. */
export const CARD_AUTOPAY = 1975.3

/**
 * September's Transaction List with Splits, as QuickBooks exports it: a title, then a header, then each transaction's
 * rows (its payment side first, on the bank or card account, then its split lines), with the transaction's id.
 */
export async function transactionListXlsx(): Promise<Buffer> {
  const book = new ExcelJS.Workbook()
  // Fixed, so the same sample always makes the same file.
  book.created = book.modified = new Date('2026-10-01T12:00:00Z')
  const sheet = book.addWorksheet('Transaction List with Splits')
  sheet.addRow([COMPANY])
  sheet.addRow(['Transaction List with Splits'])
  sheet.addRow(['September 1-30, 2026'])
  sheet.addRow([])
  sheet.addRow([
    '',
    'Transaction date',
    'Transaction type',
    'Num',
    'Posting (Y/N)',
    'Name',
    'Class full name',
    'Description',
    'Account Name',
    'Amount',
    'Transaction ID',
  ])
  for (const t of TRANSACTIONS) {
    const row = (className: string, account: string, amount: number) =>
      sheet.addRow([
        '',
        us(t.date),
        t.type,
        t.num ?? '',
        'Yes',
        t.vendor,
        className,
        t.description,
        account,
        amount,
        t.id,
      ])
    const total = t.lines.reduce((s, l) => s + l.amount, 0)
    if (t.from) row('', t.from === 'bank' ? BANK_ACCOUNT : CARD_ACCOUNT, -total)
    for (const l of t.lines) row(l.className, l.account, l.amount)
    if (t.id === '7109') row('', ACCOUNTS.prepaid, -120)
  }
  sheet.addRow([])
  sheet.addRow([SAMPLE_FOOTER])
  return steady(book)
}

/**
 * The card's September statement, as a card issuer prints it: the closing and due dates, the new balance and minimum
 * payment, the cardholder's autopay of August's balance, then each charge.
 */
export function cardStatementPdf(): Promise<Buffer> {
  const at = [48, 120, 470]
  const charges = cardCharges()
  const spent = charges.reduce((t, c) => t + c.amount, 0)
  return layoutPdf(
    CARD,
    [
      [`Business card statement · ${COMPANY} · ${CARDHOLDER} · card ending 0000`],
      ['Closing Date 09/27/2026', 'Payment Due Date 10/22/2026'],
      ['Previous balance', money(CARD_AUTOPAY)],
      ['New Balance', money(spent), 'Minimum Payment Due', money(40)],
      null,
      { at, cells: ['Date', 'Description', 'Amount'] },
      {
        at,
        cells: [
          '09/10/2026',
          `${CARDHOLDER} AUTOPAY PAYMENT RECEIVED - THANK YOU`,
          `-${money(CARD_AUTOPAY)}`,
        ],
      },
      ...charges.map((c) => ({ at, cells: [us(c.date), c.what, money(c.amount)] })),
    ],
    SAMPLE_FOOTER
  )
}

/** One engagement's account mapping, as a team keeps it: a box naming its contract and budget lines, then its accounts. */
interface SampleMapping {
  name: string
  title: string
  budget: number
  box: [string, number, string][]
  accounts: [string, string, string | null][]
}

const ALL_ACCOUNTS: [string, string][] = [
  ['60202', 'Insurance'],
  ['60301', 'Software and Subscription'],
  ['60401', 'Program Supplies'],
  ['60501', 'Certification Vouchers'],
  ['60601', 'Field Trips'],
  ['60801', 'Meals'],
  ['60901', 'Rent Expense'],
  ['63102', 'Salaries - Employees'],
  ['63301', 'Payroll Fees'],
]

export const MAPPINGS: SampleMapping[] = [
  {
    name: 'Account mapping In-School Youth.xlsx',
    title: 'In-School Youth Coding Pathway',
    budget: 125000,
    box: [
      ['STAFF SALARIES', 18000, 'Staff Salaries'],
      ['PROGRAM COSTS', 92000, 'Program Costs'],
    ],
    accounts: ALL_ACCOUNTS.map(([n, name]) => [
      n,
      name,
      n === '63102'
        ? 'STAFF SALARIES'
        : ['60301', '60401', '60901', '63301'].includes(n)
          ? 'PROGRAM COSTS'
          : null,
    ]),
  },
  {
    name: 'Account mapping Adult IT.xlsx',
    title: 'Adult IT Training',
    budget: 27500,
    box: [
      ['STAFF SALARIES', 3500, 'Staff Salaries'],
      ['PROGRAM COSTS', 24000, 'Program Costs'],
    ],
    accounts: ALL_ACCOUNTS.map(([n, name]) => [
      n,
      name,
      n === '63102'
        ? 'STAFF SALARIES'
        : ['60501', '60901', '63301'].includes(n)
          ? 'PROGRAM COSTS'
          : null,
    ]),
  },
]

export async function accountMappingXlsx(m: SampleMapping): Promise<Buffer> {
  const book = new ExcelJS.Workbook()
  book.created = book.modified = new Date('2026-10-01T12:00:00Z')
  const sheet = book.addWorksheet('Mapping')
  sheet.addRow(['Account', 'Account name', `${m.title} billable category`, '', m.title])
  const side = [
    `BUDGET: ${money(m.budget)}`,
    'Agreement Period 7/01/2026 - 6/30/2027',
    ...m.box.map(([c, amount, line]) => `${c} BUDGET AMOUNT ${money(amount)} -----> ${line}`),
  ]
  m.accounts.forEach(([n, name, category], i) =>
    sheet.addRow([n, name, category ?? '', '', side[i] ?? ''])
  )
  sheet.addRow([])
  sheet.addRow([SAMPLE_FOOTER])
  return steady(book)
}

/**
 * The vendors' receipts and invoices of the month's bills (owner's decision, 2026-11-12), each dated a few days before
 * the books booked it, as invoices are: the software, the payroll company's fee (the bill the allocation entry shares
 * out), the office supplies and the certification. The rent has none, so the expenses step shows a bill to find or drop.
 */
export const RECEIPTS: { transactionId: string; name: string; date: string; number: string }[] = [
  {
    transactionId: '7102',
    name: 'Pixel Tools invoice 4471.pdf',
    date: '2026-09-03',
    number: 'PT-4471',
  },
  {
    transactionId: '7103',
    name: 'PayPeople invoice 0926.pdf',
    date: '2026-09-06',
    number: 'PP-0926',
  },
  {
    transactionId: '7104',
    name: 'Hilltop Office Supply receipt.pdf',
    date: VENDOR.date,
    number: 'HOS-1188',
  },
  {
    transactionId: '7105',
    name: 'CertPath invoice 3302.pdf',
    date: '2026-09-09',
    number: 'CP-3302',
  },
]

/** A vendor's invoice for one of the month's bills: its name, the date, the number, the line and the total. */
export function receiptPdf(r: (typeof RECEIPTS)[number]): Promise<Buffer> {
  const t = TRANSACTIONS.find((x) => x.id === r.transactionId)!
  const total = t.lines.reduce((n, l) => n + l.amount, 0)
  const at = [48, 400]
  return layoutPdf(
    t.vendor,
    [
      [`Invoice ${r.number}`, `Invoice date ${us(r.date)}`],
      [`Bill to ${COMPANY}`],
      null,
      { at, cells: ['Description', 'Amount'] },
      { at, cells: [t.description, money(total)] },
      null,
      { at, cells: ['Total', money(total)] },
    ],
    SAMPLE_FOOTER
  )
}

/** The expense files, in the zip's folders. */
export async function expenseSampleFiles(): Promise<
  { folder: string; name: string; bytes: Buffer }[]
> {
  return [
    {
      folder: zipFolder('payroll-proof', 'bank-statement').name,
      name: 'Lakeside Business Card statement 2026-09.pdf',
      bytes: await cardStatementPdf(),
    },
    {
      folder: zipFolder('payroll-proof', 'payroll-details').name,
      name: 'Transaction List with Splits 2026-09.xlsx',
      bytes: await transactionListXlsx(),
    },
    ...(await Promise.all(
      MAPPINGS.map(async (m) => ({
        folder: zipFolder('account-mapping').name,
        name: m.name,
        bytes: await accountMappingXlsx(m),
      }))
    )),
    ...(await Promise.all(
      RECEIPTS.map(async (r) => ({
        folder: zipFolder('receipts').name,
        name: r.name,
        bytes: await receiptPdf(r),
      }))
    )),
  ]
}
