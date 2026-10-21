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
  budgetLineId: 'bl-supplies',
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
  budgetLines: [{ id: 'bl-supplies', name: 'Supplies', amount: 1000, previouslyBilled: 0 }],
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

  it('says when a payroll line typed on the month is pay the match counts too', () => {
    const [f] = runRules(
      month({ expenses: [expense({ countedTwice: 'participant pay' })] })
    ).filter((x) => x.code === 'payroll-counted-twice')
    expect(f).toMatchObject({ severity: 'attention', expenseId: 'e1' })
    expect(f!.message).toContain('already counts this participant pay on the month')
  })

  it('checks a line the payroll match wrote as payroll, whatever budget line it is on', () => {
    // Staff pay on Program Costs, as a contract that budgets staff there: a timesheet and a register, never an invoice.
    const found = codes(
      month({
        expenses: [expense({ fromPayroll: true, documents: ['payment'] })],
      })
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

  it('reports a budget overrun once per budget line, as the contract approved it', () => {
    const found = runRules(
      month({
        budgetLines: [{ id: 'bl-supplies', name: 'Supplies', amount: 1000, previouslyBilled: 950 }],
        expenses: [
          expense({ allocatedAmount: 30, totalCost: 30 }),
          expense({
            id: 'e2',
            itemNumber: 'T-2',
            allocatedAmount: 30,
            totalCost: 30,
            date: '2026-07-11',
          }),
        ],
      })
    )
    expect(found).toEqual([
      expect.objectContaining({
        code: 'budget-overrun',
        message: 'Supplies: spent $1010.00 to date, over the approved $1000.00 by $10.00.',
      }),
    ])
  })

  it('blocks an expense spent against no budget line', () => {
    const found = runRules(month({ expenses: [expense({ budgetLineId: null })] }))
    expect(found).toEqual([
      expect.objectContaining({
        code: 'no-budget-line',
        severity: 'blocker',
        expenseId: 'e1',
        message: expect.stringContaining('choose the budget line it is spent against'),
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

  describe("a participant's pay", () => {
    // Fictional: the sample's September pay for Jordan Sample.
    const proof = (purpose: string, kind: string, words: string[] = []) =>
      ({ purpose, kind, words }) as never
    const pay = (proofs: never[]) => ({
      id: 'w1',
      label: 'Jordan Sample, 2026-09-07 to 2026-09-20',
      grossAmount: 280,
      start: '2026-09-07',
      end: '2026-09-20',
      proofs,
    })
    const highlights = {
      paystub: ['name', 'payPeriod', 'amount'],
      timesheet: ['row', 'name', 'payPeriod'],
      'payroll-register': ['payPeriod', 'payDate', 'amount'],
    } as never

    it('needs a timesheet, a register and a pay stub, like a staff payroll line', () => {
      const found = runRules(month({ wexPayments: [pay([])] }))
      expect(found.map((f) => [f.code, f.severity, f.wexPaymentId])).toEqual([
        ['missing-timesheet', 'blocker', 'w1'],
        ['missing-register', 'blocker', 'w1'],
        ['missing-proof-of-payment', 'blocker', 'w1'],
      ])
      expect(found[2]!.message).toBe(
        'Jordan Sample, 2026-09-07 to 2026-09-20 ($280.00): no pay stub or deposit advice attached.'
      )
    })

    it('passes proofs whose highlighted words show its pay and pay period', () => {
      const all = [
        proof('timesheet', 'timesheet', ['Jordan Sample | 09/07/2026 | 09/20/2026 | $280.00']),
        proof('register', 'payroll-register', ['09/07/2026', '09/20/2026']),
        proof('payment', 'paystub', ['Jordan', 'Sample', '09/07/2026', '09/20/2026', '$280.00']),
      ]
      expect(codes(month({ wexPayments: [pay(all)], highlights }))).toEqual([])
    })

    it('says when a highlighted proof does not show the pay or the pay period', () => {
      const found = runRules(
        month({
          wexPayments: [
            pay([
              proof('timesheet', 'timesheet', ['Jordan Sample | 09/07/2026 | 09/20/2026']),
              proof('register', 'payroll-register', ['09/21/2026']),
              proof('payment', 'paystub', [
                'Jordan',
                'Sample',
                '09/07/2026',
                '09/20/2026',
                '$300.00',
              ]),
            ]),
          ],
          highlights,
        })
      )
      expect(found.map((f) => [f.code, f.severity])).toEqual([
        ['proof-mismatch', 'attention'],
        ['proof-mismatch', 'attention'],
      ])
      expect(found.map((f) => f.message)).toEqual([
        "Jordan Sample, 2026-09-07 to 2026-09-20 ($280.00): the pay period was not found on its payroll register. Check the proof is this payment's.",
        "Jordan Sample, 2026-09-07 to 2026-09-20 ($280.00): $280.00 was not found on its pay stub. Check the proof is this payment's.",
      ])
    })

    it('reads only what the platform highlights, and nothing on a proof attached without highlights', () => {
      const bare = [
        proof('timesheet', 'timesheet'),
        proof('register', 'payroll-register'),
        proof('payment', 'paystub'),
      ]
      expect(codes(month({ wexPayments: [pay(bare)], highlights }))).toEqual([])
      const stub = [
        proof('timesheet', 'timesheet'),
        proof('register', 'payroll-register'),
        proof('payment', 'paystub', ['Jordan']),
      ]
      expect(
        codes(month({ wexPayments: [pay(stub)], highlights: { paystub: ['name'] } as never }))
      ).toEqual([])
    })
  })

  it("says when a staff line's bank line does not show its amount", () => {
    const line = expense({
      reportLine: 'staff-salaries',
      totalCost: 724.02,
      allocatedAmount: 724.02,
      documents: ['timesheet', 'register', 'payment'],
      proofs: [{ purpose: 'payment', kind: 'bank-statement', words: ['09/22', '712.00'] }],
    })
    expect(
      codes(month({ expenses: [line], highlights: { 'bank-statement': ['date', 'amount'] } }))
    ).toContain('proof-mismatch')
  })

  it("passes a staff line's bank line only when it shows its amount or is the debit of the run that paid it", () => {
    const line = (proof: { words: string[]; payRun?: boolean }) =>
      expense({
        reportLine: 'staff-salaries',
        totalCost: 2100,
        allocatedAmount: 2100,
        documents: ['timesheet', 'register', 'payment'],
        proofs: [{ purpose: 'payment', kind: 'bank-statement', ...proof }],
      })
    const found = (proof: { words: string[]; payRun?: boolean }) =>
      codes(
        month({ expenses: [line(proof)], highlights: { 'bank-statement': ['date', 'amount'] } })
      )
    // The pay run's one debit, matched to the run that paid it: its total is not the line's, and that is right.
    expect(found({ words: ['09/24', '$6,339.17'], payRun: true })).not.toContain('proof-mismatch')
    // The same larger amount, not matched as the run's debit, is no proof of this line's.
    expect(found({ words: ['09/24', '$6,339.17'] })).toContain('proof-mismatch')
    expect(found({ words: ['09/24', '$2,100.00'] })).not.toContain('proof-mismatch')
  })

  it('computes the due date and notes a late submission', () => {
    expect(dueDate('2026-07', 12).toISOString()).toBe('2026-08-12T23:59:59.000Z')
    expect(codes(month({ submittedAt: '2026-08-13T09:00:00Z' }))).toEqual(['late-submission'])
    expect(codes(month({ submittedAt: '2026-08-12T09:00:00Z' }))).toEqual([])
  })
})
