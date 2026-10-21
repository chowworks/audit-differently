import type { StatementLine } from '@ad/types'
import { linkCovers, MAX_PAY_LINES, overPayLineCap, payLinesOf, sameLine } from './pay-lines'

/** Lines as statement-lines.ts reads them, one under the other. Fictional people and pay. */
const lines = (...texts: string[]): StatementLine[] =>
  texts.map((text, i) => ({ page: 1, text, x: 50, y: 700 - i * 15, width: 300, height: 12 }))

describe('payLinesOf', () => {
  it('reads the first MAX_PAY_LINES rows of a file and flags one with more, never cutting it short in silence', () => {
    const rows = (n: number) =>
      lines(...Array.from({ length: n }, (_, i) => `Person Number${i} 10.00`))
    const full = { kind: 'payroll-register', lines: rows(MAX_PAY_LINES) }
    const over = { kind: 'payroll-register', lines: rows(MAX_PAY_LINES + 1) }
    expect(payLinesOf(full)).toHaveLength(MAX_PAY_LINES)
    expect(overPayLineCap(full)).toBe(false)
    expect(payLinesOf(over)).toHaveLength(MAX_PAY_LINES)
    expect(overPayLineCap(over)).toBe(true)
  })

  it("takes every person's row of a register, never its headings or totals", () => {
    const register = lines(
      'Payroll register Pay period 09/07/2026 - 09/20/2026',
      'Employee Hours Gross',
      'Jordan Sample 20.00 280.00',
      'Casey Demo 25.00 312.50',
      'Totals 45.00 592.50'
    )
    expect(payLinesOf({ kind: 'payroll-register', lines: register }).map((l) => l?.text)).toEqual([
      'Jordan Sample 20.00 280.00',
      'Casey Demo 25.00 312.50',
    ])
  })

  it("takes a bank statement's payments, never its balances or money coming in", () => {
    const bank = lines(
      'Beginning balance 09/01 10,000.00',
      '09/18 ACH PAYROLL RIVERBEND 1,234.56',
      '09/19 Direct deposit Jordan Sample 280.00',
      '09/20 Deposit from funder 5,000.00',
      '09/30 Ending balance 3,485.44'
    )
    expect(payLinesOf({ kind: 'bank-statement', lines: bank }).map((l) => l?.text)).toEqual([
      '09/18 ACH PAYROLL RIVERBEND 1,234.56',
      '09/19 Direct deposit Jordan Sample 280.00',
    ])
  })

  it('takes one pay per pay stub, its net pay first, and the file itself when it was scanned', () => {
    const stub = lines(
      'Paid to: Jordan Sample',
      'Gross pay $280.00',
      'Net pay $251.30',
      'Year to date 1,120.00'
    )
    expect(payLinesOf({ kind: 'paystub', lines: stub }).map((l) => l?.text)).toEqual([
      'Net pay $251.30',
    ])
    expect(payLinesOf({ kind: 'paystub', lines: [] })).toEqual([null])
  })

  it('takes nothing from a timesheet: it pays nobody', () => {
    expect(payLinesOf({ kind: 'timesheet', lines: lines('Jordan Sample 20.00 hours') })).toEqual([])
  })
})

describe('sameLine and linkCovers', () => {
  const [row, next] = lines('Jordan Sample 20.00 280.00', 'Casey Demo 25.00 312.50')
  it('sees a highlight on the row as covering it, and the next row as not', () => {
    const amount = { page: 1, x: 300, y: row!.y + 1, width: 40, height: 10 }
    expect(sameLine(amount, row!)).toBe(true)
    expect(sameLine(amount, next!)).toBe(false)
    expect(sameLine({ ...amount, page: 2 }, row!)).toBe(false)
    expect(linkCovers({ mark: null, marks: [amount] }, 'payroll-register', row!)).toBe(true)
    expect(linkCovers({ mark: next, marks: [] }, 'payroll-register', row!)).toBe(false)
    // A pay stub is one pay: any link to it covers it.
    expect(linkCovers({ mark: null, marks: [] }, 'paystub', null)).toBe(true)
  })
})
