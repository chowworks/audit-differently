import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as ExcelJS from 'exceljs'
import { parseCsv, readTable, tableOf } from './table'

/** Reading an exported transactions file: CSV as QuickBooks writes it, and Excel. The bytes decide the type. */
const SAMPLE = readFileSync(join(__dirname, '../../test/fixtures/sample-qb-export.csv'))

async function xlsx(rows: unknown[][]): Promise<Buffer> {
  const book = new ExcelJS.Workbook()
  const sheet = book.addWorksheet('Transactions')
  for (const r of rows) sheet.addRow(r)
  return Buffer.from(await book.xlsx.writeBuffer())
}

describe('parseCsv', () => {
  it('reads quoted fields with commas, doubled quotes and line breaks, and CRLF or LF line ends', () => {
    expect(parseCsv('a,"b, c","say ""hi"""\r\n1,"two\nlines",3\n')).toEqual([
      ['a', 'b, c', 'say "hi"'],
      ['1', 'two\nlines', '3'],
    ])
    expect(parseCsv('x,y')).toEqual([['x', 'y']])
    expect(parseCsv('x,\r\n,y\r\n')).toEqual([
      ['x', ''],
      ['', 'y'],
    ])
  })

  it('refuses a quote that is never closed', () => {
    expect(() => parseCsv('a,"b\n1,2')).toThrow(/never closed/)
  })

  it('refuses a row wider than 200 columns as it reads it, before anything is padded', () => {
    expect(parseCsv('a' + ','.repeat(199))[0]).toHaveLength(200)
    expect(() => parseCsv('Date\n' + ','.repeat(200))).toThrow(/more than 200 columns/)
  })

  it('stops reading past the rows an import takes, and keeps blank lines as nothing', () => {
    const rows = Array.from({ length: 5040 }, () => '1,2').join('\n')
    expect(() => parseCsv(rows)).toThrow(/up to 5,000 rows/)
    const blanks = parseCsv('a,b\n' + '\n'.repeat(10000) + ',\n')
    expect(blanks).toHaveLength(10002)
    expect(blanks[1]).toBe(blanks[10001])
  })
})

describe('tableOf', () => {
  it("finds the header row under QuickBooks' report title and names every column", () => {
    const t = tableOf([
      ['Transaction Report'],
      ['Demo Company'],
      [],
      ['', 'Date', 'Num', 'Name', 'Amount', 'Amount'],
      ['Checking', '', '', '', '', ''],
      ['', '07/02/2026', '1', 'A Vendor', '-5.00', ''],
      ['', '', '', '', '', ''],
    ])
    expect(t.headers).toEqual(['Column 1', 'Date', 'Num', 'Name', 'Amount', 'Amount (2)'])
    // Blank rows go; every other row keeps its line in the file.
    expect(t.rows).toEqual([
      { line: 5, cells: ['Checking', '', '', '', '', ''] },
      { line: 6, cells: ['', '07/02/2026', '1', 'A Vendor', '-5.00', ''] },
    ])
  })

  it('takes the first row of several values when no column name is a known one, and marks it no header', () => {
    const t = tableOf([['Export'], ['When', 'Who', 'How much'], ['2026-07-01', 'X', '1']])
    expect(t.headers).toEqual(['When', 'Who', 'How much'])
    expect(t.rows).toHaveLength(1)
    expect(t.headerFound).toBe(false)
    // A file with no header at all: its first transaction stands in, and is never a header.
    expect(
      tableOf([
        ['07/01/2026', 'Bright Path', '12.00'],
        ['07/02/2026', 'Lakeside Transit', '4.00'],
      ]).headerFound
    ).toBe(false)
  })

  it('marks a row of known column names a header only when none of its cells holds a digit', () => {
    expect(
      tableOf([
        ['Date', 'Name', 'Amount'],
        ['1', '2', '3'],
      ]).headerFound
    ).toBe(true)
    expect(
      tableOf([
        ['Date', 'Name', 'Amount', '07/01/2026'],
        ['1', '2', '3', '4'],
      ]).headerFound
    ).toBe(false)
  })

  it('refuses a table wider than 200 columns, but not one with blank columns at the end', () => {
    const wide = Array.from({ length: 201 }, (_, i) => `c${i}`)
    expect(() =>
      tableOf([
        ['Date', 'Name', ...wide],
        ['1', '2'],
      ])
    ).toThrow(/more than 200/)
    const t = tableOf([
      ['Date', 'Name', ...Array(500).fill('')],
      ['1', '2', ...Array(500).fill('')],
    ])
    expect(t.headers).toEqual(['Date', 'Name'])
  })

  it('refuses a file with no rows, and one with more than 5,000', () => {
    expect(() => tableOf([['Date', 'Name', 'Amount']])).toThrow(/no rows/)
    const many = [
      ['Date', 'Name', 'Amount'],
      ...Array.from({ length: 5001 }, () => ['1', '2', '3']),
    ]
    expect(() => tableOf(many)).toThrow(/up to 5,000 rows/)
  })
})

describe('readTable', () => {
  it('reads the sample QuickBooks export', async () => {
    const t = await readTable(SAMPLE, 'sample-qb-export.csv')
    expect(t.headers).toEqual([
      'Column 1',
      'Date',
      'Transaction Type',
      'Num',
      'Name',
      'Memo/Description',
      'Account',
      'Split',
      'Amount',
    ])
    expect(t.rows[1].cells).toEqual([
      '',
      '08/04/2026',
      'Expense',
      '2101',
      'Bright Path Office Supply',
      'Printer paper, toner',
      'Checking',
      'Office Supplies',
      '-186.40',
    ])
  })

  it('reads the first sheet of an .xlsx: dates as YYYY-MM-DD, formulas by their result', async () => {
    const buffer = await xlsx([
      ['Report title'],
      ['Date', 'Payee', 'Amount'],
      [new Date(Date.UTC(2026, 6, 15)), 'Bright Path Office Supply', 12.5],
      [
        new Date(Date.UTC(2026, 6, 16)),
        { richText: [{ text: 'Lakeside ' }, { text: 'Transit' }] },
        { formula: '2*5', result: 10 },
      ],
    ])
    const t = await readTable(buffer, 'export.XLSX')
    expect(t.headers).toEqual(['Date', 'Payee', 'Amount'])
    expect(t.rows.map((r) => r.cells)).toEqual([
      ['2026-07-15', 'Bright Path Office Supply', '12.5'],
      ['2026-07-16', 'Lakeside Transit', '10'],
    ])
  })

  it('goes by the bytes, never the name alone', async () => {
    await expect(readTable(Buffer.from('Date,Name\n1,2'), 'x.xlsx')).rejects.toThrow(
      /does not look like an .xlsx/
    )
    await expect(readTable(await xlsx([['Date', 'Name']]), 'x.csv')).rejects.toThrow(
      /does not look like a .csv/
    )
    await expect(readTable(Buffer.from([0x44, 0xff, 0xfe, 0x2c]), 'x.csv')).rejects.toThrow(
      /not UTF-8/
    )
    await expect(readTable(Buffer.from('Date,Name\n1,2'), 'x.pdf')).rejects.toThrow(
      /\.csv or \.xlsx/
    )
    await expect(readTable(Buffer.alloc(0), 'x.csv')).rejects.toThrow(/empty/)
    await expect(readTable(Buffer.alloc(5 * 1024 * 1024 + 1, 0x41), 'x.csv')).rejects.toThrow(
      /5 MB/
    )
  })

  it('reads a UTF-8 file that starts with a byte-order mark', async () => {
    const t = await readTable(Buffer.from('﻿Date,Name,Amount\n2026-07-01,X,1\n'), 'x.csv')
    expect(t.headers[0]).toBe('Date')
  })
})
