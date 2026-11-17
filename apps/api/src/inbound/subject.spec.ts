import { monthIn, readSubject } from './subject'

/** Issue #82: the subject's word says what the files are, and its month (else none). */
const NOV = new Date('2026-11-16T15:00:00Z')

describe('readSubject', () => {
  it('reads no word as a receipt with no month, as every email was before', () => {
    expect(readSubject('Staples order 4471', [], NOV)).toEqual({
      kind: 'receipt',
      period: null,
      problem: null,
    })
    expect(readSubject(null, [], NOV).kind).toBe('receipt')
  })

  it('reads each folder word, singular, plural and spaced', () => {
    expect(readSubject('Timesheets', [], NOV).kind).toBe('timesheet')
    expect(readSubject('fwd: timesheet', [], NOV).kind).toBe('timesheet')
    expect(readSubject('Payroll Register', [], NOV).kind).toBe('payroll-register')
    expect(readSubject('pay  stubs', [], NOV).kind).toBe('paystub')
    expect(readSubject('PNC bank statement', [], NOV).kind).toBe('bank-statement')
    expect(readSubject('QuickBooks export', [], NOV).kind).toBe('payroll-details')
    expect(readSubject('Invoice 12', [], NOV).kind).toBe('receipt')
  })

  it('reads the spellings of the same words people write', () => {
    for (const [subject, kind] of [
      ['Time Sheets Oct 2026', 'timesheet'],
      ['time sheet', 'timesheet'],
      ['Timecards', 'timesheet'],
      ['timecard', 'timesheet'],
      ['time cards October', 'timesheet'],
      ['Fwd: payroll registers', 'payroll-register'],
      ['registers', 'payroll-register'],
      ['Pay-Stubs', 'paystub'],
      ['pay-stub', 'paystub'],
      ['Pay Stub', 'paystub'],
      ['paystub', 'paystub'],
      ['statements', 'bank-statement'],
      ['Card statements', 'bank-statement'],
      ['Fwd: card statement Oct 2026', 'bank-statement'],
      ['QuickBooks export', 'payroll-details'],
      ['receipts', 'receipt'],
      ['invoices', 'receipt'],
    ] as const)
      expect([subject, readSubject(subject, [], NOV).kind]).toEqual([subject, kind])
  })

  it("keeps a forwarded bill's own subject a receipt, with no month and nothing to ask", () => {
    for (const subject of [
      'Fwd: Your Verizon statement is ready',
      'Fwd: Books order #123',
      'Your invoice from Acme',
      'Fwd: Register for our October webinar',
      'Your receipt from Bright Path Office Supply',
      'Fwd: Your statement for October 2026 is ready',
      'Re: lunch order',
    ])
      expect([subject, readSubject(subject, [], NOV)]).toEqual([
        subject,
        { kind: 'receipt', period: null, problem: null },
      ])
  })

  it('leaves payroll words that name no folder for a person, never a receipt', () => {
    for (const subject of ['Payroll October', 'Fwd: stubs', 'stub', 'W-2s', 'W-2', 'w2 forms'])
      expect([subject, readSubject(subject, [], NOV).problem]).toEqual([
        subject,
        'The subject names payroll files but not which folder',
      ])
    // A folder word beside it says where: no question.
    expect(readSubject('Payroll register October', [], NOV)).toEqual({
      kind: 'payroll-register',
      period: '2026-10',
      problem: null,
    })
    expect(readSubject('payroll receipt', [], NOV).problem).toBeNull()
  })

  it('takes whole words only', () => {
    expect(readSubject('Timesheetsx', [], NOV).kind).toBe('receipt')
    expect(readSubject('mybooks', [], NOV).kind).toBe('receipt')
  })

  it('leaves two kinds for a person', () => {
    expect(readSubject('timesheets and receipts', [], NOV).problem).toMatch(/more than one kind/)
  })

  it('reads the month in its usual spellings', () => {
    expect(readSubject('timesheets 2026-10', [], NOV).period).toBe('2026-10')
    expect(readSubject('timesheets 10/2026', [], NOV).period).toBe('2026-10')
    expect(readSubject('Timesheets October', [], NOV).period).toBe('2026-10')
    expect(readSubject('timesheets October, 2025', [], NOV).period).toBe('2025-10')
    expect(readSubject('timesheets Oct 2026', [], NOV).period).toBe('2026-10')
    expect(readSubject('timesheets Sept. 2026', [], NOV).period).toBe('2026-09')
  })

  it('takes a month with no year as the latest not after this month', () => {
    expect(readSubject('statements December', [], NOV).period).toBe('2025-12')
    expect(readSubject('statements November', [], NOV).period).toBe('2026-11')
  })

  it('never reads "may", or a short month without a year, as a month', () => {
    expect(readSubject('receipt, may be late', [], NOV).period).toBeNull()
    expect(readSubject('receipt for the dec', [], NOV).period).toBeNull()
    expect(readSubject('timesheets May 2026', [], NOV).period).toBe('2026-05')
  })

  it('leaves two months for a person', () => {
    expect(readSubject('timesheets October November', [], NOV).problem).toMatch(
      /more than one month/
    )
  })

  it('takes the engagement codes out before reading months and words', () => {
    expect(readSubject('MAY-YOUTH receipt', ['MAY-YOUTH'], NOV)).toEqual({
      kind: 'receipt',
      period: null,
      problem: null,
    })
    expect(readSubject('OCT-2026 receipts', ['OCT-2026'], NOV).period).toBeNull()
  })
})

describe('monthIn', () => {
  it('is the East Coast month, not UTC', () => {
    expect(monthIn(new Date('2026-11-01T02:00:00Z'))).toBe('2026-10')
    expect(monthIn(new Date('2026-11-01T05:00:00Z'))).toBe('2026-11')
  })
})
