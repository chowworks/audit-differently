import { BadRequestException } from '@nestjs/common'
import * as ExcelJS from 'exceljs'
import { budgetFile, MAX_BUDGET_FILE_LINES, readBudgetFile } from './budget-file'

/** An .xlsx whose first sheet has these rows. */
async function xlsx(rows: (string | number | null)[][]): Promise<Buffer> {
  const book = new ExcelJS.Workbook()
  const sheet = book.addWorksheet('Budget')
  for (const r of rows) sheet.addRow(r)
  return Buffer.from(await book.xlsx.writeBuffer())
}

const HEAD = ['Budget line', 'Monthly report line', 'Approved amount', 'Note']
const LIST =
  '"Staff Salaries,Staff Fringe Benefits,Program Costs,Participant Wages,Participant Fringes,WEX,Indirect for Parent Org."'

async function refusal(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException)
    return (e as BadRequestException).message
  }
  throw new Error('the file was not refused')
}

describe('budget file', () => {
  it('writes the template with the current lines, which read back as the same lines', async () => {
    const bytes = await budgetFile([
      { name: 'Staff Salaries', reportLine: 'staff-salaries', amount: '42000.00', narrative: null },
      { name: 'Indirect', reportLine: 'indirect', amount: 0, narrative: 'Not budgeted' },
    ])
    const read = await readBudgetFile(bytes, 'budget.xlsx')
    expect(read.rows).toEqual([
      {
        row: 2,
        name: 'Staff Salaries',
        reportLine: 'staff-salaries',
        amount: 42000,
        narrative: null,
      },
      { row: 3, name: 'Indirect', reportLine: 'indirect', amount: 0, narrative: 'Not budgeted' },
    ])
    expect(read.problems).toEqual([])
  })

  it('lays the template out as agreed: Budget, Example and How to fill in, with the list and the amount check', async () => {
    const book = new ExcelJS.Workbook()
    await book.xlsx.load(
      (await budgetFile([
        { name: 'Travel', reportLine: 'program-costs', amount: 1500, narrative: null },
      ])) as unknown as ArrayBuffer
    )
    expect(book.worksheets.map((w) => w.name)).toEqual(['Budget', 'Example', 'How to fill in'])
    const sheet = book.getWorksheet('Budget')!
    expect(sheet.getRow(1).values).toEqual([undefined, ...HEAD])
    // On the line and on the empty rows below it.
    for (const r of [2, 40]) {
      expect(sheet.getCell(r, 2).dataValidation).toMatchObject({ type: 'list', formulae: [LIST] })
      expect(sheet.getCell(r, 3).dataValidation).toMatchObject({
        type: 'decimal',
        formulae: [0, 9999999999.99],
      })
    }
    // The Example sheet's lines are fictional and read like any budget.
    expect(book.getWorksheet('Example')!.getRow(5).values).toEqual([
      undefined,
      'Indirect',
      'Indirect for Parent Org.',
      0,
      'Not budgeted this year',
    ])
  })

  it('refuses each bad row with its row number and every reason, and reads the note as optional', async () => {
    const file = await xlsx([
      ['Riverbend budget, FY 2027'],
      [],
      HEAD,
      ['Travel', 'program costs', '$1,500.00', ''],
      ['', 'Rent', 'abc', ''],
      [],
      ['Supplies', 'Program Costs', -5, ''],
      ['travel', 'Program Costs', 10, ''],
      ['Mentors', 'WEX', null, 'Paid monthly'],
      ['Indirect', 'Indirect for Parent Org.', 0, null],
    ])
    const read = await readBudgetFile(file, 'budget.xlsx')
    expect(read.rows).toEqual([
      { row: 4, name: 'Travel', reportLine: 'program-costs', amount: 1500, narrative: null },
      { row: 10, name: 'Indirect', reportLine: 'indirect', amount: 0, narrative: null },
    ])
    expect(read.problems).toEqual([
      {
        row: 5,
        reason:
          'Budget line is blank. "abc" is not an amount. Choose one of the monthly report lines: Staff ' +
          'Salaries, Staff Fringe Benefits, Program Costs, Participant Wages, Participant Fringes, WEX, ' +
          'Indirect for Parent Org.',
      },
      { row: 7, reason: 'The amount must be $0 or more' },
      { row: 8, reason: 'Row 4 has the same name' },
      // A blank amount is refused: $0 is written 0.
      { row: 9, reason: 'Approved amount is blank' },
    ])
    // Every name the file gives, its refused rows' too.
    expect([...read.names]).toEqual(['travel', '', 'supplies', 'mentors', 'indirect'])
  })

  it('reads a CSV file the same way', async () => {
    const csv = Buffer.from(`${HEAD.join(',')}\nTravel,Program Costs,"$1,500.00",Site visits\n`)
    expect((await readBudgetFile(csv, 'budget.csv')).rows).toEqual([
      {
        row: 2,
        name: 'Travel',
        reportLine: 'program-costs',
        amount: 1500,
        narrative: 'Site visits',
      },
    ])
  })

  it('refuses a file without the header row, with no lines, or with too many lines', async () => {
    expect(
      await refusal(async () => readBudgetFile(await xlsx([['Name', 'Amount']]), 'b.xlsx'))
    ).toBe(
      'The file needs a header row with the columns Budget line, Monthly report line, Approved amount and ' +
        'Note. Download the template and fill it in.'
    )
    expect(await refusal(async () => readBudgetFile(await xlsx([HEAD, []]), 'b.xlsx'))).toBe(
      'The file has no budget lines below its header'
    )
    const many = Array.from({ length: MAX_BUDGET_FILE_LINES + 1 }, (_, i) => [
      `Line ${i}`,
      'WEX',
      1,
      '',
    ])
    expect(await refusal(async () => readBudgetFile(await xlsx([HEAD, ...many]), 'b.xlsx'))).toBe(
      'A budget file holds up to 200 lines'
    )
  })
})
