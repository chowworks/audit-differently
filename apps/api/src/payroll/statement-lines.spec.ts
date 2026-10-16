import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { amountPattern, itemsOf, linesOf, linesWithAmount, readStatement } from './statement-lines'

/** Finding a payroll item's line on a bank statement: its text layer read by pdf.js, never OCR. */
const fixture = (name: string) =>
  readFileSync(join(__dirname, '../../test/fixtures/statements', name))

describe('amountPattern', () => {
  it.each(['1,234.56', '1234.56', '-1,234.56', '-$1,234.56', '($1234.56)', 'USD 1,234.56'])(
    'finds 1234.56 written %s',
    (text) => expect(amountPattern(1234.56).test(`09/25 PAYROLL ${text}`)).toBe(true)
  )

  it.each(['11,234.56', '1,234.567', '234.56', '1,234.50'])(
    'does not take %s for 1234.56',
    (text) => expect(amountPattern(1234.56).test(`09/25 PAYROLL ${text}`)).toBe(false)
  )

  it('finds an amount under a thousand, and not inside a larger one', () => {
    expect(amountPattern(224).test('DIRECT DEPOSIT -224.00')).toBe(true)
    expect(amountPattern(224).test('BALANCE 12,224.00')).toBe(false)
  })
})

describe('linesOf', () => {
  it('merges the items on one baseline into one line, left to right, with one box', () => {
    const [line, ...rest] = linesOf(2, [
      { str: '-2,240.00', x: 400, y: 680, w: 45, h: 10 },
      { str: '09/25/2026', x: 50, y: 680.4, w: 50, h: 10 },
      { str: 'PAYPEOPLE PAYROLL', x: 130, y: 680, w: 100, h: 10 },
    ])
    expect(rest).toEqual([])
    expect(line).toEqual({
      page: 2,
      text: '09/25/2026 PAYPEOPLE PAYROLL -2,240.00',
      x: 48,
      y: 677,
      width: 399,
      height: 14.4,
    })
  })
})

describe('readStatement', () => {
  it('reads every line of a downloaded statement with its page and box, and finds the payroll line', async () => {
    const s = await readStatement(fixture('riverbend-2026-09-statement.pdf'))
    expect(s.pages).toBe(2)
    expect(s.scanned).toBe(false)
    expect(s.views).toEqual([
      [0, 0, 612, 792],
      [0, 0, 612, 792],
    ])
    const found = linesWithAmount(s.lines, 2240)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      page: 2,
      text: '09/25/2026 PAYPEOPLE PAYROLL WEX 0925 -2,240.00 12,240.00',
    })
    const box = found[0]!
    // The box covers the line's baseline at y 680, from the date at x 50 to past the balance.
    expect(box.x).toBeLessThan(50)
    expect(box.y).toBeLessThan(680)
    expect(box.y + box.height).toBeGreaterThan(680 + 6)
    expect(box.x + box.width).toBeGreaterThan(490)
    expect(linesWithAmount(s.lines, 224).map((l) => l.text)).toEqual([
      '09/25/2026 PAYPEOPLE DIRECT DEPOSIT 7741 -224.00 12,016.00',
    ])
    expect(linesWithAmount(s.lines, 9999.99)).toEqual([])
  })

  it('says a statement with no text layer is scanned, and finds nothing on it', async () => {
    const s = await readStatement(fixture('scanned-statement.pdf'))
    expect(s).toMatchObject({ pages: 1, scanned: true, lines: [] })
  })
})

describe('itemsOf', () => {
  it('keeps upright text and leaves out rotated or skewed text', () => {
    const items = itemsOf([
      { str: 'PAYROLL -2,240.00', transform: [10, 0, 0, 10, 50, 680], width: 90, height: 10 },
      { str: 'COPY', transform: [0, 10, -10, 0, 580, 300], width: 30, height: 10 },
      { str: 'DRAFT', transform: [7, 7, -7, 7, 200, 400], width: 40, height: 10 },
      { str: '   ', transform: [10, 0, 0, 10, 50, 600], width: 5, height: 10 },
    ])
    expect(items).toEqual([{ str: 'PAYROLL -2,240.00', x: 50, y: 680, w: 90, h: 10 }])
  })
})
