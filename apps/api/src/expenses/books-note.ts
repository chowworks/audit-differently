import * as ExcelJS from 'exceljs'
import type { BooksSplitDto, StatementMark } from '@ad/types'

/**
 * The note a books line's copy of the accounting export opens with (owner's decision, 2026-11-12): a shared cost's
 * receipts and payments show the whole bill, the line one program's dollars of it, so the copy first shows how the books
 * charge the whole to every program, this line's row marked. Dollars only, as the books have them: never a rate. Drawn
 * as a sheet of its own before the export's, so nothing of the export is changed.
 */

const money = (n: number) =>
  `${n < 0 ? '−' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const cents = (n: number) => Math.round(n * 100) / 100
/** 09/30/2026 */
const usDate = (iso: string) => {
  const [y, m, d] = iso.split('-')
  return `${m}/${d}/${y}`
}

/** The note's words: its title, what it says, the table's rows (each class, then the total), and what comes off. */
export function booksNoteText(split: BooksSplitDto) {
  const mine = split.rows.filter((r) => r.mine)
  const booked = cents(mine.reduce((n, r) => n + r.amount, 0))
  const program = mine.map((r) => r.className).join(' and ')
  // The account's own name, not its path: "60203 Workers Comp" of "60000 G&A:60200 Insurance:60203 Workers Comp".
  const account = split.account.split(':').pop()!.trim()
  const how =
    split.how === 'entry'
      ? `The books share out this ${money(split.total)} of ${account} to the programs by allocation entry ${split.transactionId} on ${usDate(split.date)}.`
      : `The books split transaction ${split.transactionId} of ${usDate(split.date)}, ${money(split.total)} of ${account}, between the programs by class.`
  return {
    title: `How the books charge this ${money(split.total)}`,
    body: `${how} This line is ${program}'s ${money(booked)}.`,
    rows: split.rows.map((r) => ({
      className: r.className,
      amount: money(r.amount),
      mine: r.mine,
    })),
    total: money(split.total),
    less: split.less.map((x) => ({
      words: `Less bill ${x.transactionId} (${money(x.amount)}), dropped for want of its receipt or payment`,
      amount: money(-x.off),
    })),
    billed: split.less.length ? money(split.billed) : null,
    footer: 'Added by Audit Differently to this copy of the books. The books follow.',
  }
}

/** The split's rows on the export, as a sheet's marks are: a whole row (x 0) of its sheet (page). */
export const splitMarks = (split: BooksSplitDto): StatementMark[] =>
  (split.at ?? []).map(({ page, row }) => ({ page, x: 0, y: row, width: 1, height: 1 }))

const NOTE_SHEET = 'Note'
const YELLOW = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF176' } } as const

/**
 * The workbook with the note as its first sheet: its own sheets untouched, after it. The note's sheet takes a name the
 * workbook does not have ("Note", else "Note 2", …).
 */
export async function withBooksNote(bytes: Uint8Array, split: BooksSplitDto): Promise<Buffer> {
  const book = new ExcelJS.Workbook()
  await book.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer)
  const names = new Set(book.worksheets.map((w) => w.name.toLowerCase()))
  let name = NOTE_SHEET
  for (let k = 2; names.has(name.toLowerCase()); k++) name = `${NOTE_SHEET} ${k}`
  const text = booksNoteText(split)
  const sheet = book.addWorksheet(name)
  sheet.columns = [{ width: 64 }, { width: 16 }]
  sheet.addRow([text.title]).font = { bold: true, size: 14 }
  sheet.addRow([])
  const body = sheet.addRow([text.body])
  sheet.mergeCells(body.number, 1, body.number, 2)
  body.getCell(1).alignment = { wrapText: true, vertical: 'top' }
  body.height = 48
  sheet.addRow([])
  const head = sheet.addRow(['Program (class)', 'Amount'])
  head.font = { bold: true }
  head.getCell(2).alignment = { horizontal: 'right' }
  for (const r of text.rows) {
    const row = sheet.addRow([r.mine ? `${r.className}  ← this line` : r.className, r.amount])
    row.getCell(2).alignment = { horizontal: 'right' }
    if (r.mine) {
      row.font = { bold: true }
      row.eachCell({ includeEmpty: true }, (c) => (c.fill = YELLOW))
    }
  }
  const total = sheet.addRow(['Total', text.total])
  total.font = { bold: true }
  total.getCell(2).alignment = { horizontal: 'right' }
  total.getCell(1).border = total.getCell(2).border = { top: { style: 'thin' } }
  if (text.billed) {
    sheet.addRow([])
    for (const x of text.less) {
      const row = sheet.addRow([x.words, x.amount])
      row.getCell(1).alignment = { wrapText: true }
      row.getCell(2).alignment = { horizontal: 'right' }
    }
    const billed = sheet.addRow(['This line bills', text.billed])
    billed.font = { bold: true }
    billed.getCell(2).alignment = { horizontal: 'right' }
  }
  sheet.addRow([])
  sheet.addRow([text.footer]).font = { italic: true, color: { argb: 'FF666666' } }
  // First among the sheets, and the one the workbook opens at: ExcelJS writes sheets by their order number, which its
  // types leave out.
  const ordered = (w: ExcelJS.Worksheet) => w as ExcelJS.Worksheet & { orderNo: number }
  const others = book.worksheets.filter((w) => w !== sheet)
  ordered(sheet).orderNo = 0
  others.forEach((w, i) => (ordered(w).orderNo = i + 1))
  book.views = [
    { x: 0, y: 0, width: 10000, height: 20000, firstSheet: 0, activeTab: 0, visibility: 'visible' },
  ]
  return Buffer.from(await book.xlsx.writeBuffer())
}
