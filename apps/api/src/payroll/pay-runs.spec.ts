import { DEFAULT_PAYROLL_READING, type StatementLine } from '@ad/types'
import { payDateOn, payRunsOf, periodOn, runOfFile, runOfLine, suggestedRuns } from './pay-runs'
import { PayrollReadingService, readingChanges } from './payroll-reading.service'
import { anyOf, putReadingInForce } from './reading'
import { readStub, stubName } from './staff-match'

/** Lines as statement-lines.ts reads them, one under the other. Fictional people and pay. */
const lines = (...texts: string[]): StatementLine[] =>
  texts.map((text, i) => ({ page: 1, text, x: 50, y: 700 - i * 15, width: 300, height: 12 }))
const file = (id: string, kind: string, texts: string[]) => ({
  id,
  kind,
  fileName: `${id}.pdf`,
  lines: lines(...texts),
})

afterEach(() => putReadingInForce(DEFAULT_PAYROLL_READING))

describe("the admin's reading words (Admin tools → Payroll reading)", () => {
  it('reads a pay date by the label the admin adds, and no longer by one they take away', () => {
    const register = lines(
      'Payroll register',
      'Disbursement date 09/25/2026',
      'Pay date 09/24/2026'
    )
    expect(payDateOn(register)).toBe('2026-09-24')
    putReadingInForce({ ...DEFAULT_PAYROLL_READING, payDateLabels: ['disbursement date'] })
    expect(payDateOn(register)).toBe('2026-09-25')
  })

  it('reads a pay period by the word the admin gives', () => {
    const sheet = file('t', 'timesheet', ['Time report', 'Covering 09/07/2026 to 09/20/2026'])
    expect(periodOn(sheet)).toBeNull()
    putReadingInForce({ ...DEFAULT_PAYROLL_READING, periodLabels: ['covering'] })
    expect(periodOn(sheet)).toEqual({
      start: '2026-09-07',
      end: '2026-09-20',
    })
  })

  it("finds a register's debit by the admin's total label, within the admin's days", () => {
    const files = [
      file('r', 'payroll-register', ['Pay date 09/25/2026', 'Amount funded 1,640.22']),
      file('b', 'bank-statement', ['09/20 ACH PAYROLL 1,640.22']),
    ]
    expect(payRunsOf(files)[0]!.debit).toBeNull()
    putReadingInForce({ ...DEFAULT_PAYROLL_READING, debitTotalLabels: ['amount funded'] })
    expect(payRunsOf(files)[0]!.debit?.amount).toBe(1640.22)
    putReadingInForce({
      ...DEFAULT_PAYROLL_READING,
      debitTotalLabels: ['amount funded'],
      debitDaysFromPayDate: 3,
    })
    expect(payRunsOf(files)[0]!.debit).toBeNull()
  })

  it("reads a pay stub's gross by the admin's label", () => {
    const stub = lines('Pay period 09/07/2026 - 09/20/2026', 'Wages earned 280.00')
    expect(readStub(stub).gross).toBeNull()
    putReadingInForce({ ...DEFAULT_PAYROLL_READING, grossLabels: ['wages earned'] })
    expect(readStub(stub).gross).toBe(280)
  })

  it('reads a word with marks in it as written, never as a pattern', () => {
    expect(new RegExp(anyOf(['net pay (current)']), 'i').test('Net pay (current) 258.58')).toBe(
      true
    )
    expect(new RegExp(anyOf(['a.b']), 'i').test('axb')).toBe(false)
  })

  it('says what a save changed, in words, for the history', () => {
    expect(
      readingChanges(DEFAULT_PAYROLL_READING, {
        ...DEFAULT_PAYROLL_READING,
        payDateLabels: ['pay date', 'disbursement date'],
        netLabels: ['take home'],
        debitDaysFromPayDate: 3,
      })
    ).toEqual([
      'Pay date labels: added "disbursement date"; removed "check date"',
      'Net pay labels: added "take home"; removed "net pay"',
      'Bank debit near the pay date: 7 → 3 days',
    ])
    expect(readingChanges(DEFAULT_PAYROLL_READING, DEFAULT_PAYROLL_READING)).toEqual(['No change'])
  })

  it('refuses a save with an empty list or a day out of range, every problem at once', () => {
    const { problems } = PayrollReadingService.check({
      ...DEFAULT_PAYROLL_READING,
      payDateLabels: [],
      netLabels: ['net pay', '((('],
      debitDaysFromPayDate: 90,
    })
    expect(problems.map((p) => p.field)).toEqual([
      'payDateLabels',
      'netLabels',
      'debitDaysFromPayDate',
    ])
  })
})

describe('a value printed under its label', () => {
  it('reads a pay stub whose labels sit on their own lines, the values a line or two under', () => {
    const stub = lines(
      'EARNINGS STATEMENT',
      'PAY PERIOD:',
      '12 Example Street',
      'Exampletown, DE 19700 01/11/2026 - 01/24/2026',
      '(Work address) PAY DATE:',
      '12 Example Street',
      '01/30/2026',
      'PAID TO:',
      'Jordan Q Sample',
      'SUMMARY CURRENT YTD',
      'Gross Pay 280.00 560.00'
    )
    expect(readStub(stub)).toMatchObject({
      start: '2026-01-11',
      end: '2026-01-24',
      payDate: '2026-01-30',
      gross: 280,
    })
    expect(stubName(stub)).toBe('Jordan Q Sample')
  })

  it('never reads a pay period from a file name', () => {
    const sheet = {
      lines: lines('Time report', 'Jordan Sample 20.0 h'),
      fileName: '2026-01-11 2026-01-24.pdf',
    }
    expect(periodOn(sheet)).toBeNull()
  })
})

describe("a time report's pay period (January test, 2026-10-19)", () => {
  it('reads the from-to pair, not the pay date printed before it', () => {
    const report = file('t9', 'timesheet', [
      'Time & jobs report',
      'Employee Pay run Pay run check date Pay period Start date End date',
      'Morgan Lee Mar 16th - Mar 31st 2027: PEO 2027-04-02 Mar 16th - Mar 31st 2027 2027-03-16 2027-03-31',
      'Casey Demo Mar 16th - Mar 31st 2027: PEO 2027-04-02 Mar 16th - Mar 31st 2027 2027-03-16 2027-03-31',
    ])
    expect(periodOn(report)).toEqual({ start: '2027-03-16', end: '2027-03-31' })
  })
})

describe("the month's payroll runs, as the registers print them", () => {
  const r16 = file('r0', 'payroll-register', [
    'Payments Report',
    'Pay period 12/28/2025 - 01/10/2026',
    'Pay Date 01/16/2026',
  ])
  const r30 = file('r1', 'payroll-register', [
    'Payments Report',
    'Pay period 01/11/2026 - 01/24/2026',
    'Pay Date 01/30/2026',
  ])
  const report = file('t1', 'timesheet', [
    'Time & jobs report',
    'Morgan Lee Dec 28th 2025 - Jan 10th 2026: PEO 2026-01-16 2025-12-28 2026-01-10 USD 1000.00',
    'Morgan Lee Jan 11th - Jan 24th 2026: PEO 2026-01-30 2026-01-11 2026-01-24 USD 1100.00',
  ])
  const stub = file('s1', 'paystub', [
    'EARNINGS STATEMENT',
    'PAY DATE:',
    '01/16/2026',
    'Gross Pay 135.00',
  ])

  it('places a file by the pay date it prints, and each line of a whole-month file by its own', () => {
    const runs = payRunsOf([r16, r30])
    expect(runOfFile(runs, stub)?.payDate).toBe('2026-01-16')
    // A report of both runs is of neither as a whole; each of its lines is of its own run.
    expect(runOfFile(runs, report)).toBeNull()
    expect(runOfLine(runs, report, report.lines[1]!)?.payDate).toBe('2026-01-16')
    expect(runOfLine(runs, report, report.lines[2]!)?.payDate).toBe('2026-01-30')
  })

  it('lists the runs the registers print, in pay date order', () => {
    expect(suggestedRuns(payRunsOf([r30, r16]))).toEqual([
      { payDate: '2026-01-16', start: '2025-12-28', end: '2026-01-10' },
      { payDate: '2026-01-30', start: '2026-01-11', end: '2026-01-24' },
    ])
  })
})
