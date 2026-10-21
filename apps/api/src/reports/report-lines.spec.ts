import {
  countedTwice,
  countsOnBudget,
  holdsPayroll,
  participantPaySpend,
  payrollCovers,
  payrollRowKind,
} from './report-lines'

describe("the books' payroll transactions on the budget", () => {
  const wex = {
    payrollRow: true,
    account: '63103 Payroll Expenses:Salaries - Work Experience (WEX)',
  }
  const wexTaxes = {
    payrollRow: true,
    account: '63203 Payroll Expenses:Payroll Taxes:Work Experience (WEX) - Taxes',
  }
  const staff = { payrollRow: true, account: '63102 Payroll Expenses:Salaries - Employees' }
  const staffTaxes = {
    payrollRow: true,
    account: '63202 Payroll Expenses:Payroll Taxes:Employees - Taxes',
  }

  it('tells each kind from its account, as the import stores it', () => {
    expect([wex, wexTaxes, staff, staffTaxes].map(payrollRowKind)).toEqual([
      'participantPay',
      'participantTaxes',
      'staffPay',
      'staffTaxes',
    ])
  })

  it('counts until the match covers that kind on the month, then keeps it for reconciliation', () => {
    const covers = payrollCovers(
      [
        { monthlyReportId: 'r-sep', payrollKey: 'staff:s-1:2026-09-20:pay' },
        { monthlyReportId: 'r-sep', payrollKey: null },
      ],
      new Map([['r-sep', 3]]),
      () => true
    )
    const sep = covers.get('r-sep')
    // The participants' payments and the staff pay are the match's; their taxes are not covered yet.
    const kind = (k: string) => ({ payrollKind: k })
    expect(countsOnBudget(kind('participant-pay'), sep)).toBe(false)
    expect(countsOnBudget(kind('staff-pay'), sep)).toBe(false)
    expect(countsOnBudget(kind('staff-taxes'), sep)).toBe(true)
    expect(countsOnBudget(kind('participant-taxes'), sep)).toBe(true)
    // A month the match has not covered: every books' payroll transaction counts.
    expect(countsOnBudget(kind('staff-pay'), covers.get('r-aug'))).toBe(true)
    // An ordinary line always counts.
    expect(countsOnBudget({ payrollKind: null }, sep)).toBe(true)
  })

  it("keeps the books' participant pay counting when no budget line holds the participants' pay", () => {
    const budget = [
      { id: 'b-wex', reportLine: 'participant-wages', payroll: ['participant-taxes'] },
    ]
    const sep = payrollCovers([], new Map([['r-sep', 3]]), () =>
      holdsPayroll(budget, 'participant-pay')
    ).get('r-sep')
    // The payments land on no line, so the books' row is still the spending: counted once, not zero times.
    expect(participantPaySpend(budget, 1200)).toEqual([])
    expect(countsOnBudget({ payrollKind: 'participant-pay' }, sep)).toBe(true)
    // Once a line holds it, the payments are the pay on that line and the books' row stops counting.
    const held = [{ ...budget[0]!, payroll: ['participant-pay', 'participant-taxes'] }]
    const covered = payrollCovers([], new Map([['r-sep', 3]]), () =>
      holdsPayroll(held, 'participant-pay')
    ).get('r-sep')
    expect(participantPaySpend(held, 1200)).toEqual([
      { budgetLineId: 'b-wex', reportLine: 'participant-wages', allocatedAmount: 1200 },
    ])
    expect(countsOnBudget({ payrollKind: 'participant-pay' }, covered)).toBe(false)
  })

  it('finds a payroll line typed on a month whose pay the match counts there too', () => {
    const cover = {
      staffPay: false,
      staffTaxes: false,
      participantPay: true,
      participantTaxes: false,
    }
    const typed = {
      payrollKey: null,
      payrollKind: null,
      account: '63103 Salaries - WEX',
      memo: 'Work experience wages',
    }
    expect(countedTwice(typed, cover)).toBe(true)
    // Staff pay the match has not written: not counted twice.
    expect(
      countedTwice(
        { ...typed, account: '60100 Salaries - Staff', memo: 'Coordinator wages' },
        cover
      )
    ).toBe(false)
    // Already kept for reconciliation, or the match's own line: never.
    expect(countedTwice({ ...typed, payrollKind: 'participant-pay' }, cover)).toBe(false)
    expect(countedTwice({ ...typed, payrollKey: 'participants:2026-09-20:taxes' }, cover)).toBe(
      false
    )
    expect(countedTwice({ ...typed, account: '60901 Rent Expense', memo: 'Rent' }, cover)).toBe(
      false
    )
  })
})
