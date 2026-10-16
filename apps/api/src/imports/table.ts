import { BadRequestException } from '@nestjs/common'
import * as ExcelJS from 'exceljs'
import { unzipSync } from 'fflate'
import { looksLike } from '../documents/documents.service'

/** An exported transactions file is read in memory and never stored: these keep that cheap. */
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024
export const MAX_IMPORT_ROWS = 5000
/** No accounting export is this wide; a wider file is refused before it is padded out in memory. */
export const MAX_IMPORT_COLUMNS = 200
/** An .xlsx is a zip: what it may unpack to, so a small file cannot fill the memory. */
const MAX_XLSX_UNPACKED = 60 * 1024 * 1024
/** How far down the header row may be (QuickBooks puts the company name and report title above it). */
const HEADER_SEARCH_ROWS = 30
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/**
 * A file's table: its column names and its rows below them, each with its line in the file. `headerFound` is true
 * only when a row of known column names was found and none of its cells looks like a value (a digit, so no amount,
 * date or number): only then may the column names leave the system (the AI guess).
 */
export interface Table {
  headers: string[]
  rows: { line: number; cells: string[] }[]
  headerFound: boolean
}

const bad = (m: string) => new BadRequestException(m)
const tooWide = () =>
  bad(`The file has more than ${MAX_IMPORT_COLUMNS} columns: export only the transaction columns`)
const tooMany = () => bad(`Import up to ${MAX_IMPORT_ROWS.toLocaleString('en-US')} rows at a time`)
/** The header row may sit this far down, so the parser stops only past the rows and that many more. */
const MAX_CSV_ROWS = MAX_IMPORT_ROWS + HEADER_SEARCH_ROWS + 1
/** Every blank row of a CSV is this one array, so a file of empty lines costs no memory. */
const BLANK: string[] = []

/**
 * Reads an uploaded .csv or .xlsx into a table. The bytes decide, never the browser's claim: an .xlsx must begin like
 * a zip, a .csv must be UTF-8 text with no NUL byte.
 */
export async function readTable(buffer: Buffer, fileName: string): Promise<Table> {
  if (buffer.length === 0) throw bad('The file is empty')
  if (buffer.length > MAX_IMPORT_BYTES) throw bad('Import files are limited to 5 MB')
  const ext = /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase()
  let grid: string[][]
  if (ext === 'xlsx') {
    if (!looksLike(buffer, XLSX_TYPE)) throw bad('The file does not look like an .xlsx')
    grid = await xlsxGrid(buffer)
  } else if (ext === 'csv') {
    grid = parseCsv(csvText(buffer))
  } else {
    throw bad('Choose a .csv or .xlsx file')
  }
  return tableOf(grid)
}

/** The text of a CSV, if it is UTF-8 with no NUL byte (a binary file, or a spreadsheet renamed .csv, is not). */
export function csvText(buffer: Buffer): string {
  if (buffer.includes(0)) throw bad('The file does not look like a .csv')
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^\uFEFF/, '')
  } catch {
    throw bad('The file is not UTF-8 text. Save it as "CSV UTF-8" and try again')
  }
}

/**
 * RFC 4180 CSV: quoted fields with commas, doubled quotes and line breaks inside; CRLF or LF line ends. A row wider
 * than MAX_IMPORT_COLUMNS, or more rows with values than an import takes, is refused as it is read.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let filled = 0
  let row: string[] = []
  let field = ''
  let quoted = false
  const push = () => {
    if (row.length >= MAX_IMPORT_COLUMNS) throw tooWide()
    row.push(field)
    field = ''
  }
  const end = () => {
    if (row.every((c) => c.trim() === '')) rows.push(BLANK)
    else {
      if (++filled > MAX_CSV_ROWS) throw tooMany()
      rows.push(row)
    }
    row = []
  }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += ch
    } else if (ch === '"' && field === '') quoted = true
    else if (ch === ',') push()
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      push()
      end()
    } else field += ch
  }
  if (quoted) throw bad('The file has a quote that is never closed')
  if (field !== '' || row.length) {
    push()
    end()
  }
  return rows
}

/** The first worksheet of an .xlsx as text cells: dates as YYYY-MM-DD, formulas by their result. */
async function xlsxGrid(buffer: Buffer): Promise<string[][]> {
  let unpacked = 0
  try {
    unzipSync(new Uint8Array(buffer), {
      filter: (f) => {
        unpacked += f.originalSize
        return false
      },
    })
  } catch {
    throw bad('The file does not look like an .xlsx')
  }
  if (unpacked > MAX_XLSX_UNPACKED) throw bad('The spreadsheet is too large to import')
  const book = new ExcelJS.Workbook()
  try {
    await book.xlsx.load(buffer as unknown as ArrayBuffer)
  } catch {
    throw bad('The spreadsheet could not be read')
  }
  const sheet = book.worksheets[0]
  if (!sheet) return []
  const grid: string[][] = []
  sheet.eachRow({ includeEmpty: true }, (row, n) => {
    const values = Array.isArray(row.values) ? row.values.slice(1) : []
    grid[n - 1] = values.map(cellText)
  })
  return Array.from(grid, (r) => r ?? [])
}

function cellText(v: ExcelJS.CellValue | undefined): string {
  if (v == null) return ''
  // A number cell is unambiguous: to the cent, so a formula's float noise (0.30000000000000004) reads as 0.3.
  if (typeof v === 'number') return String(Number.isInteger(v) ? v : Math.round(v * 100) / 100)
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'object') {
    if ('result' in v) return cellText(v.result as ExcelJS.CellValue)
    if ('richText' in v) return v.richText.map((t) => t.text).join('')
    if ('text' in v) return String(v.text)
    return ''
  }
  return String(v)
}

/** How a header reads for matching: lower case, single spaces. */
export const headerKey = (h: string) => h.trim().toLowerCase().replace(/\s+/g, ' ')

/** Header names the import knows (see mapping.ts); a row with several of them is the header row. */
const KNOWN = new Set([
  'date',
  'transaction date',
  'txn date',
  'num',
  'no.',
  'ref no.',
  'reference',
  'name',
  'payee',
  'vendor',
  'memo',
  'description',
  'memo/description',
  'account',
  'split',
  'category',
  'amount',
  'debit',
  'credit',
  'class',
  'transaction type',
])

/**
 * Finds the header row (the first rows of a QuickBooks report are its title, the company and the dates) and names
 * every column: a blank header is "Column 3", a repeated one "Amount (2)". Blank rows are dropped before anything is
 * padded, and a file wider than MAX_IMPORT_COLUMNS is refused.
 */
export function tableOf(grid: string[][]): Table {
  const nonEmpty = (r: string[]) => r.filter((c) => c.trim() !== '').length
  /** How many columns a row really uses: up to its last cell with a value. */
  const used = (r: string[]) => {
    let n = r.length
    while (n > 0 && r[n - 1].trim() === '') n--
    return n
  }
  let at = -1
  let best = 1
  for (let i = 0; i < Math.min(grid.length, HEADER_SEARCH_ROWS); i++) {
    const score = grid[i].filter((c) => KNOWN.has(headerKey(c))).length
    if (score > best) {
      best = score
      at = i
    }
  }
  const known = at >= 0
  if (!known) at = grid.findIndex((r) => nonEmpty(r) >= 2)
  if (at < 0) throw bad('No header row found: the file needs a row of column names')
  const below: { line: number; cells: string[] }[] = []
  for (let i = at + 1; i < grid.length; i++) {
    if (nonEmpty(grid[i]) === 0) continue
    if (below.length === MAX_IMPORT_ROWS) throw tooMany()
    below.push({ line: i + 1, cells: grid[i] })
  }
  if (below.length === 0) throw bad('The file has no rows below its header')
  const width = below.reduce((w, r) => Math.max(w, used(r.cells)), used(grid[at]))
  if (width > MAX_IMPORT_COLUMNS) throw tooWide()
  const seen = new Map<string, number>()
  const headers = Array.from({ length: width }, (_, i) => {
    const name = (grid[at][i] ?? '').trim() || `Column ${i + 1}`
    const n = (seen.get(name.toLowerCase()) ?? 0) + 1
    seen.set(name.toLowerCase(), n)
    return n === 1 ? name : `${name} (${n})`
  })
  const rows = below.map((r) => ({
    line: r.line,
    cells: headers.map((_, j) => (r.cells[j] ?? '').trim()),
  }))
  return { headers, rows, headerFound: known && !grid[at].some((c) => /\d/.test(c)) }
}
