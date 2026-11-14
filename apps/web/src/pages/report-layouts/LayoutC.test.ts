import { describe, expect, it } from 'vitest'
import type { CheckDto, ReportDetail } from '@ad/types'
import { placeChecks, tablesOfLine } from './LayoutC'
import { proofsShown } from './proof-rows'

const check = (id: string, on: Partial<CheckDto>): CheckDto => ({
  id,
  code: 'missing-proof' as CheckDto['code'],
  severity: 'blocker',
  source: 'rule' as CheckDto['source'],
  message: `Check ${id}`,
  status: 'open' as CheckDto['status'],
  expenseId: null,
  participantId: null,
  wexPaymentId: null,
  ...on,
})

const month = (seeStaffPayroll: boolean | undefined) =>
  ({
    expenses: [
      { id: 'supplies', reportLine: 'supplies' },
      { id: 'salary', reportLine: 'staff-salaries' },
    ],
    wexPayments: [{ id: 'wex', participantId: 'p1' }],
    budgetLines: [],
    checks: [
      check('on-supplies', { expenseId: 'supplies' }),
      check('on-salary', { expenseId: 'salary' }),
      check('on-wex', { wexPaymentId: 'wex' }),
      check('on-participant', { participantId: 'p1' }),
      check('whole-month', {}),
    ],
    can: { seeStaffPayroll },
  }) as unknown as ReportDetail

const ids = (r: ReportDetail) => placeChecks(r).loose.map((k) => k.id)

describe('the checks on the whole month', () => {
  // "Bookkeepers see staff payroll" off still shows the payroll rows (as labels), so their checks stay on them.
  it('leaves row checks on their rows, whether the payroll files show or not', () => {
    expect(ids(month(true))).toEqual(['whole-month'])
    expect(ids(month(undefined))).toEqual(['whole-month'])
    expect(ids(month(false))).toEqual(['whole-month'])
  })
})

describe('proofsShown', () => {
  const doc = (id: string, purpose: string, kind: string) =>
    ({ purpose, document: { id, kind } }) as never as {
      purpose: 'payment' | 'timesheet' | 'register'
      document: { id: string; kind: string }
    }

  it('shows the pay stub as evidence of payment, whichever order the proofs come in, and the bank debit beside it', () => {
    const bank = doc('b', 'payment', 'bank-statement')
    const stub = doc('s', 'payment', 'paystub')
    const time = doc('t', 'timesheet', 'timesheet')
    for (const docs of [
      [bank, stub, time],
      [stub, bank, time],
    ]) {
      const got = proofsShown(['timesheet', 'register', 'payment'], docs)
      expect(got.have.get('payment')).toBe(stub)
      expect(got.have.get('timesheet')).toBe(time)
      expect(got.have.has('register')).toBe(false)
      expect(got.extra).toEqual([bank])
    }
  })

  it('shows a bank debit as evidence of payment when no pay stub is attached', () => {
    const bank = doc('b', 'payment', 'bank-statement')
    expect(proofsShown(['payment'], [bank])).toEqual({
      have: new Map([['payment', bank]]),
      extra: [],
    })
  })
})

describe("a budget line's filter", () => {
  const r = {
    budgetLines: [
      { id: 'fringe', reportLine: 'staff-fringe' },
      { id: 'salaries', reportLine: 'staff-salaries' },
      { id: 'supplies', reportLine: 'supplies' },
    ],
    expenses: [
      { id: 'tax', reportLine: 'staff-fringe', budgetLineId: 'fringe', fromPayroll: true },
      { id: 'fee', reportLine: 'staff-fringe', budgetLineId: 'fringe', fromBooks: true },
      { id: 'pay', reportLine: 'staff-salaries', budgetLineId: 'salaries', fromPayroll: true },
    ],
  } as unknown as ReportDetail

  it("filters the expenses too when a payroll line has the books' expenses on it", () => {
    expect(tablesOfLine(r, 'fringe')).toEqual({ payroll: true, expenses: true })
  })

  it('filters only its own table otherwise', () => {
    expect(tablesOfLine(r, 'salaries')).toEqual({ payroll: true, expenses: false })
    expect(tablesOfLine(r, 'supplies')).toEqual({ payroll: false, expenses: true })
  })
})
