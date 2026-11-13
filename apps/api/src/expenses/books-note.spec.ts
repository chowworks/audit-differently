import * as ExcelJS from 'exceljs'
import type { BooksSplitDto } from '@ad/types'
import { itemCopy } from '../payroll/mark-pdf'
import { booksNoteText, splitMarks, withBooksNote } from './books-note'

/** A fictional allocation entry: $200.00 of payroll fees shared out to two programs. */
const split: BooksSplitDto = {
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
  at: [
    { page: 1, row: 2 },
    { page: 1, row: 3 },
    { page: 1, row: 4 },
  ],
}

const sheetOf = async (rows: (string | number)[][]) => {
  const book = new ExcelJS.Workbook()
  const sheet = book.addWorksheet('Transaction List with Splits')
  for (const r of rows) sheet.addRow(r)
  return new Uint8Array(await book.xlsx.writeBuffer())
}
const cells = (s: ExcelJS.Worksheet) =>
  s.getSheetValues().flatMap((r) => (Array.isArray(r) ? [r.filter((c) => c != null)] : []))

describe("the note a books line's export opens with (owner's decision, 2026-11-12)", () => {
  it("shows the books' dollars for every program, never a rate", () => {
    const t = booksNoteText(split)
    expect(t.title).toBe('How the books charge this $200.00')
    expect(t.body).toBe(
      "The books share out this $200.00 of 63301 Payroll Fees to the programs by allocation entry 9005 on 09/30/2026. This line is Youth Coding Program's $50.00."
    )
    expect(t.rows).toEqual([
      { className: 'Youth Coding Program', amount: '$50.00', mine: true },
      { className: 'Adult Bootcamp', amount: '$150.00', mine: false },
    ])
    expect(t.total).toBe('$200.00')
    expect(t.billed).toBeNull()
    expect(JSON.stringify(t)).not.toContain('%')
    // The account by its own name, not the books' path to it.
    expect(
      booksNoteText({ ...split, account: '60000 G&A:60200 Insurance Expense:60203 Workers Comp' })
        .body
    ).toContain('$200.00 of 60203 Workers Comp to the programs')
    // A bill split by class says so; a dropped bill's part comes off this line.
    const less = booksNoteText({
      ...split,
      how: 'split',
      less: [{ transactionId: '8002', amount: 100, off: 25 }],
      billed: 25,
    })
    expect(less.body).toContain(
      'The books split transaction 9005 of 09/30/2026, $200.00 of 63301 Payroll Fees'
    )
    expect(less.less).toEqual([
      {
        words: 'Less bill 8002 ($100.00), dropped for want of its receipt or payment',
        amount: '−$25.00',
      },
    ])
    expect(less.billed).toBe('$25.00')
  })

  it("puts the note first and leaves the export's own sheets as they were", async () => {
    const original = await sheetOf([
      ['Transaction date', 'Class', 'Amount'],
      ['09/30/2026', 'Youth Coding Program', 50],
    ])
    const back = new ExcelJS.Workbook()
    await back.xlsx.load((await withBooksNote(original, split)) as unknown as ArrayBuffer)
    expect(back.worksheets.map((w) => w.name)).toEqual(['Note', 'Transaction List with Splits'])
    const note = cells(back.worksheets[0]!).flat().join(' | ')
    expect(note).toContain('How the books charge this $200.00')
    expect(note).toContain('Youth Coding Program  ← this line | $50.00')
    expect(note).toContain('Total | $200.00')
    expect(cells(back.worksheets[1]!)).toEqual([
      ['Transaction date', 'Class', 'Amount'],
      ['09/30/2026', 'Youth Coding Program', 50],
    ])
  })

  it("highlights the entry's rows on the export's own sheet, with the note before it", async () => {
    const original = await sheetOf([
      ['Transaction date', 'Class', 'Amount'],
      ['09/30/2026', 'Allocation Required', -200],
      ['09/30/2026', 'Youth Coding Program', 50],
      ['09/30/2026', 'Adult Bootcamp', 150],
      ['09/30/2026', 'Someone else', 9],
    ])
    const marks = splitMarks(split)
    const copy = await itemCopy(original, marks, null, split)
    const back = new ExcelJS.Workbook()
    await back.xlsx.load(copy.bytes as unknown as ArrayBuffer)
    const books = back.worksheets[1]!
    const filled = [1, 2, 3, 4, 5].map(
      (r) =>
        (books.getRow(r).getCell(3).fill as { fgColor?: { argb?: string } } | undefined)?.fgColor
          ?.argb ?? null
    )
    expect(filled).toEqual([null, 'FFFFF176', 'FFFFF176', 'FFFFF176', null])
    // Without a note, the copy is payroll's as ever: the export's sheets alone.
    const plain = new ExcelJS.Workbook()
    await plain.xlsx.load((await itemCopy(original, marks)).bytes as unknown as ArrayBuffer)
    expect(plain.worksheets.map((w) => w.name)).toEqual(['Transaction List with Splits'])
  })
})
