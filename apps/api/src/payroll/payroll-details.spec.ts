import type { StatementLine } from '@ad/types'
import * as ExcelJS from 'exceljs'
import {
  balanceSheetAccount,
  chargedPayOf,
  chargesOf,
  csvLines,
  programIn,
  sheetCopy,
  sheetLines,
  sheetMarks,
} from './payroll-details'
import { itemCopy } from './mark-pdf'

/** Rows as `sheetLines` reads them: cells joined by " | ". Fictional people and pay. */
const rows = (...texts: string[]): StatementLine[] =>
  texts.map((text, i) => ({ page: 1, x: 0, y: i + 2, width: 1, height: 1, text }))

const details = rows(
  'Item # | Date | Vendor | Memo/Description | Account | Allocated Amount',
  '2026-09-11 | PayPeople | [PayPeople] Salary for Youth Coding Program jobs for Morgan Lee. Payroll run: Aug 24th - Sep 6th: Riverbend | 63102 Payroll Expenses:Salaries - Employees | 612.5',
  '2026-09-11 | PayPeople | [PayPeople] Holiday Hours for Youth Coding Program jobs for Morgan Lee. Payroll run: Aug 24th - Sep 6th: Riverbend | 63102 Payroll Expenses:Salaries - Employees | 40',
  '2026-09-11 | PayPeople | [PayPeople] Social Security - Employer for Youth Coding Program jobs for Morgan Lee. Payroll run: Aug 24th - Sep 6th: Riverbend | 63202 Payroll Expenses:Employees - Taxes | 40.45',
  '2026-09-11 | PayPeople | [PayPeople] Base Pay for Youth Coding Program jobs for Casey Demo. Payroll run: Aug 24th - Sep 6th: Riverbend | 63103 Payroll Expenses:Salaries - Work Experience (WEX) | 140',
  '2026-09-25 | PayPeople | [PayPeople] Base Pay for Youth Coding Program jobs for Casey Demo. Payroll run: Sep 7th - Sep 20th: Riverbend | 63103 Payroll Expenses:Salaries - Work Experience (WEX) | 280'
)

describe('payroll details (#22, section 8)', () => {
  it('reads each row: whose pay, which run and job, the account and the amount', () => {
    const c = chargesOf(details)
    expect(c).toHaveLength(5)
    expect(c[0]).toMatchObject({
      name: 'Morgan Lee',
      type: 'Salary',
      job: 'Youth Coding Program',
      amount: 612.5,
      start: '2026-08-24',
      end: '2026-09-06',
      pay: true,
      wex: false,
    })
    // The employer's taxes are booked, but they are not the person's pay.
    expect(c[2]).toMatchObject({ type: 'Social Security - Employer', pay: false })
    expect(c[3]).toMatchObject({ name: 'Casey Demo', pay: true, wex: true, amount: 140 })
  })

  it("adds up a person's pay rows per run, by the name on our list", () => {
    const c = chargesOf(details)
    expect(chargedPayOf(c, 'Morgan Lee').map((x) => [x.start, x.end, x.amount])).toEqual([
      ['2026-08-24', '2026-09-06', 652.5],
    ])
    expect(chargedPayOf(c, 'Casey Demo').map((x) => [x.end, x.amount])).toEqual([
      ['2026-09-06', 140],
      ['2026-09-20', 280],
    ])
    expect(chargedPayOf(c, 'Riley Example')).toEqual([])
  })

  it('reads a period across the new year by the row date', () => {
    const c = chargesOf(
      rows(
        '2026-01-13 | [PayPeople] Salary for Youth Coding Program jobs for Morgan Lee. Payroll run: Dec 28th - Jan 10th: Riverbend | 63102 Payroll Expenses:Salaries - Employees | 700'
      )
    )
    expect([c[0]!.start, c[0]!.end]).toEqual(['2025-12-28', '2026-01-10'])
  })

  it('reads a spreadsheet row by row, dates as yyyy-mm-dd', async () => {
    const book = new ExcelJS.Workbook()
    const sheet = book.addWorksheet('Payroll details')
    sheet.addRow(['Date', 'Memo', 'Amount'])
    sheet.addRow([new Date(Date.UTC(2026, 8, 11)), 'Salary for Morgan Lee', 612.5])
    const lines = await sheetLines(Buffer.from(await book.xlsx.writeBuffer()))
    expect(lines.map((l) => [l.page, l.y, l.text])).toEqual([
      [1, 1, 'Date | Memo | Amount'],
      [1, 2, '2026-09-11 | Salary for Morgan Lee | 612.5'],
    ])
  })

  it("keeps every row of a person's run (pay, taxes) for their copy, the pay alone added up", () => {
    const [run] = chargedPayOf(chargesOf(details), 'Morgan Lee')
    expect(run!.amount).toBe(652.5)
    expect(run!.lines.map((l) => l.y)).toEqual([3, 4, 5])
  })

  it('highlights whole rows, or the cells the admin picked', () => {
    const [run] = chargedPayOf(chargesOf(details), 'Morgan Lee')
    expect(sheetMarks(run!.lines, 'Morgan Lee', ['row']).map((m) => [m.y, m.x])).toEqual([
      [3, 0],
      [4, 0],
      [5, 0],
    ])
    const cells = sheetMarks(run!.lines.slice(0, 1), 'Morgan Lee', ['name', 'amount'])
    // The description names them (column 3) and the amount is the last cell (column 5).
    expect(cells.map((m) => m.x).sort()).toEqual([3, 5])
  })

  it("fills the item's copy yellow, the original untouched", async () => {
    const book = new ExcelJS.Workbook()
    const sheet = book.addWorksheet('Payroll details')
    sheet.addRow(['Date', 'Memo', 'Amount'])
    sheet.addRow(['2026-09-11', 'Salary for Morgan Lee', 612.5])
    sheet.addRow(['2026-09-11', 'Salary for Casey Demo', 140])
    const original = new Uint8Array(await book.xlsx.writeBuffer())
    const copy = await itemCopy(original, [
      { page: 1, x: 0, y: 2, width: 1, height: 1 },
      { page: 1, x: 3, y: 3, width: 1, height: 1 },
    ])
    expect(copy.notDrawn).toEqual([])
    const back = new ExcelJS.Workbook()
    await back.xlsx.load(Buffer.from(copy.bytes) as unknown as ArrayBuffer)
    const fill = (r: number, c: number) =>
      (back.worksheets[0]!.getRow(r).getCell(c).fill as { fgColor?: { argb?: string } } | undefined)
        ?.fgColor?.argb
    expect([fill(2, 1), fill(2, 3), fill(3, 2), fill(3, 3), fill(1, 1)]).toEqual([
      'FFFFF176',
      'FFFFF176',
      undefined,
      'FFFFF176',
      undefined,
    ])
    expect(await sheetCopy(original, [])).toBeInstanceOf(Buffer)
  })

  it('fills only the marked row when every row shares one format, as an accounting export does', async () => {
    const book = new ExcelJS.Workbook()
    const sheet = book.addWorksheet('Payroll details')
    for (const [who, amount] of [
      ['Morgan Lee', 612.5],
      ['Casey Demo', 140],
      ['Riley Sample', 300],
    ] as const) {
      const row = sheet.addRow(['2026-09-11', `Salary for ${who}`, amount])
      row.eachCell((c) => (c.numFmt = '#,##0.00'))
    }
    const original = new Uint8Array(await book.xlsx.writeBuffer())
    const copy = await sheetCopy(original, [{ page: 1, x: 0, y: 2 }])
    const back = new ExcelJS.Workbook()
    await back.xlsx.load(copy as unknown as ArrayBuffer)
    const filled = [1, 2, 3].map(
      (r) =>
        (
          back.worksheets[0]!.getRow(r).getCell(3).fill as
            { fgColor?: { argb?: string } } | undefined
        )?.fgColor?.argb ?? null
    )
    expect(filled).toEqual([null, 'FFFFF176', null])
    // Its format is kept.
    expect(back.worksheets[0]!.getRow(2).getCell(3).numFmt).toBe('#,##0.00')
  })
})

describe('payroll details as an accounting system exports them (owner, 2026-11-01)', () => {
  // A ledger's "transaction list with splits": title rows, then a header; the last column is the transaction's id, the
  // date is text, and the payroll journal entry's liability rows sit beside its expense rows. Fictional.
  const ledger = rows(
    'Riverbend Learning',
    'Transaction List with Splits',
    ' | Transaction date | Transaction type | Num | Name | Class full name | Description | Account Name | Amount | Transaction ID',
    ' | 09/30/2026 | Journal Entry | PR-B |  | Youth - Board ISY | [PayPeople] Salary for Board (In-School Youth) jobs for Morgan Lee. Payroll run: Sep 16 - Sep 30: Riverbend | 60000 Payroll Expenses:63102 Salaries - Employees | 612.5 | 501',
    ' | 09/30/2026 | Journal Entry | PR-B |  | Youth - Board ISY | [PayPeople] Medical Deductions (deduction) for Morgan Lee. Payroll run: Sep 16 - Sep 30: Riverbend | 24000 Payroll Liabilities:Employee deductions | 25.00 | 501',
    ' | 09/30/2026 | Journal Entry | PR-B |  | Youth - Board ISY | [PayPeople] Social Security - Employer for Morgan Lee. Payroll run: Sep 16 - Sep 30: Riverbend | 60000 Payroll Expenses:63202 Employees - Taxes | 37.98 | 501',
    ' | 07/01/2026 | Journal Entry | PR rev |  | Youth - Board ISY | [PayPeople] Salary for Morgan Lee. Payroll run: Jun 28th - Jul 11th: Riverbend | 60000 Payroll Expenses:63102 Salaries - Employees | -100 | 502',
    'Total for 60000 Payroll Expenses |  |  |  |  |  |  |  | 575.48'
  )

  it('reads the amount, date, account and class from their columns, never the id; leaves out the liabilities', () => {
    const c = chargesOf(ledger)
    expect(c.map((x) => [x.name, x.amount, x.date, x.account, x.program, x.pay])).toEqual([
      ['Morgan Lee', 612.5, '2026-09-30', '63102 Salaries - Employees', 'Youth - Board ISY', true],
      ['Morgan Lee', 37.98, '2026-09-30', '63202 Employees - Taxes', 'Youth - Board ISY', false],
      ['Morgan Lee', -100, '2026-07-01', '63102 Salaries - Employees', 'Youth - Board ISY', true],
    ])
    expect([c[0]!.start, c[0]!.end]).toEqual(['2026-09-16', '2026-09-30'])
    // A reversal booked on the 1st for a run ending on the 11th is that run's, in that year.
    expect([c[2]!.start, c[2]!.end]).toEqual(['2026-06-28', '2026-07-11'])
  })

  it('knows a balance-sheet account by its words or its number', () => {
    expect(balanceSheetAccount('24000 Payroll Liabilities:Benefits')).toBe(true)
    expect(balanceSheetAccount('10000 Operating Checking')).toBe(true)
    expect(balanceSheetAccount('Accrued Payroll Liability')).toBe(true)
    expect(balanceSheetAccount('60000 Payroll Expenses:63102 Salaries - Employees')).toBe(false)
    expect(balanceSheetAccount('Salaries - Employees')).toBe(false)
  })

  it('reads a CSV as rows of cells, as a spreadsheet', () => {
    const lines = csvLines(
      Buffer.from(
        'Pay date,09/18/2026\nEmployee,Client Projects,Salary Amount\n"Lee, Morgan","Board (In-School Youth)",612.50\n'
      )
    )
    expect(lines.map((l) => l.text)).toEqual([
      'Pay date | 09/18/2026',
      'Employee | Client Projects | Salary Amount',
      'Lee, Morgan | Board (In-School Youth) | 612.50',
    ])
    expect(() => csvLines(Buffer.from([0x50, 0x00, 0x4b]))).toThrow()
  })
})

describe('reading edge cases (review, 2026-11-01)', () => {
  it('names a program by whole words, its exact name first, then its longest', () => {
    const programs = [
      { id: 'it', names: ['IT'] },
      { id: 'boot', names: ['IT Bootcamp'] },
      { id: 'youth', names: ['Youth'] },
      { id: 'isy', names: ['Youth - Board ISY'] },
    ]
    expect(programIn('Board (Digital Literacy)', programs)).toBeUndefined()
    expect(programIn('Riverbend IT Bootcamp (2026)', programs)).toBe('boot')
    expect(programIn('Youth - Board ISY', programs)).toBe('isy')
    expect(programIn('Youth', programs)).toBe('youth')
  })

  it('skips a row lined up with the header whose amount is blank, never reading another number', () => {
    const c = chargesOf(
      rows(
        'Date | Num | Description | Account | Amount',
        '09/30/2026 | 1045 | [PayPeople] Salary for Morgan Lee. Payroll run: Sep 16 - Sep 30: Riverbend | 63102 Salaries'
      )
    )
    expect(c).toEqual([])
  })

  it('keeps an expense account whose number starts like a balance-sheet one', () => {
    expect(balanceSheetAccount('1099 Contract Labor')).toBe(false)
  })

  it('never puts a run months after its row into the next year', () => {
    const c = chargesOf(
      rows(
        '2026-09-30 | [PayPeople] Salary for Morgan Lee. Payroll run: Feb 2nd - Feb 15th: Riverbend | 63102 Payroll Expenses:Salaries | 50'
      )
    )
    expect([c[0]!.start, c[0]!.end]).toEqual(['2026-02-02', '2026-02-15'])
  })
})
