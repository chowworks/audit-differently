import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { markPdf, markPlace } from './mark-pdf'
import { readStatement } from './statement-lines'
import { encryptedPdf } from './testing'

/** The audit package's copy of a statement with its marked lines highlighted; the original bytes never change. */
const fixture = () =>
  readFileSync(join(__dirname, '../../test/fixtures/statements/riverbend-2026-09-statement.pdf'))

const MARK = { page: 1, x: 48, y: 677.4, width: 520, height: 14 }

describe('markPdf', () => {
  it('draws the boxes on a copy that is still a valid PDF with the same pages and text', async () => {
    const original = fixture()
    const before = Buffer.from(original)
    const offPage = { page: 9, x: 0, y: 0, width: 1, height: 1 }
    const out = await markPdf(new Uint8Array(original), [
      { page: 2, x: 48, y: 677, width: 520, height: 14 },
      offPage,
    ])
    expect(original.equals(before)).toBe(true)
    expect(out.notDrawn).toEqual([offPage])
    expect(Buffer.from(out.bytes).equals(original)).toBe(false)
    expect(Buffer.from(out.bytes).subarray(0, 5).toString()).toBe('%PDF-')
    const copy = await PDFDocument.load(out.bytes)
    expect(copy.getPageCount()).toBe(2)
    const text = await readStatement(Buffer.from(out.bytes))
    expect(text.lines.some((l) => l.text.includes('-2,240.00'))).toBe(true)
  })

  it('draws nothing on an encrypted statement and says every mark was not drawn', async () => {
    const encrypted = await encryptedPdf()
    const out = await markPdf(encrypted, [MARK])
    expect(out.notDrawn).toEqual([MARK])
    expect(Buffer.from(out.bytes).equals(Buffer.from(encrypted))).toBe(true)
  })

  it('gives a damaged file back as it is, with every mark not drawn', async () => {
    const junk = new TextEncoder().encode('not a pdf at all')
    const out = await markPdf(junk, [MARK])
    expect(out).toEqual({ bytes: junk, notDrawn: [MARK] })
  })

  it('says where a mark sits in whole points', () => {
    expect(markPlace(MARK)).toBe('page 1, at 48, 677')
  })
})
