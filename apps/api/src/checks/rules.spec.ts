import { dueDate, runRules, type RuleExpense, type RuleMonth } from './rules'

const expense = (overrides: Partial<RuleExpense> = {}): RuleExpense => ({
  id: 'e1',
  itemNumber: 'T-1',
  date: '2026-07-10',
  vendor: 'Vendor A',
  totalCost: 100,
  allocatedAmount: 100,
  allocationType: 'direct',
  reportLine: 'program-costs',
  documents: ['invoice', 'payment'],
  ...overrides,
})

const month = (overrides: Partial<RuleMonth> = {}): RuleMonth => ({
  period: '2026-07',
  contractStart: '2026-07-01',
  contractEnd: '2027-06-30',
  dueDay: 12,
  budget: { 'program-costs': 1000, wex: 500, indirect: 0 },
  previouslyBilled: {},
  expenses: [expense()],
  ...overrides,
})

const codes = (m: RuleMonth) => runRules(m).map((f) => f.code)

describe('runRules', () => {
  it('passes a complete direct expense', () => {
    expect(runRules(month())).toEqual([])
  })

  it('blocks a non-payroll expense without an invoice or proof of payment', () => {
    expect(codes(month({ expenses: [expense({ documents: [] })] }))).toEqual([
      'missing-invoice',
      'missing-proof-of-payment',
    ])
  })

  it('wants a timesheet and a register on payroll lines, not an invoice', () => {
    const found = codes(
      month({ expenses: [expense({ reportLine: 'wex', documents: ['payment'] })] })
    )
    expect(found).toEqual(['missing-timesheet', 'missing-register'])
  })

  it('wants the calculation on an allocated expense and refuses a share above the total', () => {
    const found = codes(
      month({
        expenses: [expense({ allocationType: 'payroll', totalCost: 100, allocatedAmount: 120 })],
      })
    )
    expect(found).toEqual(['missing-allocation', 'allocation-exceeds-total'])
  })

  it('flags dates outside the contract, and far from the month as attention', () => {
    expect(codes(month({ expenses: [expense({ date: '2026-06-30' })] }))).toEqual([
      'date-outside-contract',
    ])
    expect(
      codes(
        month({
          period: '2026-10',
          expenses: [expense({ date: '2026-07-10' })],
        })
      )
    ).toEqual(['date-far-from-period'])
  })

  it('notices an overhead line on program costs when indirect is not budgeted', () => {
    const found = runRules(month({ expenses: [expense({ memo: '10% General & Administrative' })] }))
    expect(found.map((f) => f.code)).toEqual(['indirect-as-direct'])
    expect(found[0].severity).toBe('attention')
  })

  it('reports a budget overrun once per line', () => {
    const found = runRules(
      month({
        previouslyBilled: { 'program-costs': 950 },
        expenses: [expense({ allocatedAmount: 60, totalCost: 60 })],
      })
    )
    expect(found).toEqual([
      expect.objectContaining({
        code: 'budget-overrun',
        message: expect.stringContaining('$10.00'),
      }),
    ])
  })

  it('flags a duplicate against this month and earlier months', () => {
    const found = codes(
      month({
        expenses: [expense({ id: 'e1' }), expense({ id: 'e2', itemNumber: 'T-2' })],
        earlierExpenses: [{ id: 'old', vendor: 'vendor a ', totalCost: 100, date: '2026-07-10' }],
      })
    )
    expect(found).toEqual(['duplicate-item', 'duplicate-item'])
  })

  it('wants the eligibility file of anyone paid this month, softer with a self-attestation', () => {
    const paid = (items: string[]) => ({
      id: 'p1',
      participantId: '546001',
      displayName: 'Sam Example',
      eligibilityItems: items as never,
      paidThisMonth: true,
    })
    const complete = [
      'enrollment-form',
      'proof-of-age',
      'right-to-work',
      'school-status',
      'income-eligibility',
    ]
    expect(codes(month({ participants: [paid(complete)] }))).toEqual([])
    expect(codes(month({ participants: [{ ...paid([]), paidThisMonth: false }] }))).toEqual([])
    const found = runRules(month({ participants: [paid(['enrollment-form', 'proof-of-age'])] }))
    expect(found).toEqual([
      expect.objectContaining({
        code: 'participant-file-incomplete',
        severity: 'attention',
        participantId: 'p1',
        message: expect.stringContaining('right-to-work, school-status, income-eligibility'),
      }),
    ])
    expect(runRules(month({ participants: [paid(['self-attestation'])] }))[0].severity).toBe('info')
  })

  it('computes the due date and notes a late submission', () => {
    expect(dueDate('2026-07', 12).toISOString()).toBe('2026-08-12T23:59:59.000Z')
    expect(codes(month({ submittedAt: '2026-08-13T09:00:00Z' }))).toEqual(['late-submission'])
    expect(codes(month({ submittedAt: '2026-08-12T09:00:00Z' }))).toEqual([])
  })
})
