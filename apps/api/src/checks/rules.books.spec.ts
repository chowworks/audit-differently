import { runRules, type RuleExpense, type RuleMonth } from './rules'

/** A fictional month with one line, as the rules read it. */
const expense = (overrides: Partial<RuleExpense> = {}): RuleExpense =>
  ({
    id: 'e1',
    itemNumber: 'QB-9005',
    date: '2026-09-30',
    vendor: 'PayPeople',
    totalCost: 200,
    allocatedAmount: 50,
    allocationType: 'books',
    allocationNote: '25.00% of $200.00',
    reportLine: 'staff-fringe',
    budgetLineId: 'bl-fringe',
    documents: [],
    ...overrides,
  }) as RuleExpense
const month = (expenses: RuleExpense[]): RuleMonth => ({
  period: '2026-09',
  contractStart: '2026-07-01',
  contractEnd: '2027-06-30',
  dueDay: 12,
  budget: { 'staff-fringe': 1000, indirect: 0 },
  previouslyBilled: {},
  budgetLines: [{ id: 'bl-fringe', name: 'Fringe', amount: 1000, previouslyBilled: 0 }],
  expenses,
})
const codes = (m: RuleMonth) => runRules(m).map((f) => f.code)

describe("a line from the books' expenses (owner's decision, 2026-11-09)", () => {
  it('is a bill on a payroll line of the form: an invoice and a payment, never a timesheet', () => {
    // A payroll company's fee on Fringe is no one's pay.
    expect(codes(month([expense({ fromBooks: true })]))).toEqual([
      'missing-invoice',
      'missing-proof-of-payment',
      'missing-allocation',
    ])
    const shown = runRules(month([expense({ fromBooks: true })])).find(
      (f) => f.code === 'missing-allocation'
    )
    expect(shown!.message).toContain('allocated as the books share it but no calculation attached')
  })

  it('leaves a line on the same budget line that is not from the books a payroll line', () => {
    expect(codes(month([expense({ allocationType: 'direct', allocatedAmount: 200 })]))).toEqual([
      'missing-timesheet',
      'missing-register',
      'missing-proof-of-payment',
    ])
  })
})
