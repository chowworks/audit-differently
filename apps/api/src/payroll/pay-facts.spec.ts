import type { StatementLine } from '@ad/types'
import { payFactsOf } from './pay-facts'

const line = (text: string): StatementLine => ({
  page: 1,
  x: 0,
  y: 0,
  width: 100,
  height: 10,
  text,
})

describe('payFactsOf: a pay’s amount, date and payee', () => {
  it("takes a pay stub's net pay, pay period end and printed name from its reading", () => {
    expect(
      payFactsOf({
        kind: 'paystub',
        line: line('Net Pay 241.30'),
        period: '2026-09',
        stub: {
          reading: {
            start: '2026-09-07',
            end: '2026-09-20',
            payDate: '2026-09-25',
            gross: 280,
            net: 241.3,
            payLine: null,
            grossUnclear: false,
          },
          named: 'Jordan Sample',
        },
      })
    ).toEqual({ amount: 241.3, payDate: '2026-09-20', payee: 'Jordan Sample' })
  })

  it("takes a register row's net by its heading, its run's pay date and the person it names", () => {
    expect(
      payFactsOf({
        kind: 'payroll-register',
        line: line('Lee, Morgan 40.00 1,200.00 1,000.00'),
        period: '2026-09',
        fileLines: [line('Employee Hours Gross Net'), line('Lee, Morgan 40.00 1,200.00 1,000.00')],
        run: { payDate: '2026-09-11', end: '2026-09-06' },
      })
    ).toEqual({ amount: 1000, payDate: '2026-09-11', payee: 'Morgan Lee' })
  })

  it("takes a bank line's one amount and its date in the month's year", () => {
    expect(
      payFactsOf({
        kind: 'bank-statement',
        line: line('09/11 ACH PAYPEOPLE PAYROLL 258.58'),
        period: '2026-09',
      })
    ).toEqual({ amount: 258.58, payDate: '2026-09-11', payee: null })
  })

  it('never guesses: several amounts on a bank line, or a kept stub line with no reading, give what is certain only', () => {
    expect(
      payFactsOf({
        kind: 'bank-statement',
        line: line('09/11 PAYROLL 258.58 9,120.44'),
        period: '2026-09',
      })
    ).toEqual({ amount: null, payDate: '2026-09-11', payee: null })
    expect(
      payFactsOf({ kind: 'paystub', line: line('Net Pay 241.30'), period: '2026-09' })
    ).toEqual({
      amount: 241.3,
      payDate: null,
      payee: null,
    })
    expect(payFactsOf({ kind: 'paystub', line: null, period: '2026-09' })).toEqual({
      amount: null,
      payDate: null,
      payee: null,
    })
  })
})
