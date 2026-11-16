import { describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { readWorkbook, serialDate } from './xlsx'

/** A small workbook as a spreadsheet program writes one: two sheets, shared strings, a date, a yellow fill, bold. */
function workbook() {
  return zipSync({
    'xl/workbook.xml': strToU8(
      `<workbook><bookViews><workbookView activeTab="1"/></bookViews><sheets>` +
        `<sheet name="Note" sheetId="1" r:id="rId1"/><sheet name="Hidden" sheetId="3" state="hidden" r:id="rId3"/>` +
        `<sheet name="Transactions &amp; splits" sheetId="2" r:id="rId2"/></sheets></workbook>`
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/>` +
        `<Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/><Relationship Id="rId3" Target="worksheets/sheet3.xml"/></Relationships>`
    ),
    'xl/sharedStrings.xml': strToU8(
      `<sst><si><t>Date</t></si><si><r><t>Ven</t></r><r><t xml:space="preserve">dor &lt;A&gt;</t></r></si><si><t>Class</t></si></sst>`
    ),
    'xl/styles.xml': strToU8(
      `<styleSheet><numFmts><numFmt numFmtId="164" formatCode="mm/dd/yyyy"/></numFmts>` +
        `<fonts><font><sz val="11"/></font><font><b/></font></fonts>` +
        `<fills><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>` +
        `<fill><patternFill patternType="solid"><fgColor rgb="FFFFF176"/></patternFill></fill></fills>` +
        `<cellXfs><xf numFmtId="0" fontId="0" fillId="0"/><xf numFmtId="164" fontId="0" fillId="0"/>` +
        `<xf numFmtId="0" fontId="0" fillId="2"/><xf numFmtId="0" fontId="1" fillId="0"/></cellXfs></styleSheet>`
    ),
    'xl/worksheets/sheet1.xml': strToU8(
      `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>How the books charge this</t></is></c></row></sheetData></worksheet>`
    ),
    'xl/worksheets/sheet2.xml': strToU8(
      `<worksheet><sheetData>` +
        `<row r="1"><c r="A1" t="s" s="3"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="s"><v>2</v></c></row>` +
        `<row r="3"><c r="A3" s="1"><v>46296</v></c><c r="B3" s="2" t="str"><v>Rent</v></c><c r="C3" s="2"><v>302.98</v></c></row>` +
        `</sheetData></worksheet>`
    ),
    'xl/worksheets/sheet3.xml': strToU8(`<worksheet><sheetData/></worksheet>`),
  })
}

describe('readWorkbook', () => {
  it('reads the visible sheets in order, opening at the active one', () => {
    const book = readWorkbook(workbook())
    expect(book.sheets.map((s) => s.name)).toEqual(['Note', 'Transactions & splits'])
    expect(book.sheets[0]!.rows).toEqual([['How the books charge this']])
  })

  it('places cells by their reference, with shared strings, dates, fills and bold', () => {
    const sheet = readWorkbook(workbook()).sheets[1]!
    expect(sheet.rows).toEqual([
      ['Date', 'Vendor <A>', '', 'Class'],
      ['', '', '', ''],
      ['10/01/2026', 'Rent', '302.98', ''],
    ])
    expect([...sheet.filled]).toEqual(['2:1', '2:2'])
    expect([...sheet.bold]).toEqual(['0:0'])
  })

  it('refuses a zip that is not a workbook', () => {
    expect(() => readWorkbook(zipSync({ 'a.txt': strToU8('x') }))).toThrow(/not a spreadsheet/)
  })
})

describe('serialDate', () => {
  it('turns an Excel serial into MM/DD/YYYY', () => {
    expect(serialDate(46296)).toBe('10/01/2026')
    expect(serialDate(45658.75)).toBe('01/01/2025')
  })
})
