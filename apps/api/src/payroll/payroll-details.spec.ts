import type { StatementLine } from '@ad/types'
import * as ExcelJS from 'exceljs'
import { chargedPayOf, chargesOf, sheetCopy, sheetLines, sheetMarks } from './payroll-details'
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
})
