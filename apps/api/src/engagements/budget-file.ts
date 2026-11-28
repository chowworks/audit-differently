import { BadRequestException } from '@nestjs/common'
import * as ExcelJS from 'exceljs'
import {
  BUDGET_FILE_COLUMNS,
  REPORT_LINES,
  REPORT_LINE_LABELS,
  type BudgetFileDto,
  type BudgetFileRow,
  type ReportLine,
} from '@ad/types'
import { amountOf as moneyOf } from '../imports/mapping'
import { headerKey, readGrid } from '../imports/table'
import { amountOf, nameOf, narrativeOf, reasonOf } from './budget-values'

/**
 * The approved budget as an Excel file (GitHub issue #98; owner's decisions, 2026-11-24 and 2026-11-27): the template
 * the team downloads, fills in or edits, and uploads again. Four columns: budget line, monthly report line, approved
 * amount and note. Every cell is required but the note, and an amount of $0 is written 0. The upload replaces the whole
 * budget.
 */

/** A budget has a few dozen lines at most: a file with more is not a budget. */
export const MAX_BUDGET_FILE_LINES = 200
/** Empty rows below the lines that offer the report line list, ready to fill in. */
const EMPTY_ROWS = 50
/** How far down the header row may be, so a title above it is fine. */
const HEADER_SEARCH_ROWS = 30
const NAVY = 'FF0B1F2E'
const PALE = 'FFEEF2F5'
const WIDTHS = [40, 26, 18, 50]
const LABELS = REPORT_LINES.map((l) => REPORT_LINE_LABELS[l])

type Line = { name: string; reportLine: string; amount: unknown; narrative: string | null }

/** A sheet of the template: the header, then the lines, then empty rows, with the list and the amount check. */
function budgetSheet(book: ExcelJS.Workbook, name: string, lines: Line[]) {
  const sheet = book.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] })
  sheet.columns = WIDTHS.map((width) => ({ width }))
  const head = sheet.addRow([...BUDGET_FILE_COLUMNS])
  head.height = 22
  head.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } }
    cell.alignment = { vertical: 'middle', horizontal: 'center' }
  })
  for (const l of lines)
    sheet.addRow([
      l.name,
      REPORT_LINE_LABELS[l.reportLine as ReportLine] ?? l.reportLine,
      Number(l.amount),
      l.narrative ?? '',
    ])
  const last = lines.length + EMPTY_ROWS + 1
  for (let r = 2; r <= last; r++) {
    const row = sheet.getRow(r)
    if (r % 2 === 1)
      for (let c = 1; c <= BUDGET_FILE_COLUMNS.length; c++)
        row.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PALE } }
    row.getCell(2).dataValidation = {
      type: 'list',
      allowBlank: false,
      formulae: [`"${LABELS.join(',')}"`],
      showErrorMessage: true,
      errorTitle: 'Monthly report line',
      error: 'Choose one of the lines of the list.',
    }
    row.getCell(3).numFmt = '#,##0.00'
    row.getCell(3).dataValidation = {
      type: 'decimal',
      operator: 'between',
      allowBlank: false,
      formulae: [0, 9999999999.99],
      showErrorMessage: true,
      errorTitle: 'Approved amount',
      error: 'Enter an amount of 0 or more. Write 0 for $0: do not leave it blank.',
    }
  }
}

const HOW_TO = [
  ['How to fill in the budget', 'title'],
  [''],
  [
    'Fill in the Budget sheet: one row for each line of the approved budget. The Example sheet shows a filled-in budget.',
  ],
  [''],
  ['Columns', 'head'],
  [
    'Budget line: the name of the line as the approved budget gives it. Each name is on one row only.',
  ],
  [
    "Monthly report line: choose from the list. It is the line of the funder's monthly form that the line rolls up to.",
  ],
  ['Approved amount: a number. Write 0 for $0. Do not leave it blank.'],
  ['Note: optional. A short note about the line.'],
  [''],
  ['Rules', 'head'],
  [
    'Fill in every cell of a row but the note. A row with a blank cell is not loaded: the upload tells you its row number.',
  ],
  ['An empty row is skipped.'],
  ['The file replaces the whole budget. A budget line with spending must stay in the file.'],
  ['Do not change the names or the order of the columns.'],
] as const

/** The template: the engagement's current lines on the Budget sheet, an Example sheet, and how to fill it in. */
export async function budgetFile(lines: Line[]): Promise<Buffer> {
  const book = new ExcelJS.Workbook()
  budgetSheet(book, 'Budget', lines)
  // Fictional lines only: the repository is public.
  budgetSheet(book, 'Example', [
    {
      name: 'Staff Salaries',
      reportLine: 'staff-salaries',
      amount: 42000,
      narrative: 'Two program coordinators',
    },
    {
      name: 'Program Supplies',
      reportLine: 'program-costs',
      amount: 3500,
      narrative: 'Laptops for cohort 2',
    },
    { name: 'Participant Wages', reportLine: 'wex', amount: 18000, narrative: null },
    { name: 'Indirect', reportLine: 'indirect', amount: 0, narrative: 'Not budgeted this year' },
  ])
  const help = book.addWorksheet('How to fill in')
  help.columns = [{ width: 110 }]
  for (const [text, kind] of HOW_TO) {
    const row = help.addRow([text])
    row.getCell(1).alignment = { wrapText: true, vertical: 'top' }
    if (kind === 'title') row.font = { bold: true, size: 16, color: { argb: NAVY } }
    if (kind === 'head') row.font = { bold: true, size: 12, color: { argb: NAVY } }
  }
  return Buffer.from(await book.xlsx.writeBuffer())
}

/** The report line a cell names: its name as the screen shows it, in any case. */
function reportLineOfCell(cell: string): ReportLine | null {
  const key = headerKey(cell)
  return REPORT_LINES.find((l) => headerKey(REPORT_LINE_LABELS[l]) === key) ?? null
}

/** A line of an uploaded file, as read: what Save would do with it is worked out against the budget. */
export type ReadLine = Omit<BudgetFileRow, 'action'>

/**
 * An uploaded budget file, read in memory (its first sheet): each row as a budget line, or the reasons it is refused,
 * every problem at once. Rows are numbered as the spreadsheet numbers them.
 */
export async function readBudgetFile(
  buffer: Buffer,
  fileName: string
): Promise<{ rows: ReadLine[]; problems: BudgetFileDto['problems']; names: Set<string> }> {
  const grid = await readGrid(buffer, fileName)
  const want = BUDGET_FILE_COLUMNS.map(headerKey)
  const required = want.slice(0, 3)
  const at = grid
    .slice(0, HEADER_SEARCH_ROWS)
    .findIndex((r) => required.every((w) => r.some((c) => headerKey(c) === w)))
  if (at < 0)
    throw new BadRequestException(
      `The file needs a header row with the columns ${BUDGET_FILE_COLUMNS.slice(0, -1).join(', ')} and ` +
        `${BUDGET_FILE_COLUMNS.at(-1)}. Download the template and fill it in.`
    )
  const columns = want.map((w) => grid[at]!.findIndex((c) => headerKey(c) === w))
  const cell = (r: string[], k: number) => (columns[k]! >= 0 ? (r[columns[k]!] ?? '').trim() : '')
  const body = grid
    .map((cells, i) => ({ cells, row: i + 1 }))
    .slice(at + 1)
    .filter(({ cells }) => cells.some((c) => c.trim()))
  if (body.length === 0)
    throw new BadRequestException('The file has no budget lines below its header')
  if (body.length > MAX_BUDGET_FILE_LINES)
    throw new BadRequestException(`A budget file holds up to ${MAX_BUDGET_FILE_LINES} lines`)

  const rows: ReadLine[] = []
  const problems: BudgetFileDto['problems'] = []
  const seen = new Map<string, number>()
  // Every name the file gives, its refused rows' too: a line it names is not left out of the file.
  const names = new Set(body.map(({ cells }) => cell(cells, 0).replace(/\s+/g, ' ').toLowerCase()))
  for (const { cells, row } of body) {
    const reasons: string[] = []
    const blank = (k: number) => !cell(cells, k)
    const missing = [0, 1, 2].filter(blank).map((k) => BUDGET_FILE_COLUMNS[k]!)
    if (missing.length)
      reasons.push(`${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} blank`)
    let name = ''
    if (!blank(0))
      try {
        name = nameOf(cell(cells, 0))
      } catch (e) {
        reasons.push(reasonOf(e))
      }
    let amount = 0
    const money = cell(cells, 2)
    if (!blank(2)) {
      const n = moneyOf(money)
      if (n === null) reasons.push(`"${money}" is not an amount`)
      else
        try {
          amount = Number(amountOf(n))
        } catch (e) {
          reasons.push(reasonOf(e))
        }
    }
    let narrative: string | null = null
    try {
      narrative = narrativeOf(cell(cells, 3))
    } catch (e) {
      reasons.push(reasonOf(e))
    }
    const twin = name ? seen.get(name.toLowerCase()) : undefined
    if (twin) reasons.push(`Row ${twin} has the same name`)
    else if (name) seen.set(name.toLowerCase(), row)
    // Last, as its list ends with a full stop ("Indirect for Parent Org.").
    const reportLine = reportLineOfCell(cell(cells, 1))
    if (!blank(1) && !reportLine)
      reasons.push(`Choose one of the monthly report lines: ${LABELS.join(', ')}`)
    if (reasons.length) problems.push({ row, reason: reasons.join('. ') })
    else rows.push({ row, name, reportLine: reportLine!, amount, narrative })
  }
  return { rows, problems, names }
}
