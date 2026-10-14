import { describe, expect, it } from 'vitest'
import { csvCell, toCsv } from './ActivityModal'

describe('the access log CSV', () => {
  it('opens a cell that looks like a formula as text', () => {
    for (const bad of ['=HYPERLINK("x")', '+1', '-1+2', '@SUM(A1)', '\tx', '\rx'])
      expect(csvCell(bad)).toBe(`"'${bad.replace(/"/g, '""')}"`)
  })

  it('quotes every cell and doubles its quotes, and leaves ordinary text alone', () => {
    expect(csvCell('Changed the role of pat@example.org')).toBe(
      '"Changed the role of pat@example.org"'
    )
    expect(csvCell('Said "yes"')).toBe('"Said ""yes"""')
    expect(csvCell(null)).toBe('""')
    expect(
      toCsv([
        ['Who (email)', 'Did'],
        ['pat@example.org', '=1+1'],
      ])
    ).toBe('"Who (email)","Did"\r\n"pat@example.org","\'=1+1"')
  })
})
