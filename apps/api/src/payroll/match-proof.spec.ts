import type { StatementLine } from '@ad/types'
import {
  datesOf,
  matchSlot,
  nameIn,
  personIn,
  plainText,
  type ProofFile,
  type ProofItem,
} from './match-proof'

const line = (text: string, page = 1): StatementLine => ({
  page,
  text,
  x: 50,
  y: 700,
  width: 300,
  height: 12,
})
const file = (
  id: string,
  kind: ProofFile['kind'],
  fileName: string,
  texts: string[]
): ProofFile => ({
  id,
  kind,
  fileName,
  lines: texts.map((t) => line(t)),
})

// The fictional sample's September run (docs/samples/payroll-2026-09): Jordan and Casey both earned $280.00.
const jordan: ProofItem = {
  target: 'wex',
  id: 'w-jordan',
  kind: 'participant',
  name: 'Jordan Sample',
  amount: 280,
  start: '2026-09-07',
  end: '2026-09-20',
}
const timesheet = file('t', 'timesheet', 'Time and jobs report - 09.07.2026 - 09.20.2026.pdf', [
  'Employee | Pay run | Start date | End date | Gross pay | Hours worked | Program',
  'Jordan Sample | RUN-2026-0925 | 09/07/2026 | 09/20/2026 | $280.00 | 20.0 | Coding',
  'Casey Demo | RUN-2026-0925 | 09/07/2026 | 09/20/2026 | $280.00 | 20.0 | Coding',
])
const register = file('r', 'payroll-register', '09.22.26 payroll register.pdf', [
  'Pay run 09/07/2026 - 09/20/2026: Riverbend Youth Services',
  'Pay period 09/07/2026 - 09/20/2026',
  'Total direct deposits $724.02',
])
const stub = (id: string, who: string) =>
  file(id, 'paystub', `paystub-Riverbend-${who.replace(' ', '-')}-emp-no-901.pdf`, [
    `Paid to: ${who} (employee no. 901)`,
    'Pay period 09/07/2026 - 09/20/2026 · Pay date 09/25/2026',
    'Base pay $14.00 x 20.00 hours = $280.00',
  ])

describe('payroll proof matching', () => {
  it('reads the dates a payroll file writes', () => {
    expect(datesOf('09/07/2026 - 9.20.26, 2026-09-25 and 20260930')).toEqual([
      '2026-09-25',
      '2026-09-07',
      '2026-09-20',
      '2026-09-30',
    ])
  })

  it('finds a name in any order, as whole words', () => {
    expect(nameIn('Sample, Jordan', 'Jordan Sample')).toBe(true)
    expect(nameIn('Jordana Sample', 'Jordan Sample')).toBe(false)
  })

  it("marks the person's own row on the timesheet, not the row of someone paid the same", () => {
    const m = matchSlot(jordan, 'timesheet', [timesheet])
    expect(m.pick).toBe('t')
    expect(m.candidates[0]!.sure).toBe(true)
    expect(m.candidates[0]!.mark?.text).toMatch(/^Jordan Sample/)
  })

  it('places a register by its pay period when it does not name the person', () => {
    const m = matchSlot(jordan, 'register', [register])
    expect(m.pick).toBe('r')
    expect(m.candidates[0]!.mark?.text).toBe('Pay period 09/07/2026 - 09/20/2026')
  })

  it("picks the person's own pay stub and marks the line with their pay", () => {
    const m = matchSlot(jordan, 'stub', [
      stub('casey', 'Casey Demo'),
      stub('jordan', 'Jordan Sample'),
    ])
    expect(m.pick).toBe('jordan')
    expect(m.candidates[0]!.mark?.text).toMatch(/\$280\.00$/)
    expect(m.candidates.find((c) => c.fileId === 'casey')!.score).toBe(0)
  })

  it('leaves two equally good files to the person', () => {
    const m = matchSlot(jordan, 'stub', [stub('a', 'Jordan Sample'), stub('b', 'Jordan Sample')])
    expect(m.pick).toBeNull()
    expect(m.why).toMatch(/2 files fit equally/)
  })

  it('finds a staff line on the bank statement by its amount beside a near date', () => {
    const staff: ProofItem = {
      target: 'expense',
      id: 'x',
      kind: 'staff',
      name: null,
      amount: 724.02,
      start: '2026-09-25',
      end: '2026-09-25',
    }
    const bank = file('b', 'bank-statement', 'statement.pdf', [
      '09/04/2026 | DEBIT CARD BRIGHT PATH OFFICE SUPPLY | $212.18 |',
      '09/22/2026 | ACH DEBIT PAYPEOPLE PAYROLL RUN-2026-0925 | $724.02 |',
    ])
    const m = matchSlot(staff, 'bank', [bank])
    expect(m.pick).toBe('b')
    expect(m.candidates[0]!.mark?.text).toMatch(/PAYPEOPLE PAYROLL/)
  })

  it('says a scanned file has nothing to read', () => {
    const m = matchSlot(jordan, 'stub', [{ ...stub('s', 'Jordan Sample'), lines: [] }])
    expect(m.pick).toBeNull()
    expect(m.candidates[0]!.why).toMatch(/Scanned/)
  })

  it("finds a staff line's bank line as the debit of the pay run it was paid in, the register's stated total", () => {
    const staffLine: ProofItem = {
      target: 'expense',
      id: 'x-20',
      kind: 'staff',
      name: null,
      amount: 2100,
      start: '2026-09-25',
      end: '2026-09-25',
    }
    const reg = file('r2', 'payroll-register', 'register.pdf', [
      'Pay period 09/07/2026 - 09/20/2026',
      'Pay date 09/25/2026',
      'Employee Gross pay Taxes Net pay',
      'Morgan Lee $2,400.00 $528.00 $1,872.00',
      'Total direct deposits $6,339.17',
    ])
    const bank = file('b2', 'bank-statement', 'statement.pdf', [
      '09/18/2026 ACH DEBIT HILLTOP OFFICE SUPPLY $412.60',
      '09/24/2026 ACH DEBIT PAYPEOPLE PAYROLL NET PAY $6,339.17',
    ])
    const m = matchSlot(staffLine, 'bank', [reg, bank])
    expect(m.pick).toBe('b2')
    expect(m.candidates[0]).toMatchObject({ score: 4, sure: true })
    expect(m.candidates[0]!.mark?.text).toMatch(/NET PAY/)
    expect(m.candidates[0]!.why).toBe(
      "The pay run's debit, $6,339.17 (the payroll register's total), on page 1, near the pay date 09/25/2026."
    )
    // One file alone, its upload's files beside it: the same pick (Show and Save read it so).
    expect(matchSlot(staffLine, 'bank', [bank], [], [reg, bank]).pick).toBe('b2')
    // Without the register, the bank line's amount is not the line's: nothing is sure.
    expect(matchSlot(staffLine, 'bank', [bank]).pick).toBeNull()
  })

  describe("a pay belongs to the month it was paid in (owner's decision, 2026-10-19)", () => {
    // Run 1's pay period starts in August and is paid in September; run 2 is paid in September too.
    const reg1 = file('r1', 'payroll-register', 'Payroll register 09.11.2026.pdf', [
      'Pay period 08/24/2026 - 09/06/2026',
      'Pay date 09/11/2026',
      'Employee Gross pay Taxes Net pay',
      'Jordan Sample $140.00 $10.71 $129.29',
      'Total direct deposits $3,056.91',
    ])
    const reg2 = file('r2', 'payroll-register', 'Payroll register 09.25.2026.pdf', [
      'Pay period 09/07/2026 - 09/20/2026',
      'Pay date 09/25/2026',
      'Employee Gross pay Taxes Net pay',
      'Jordan Sample $280.00 $21.42 $258.58',
      'Total direct deposits $3,644.27',
    ])
    const bank = file('b', 'bank-statement', 'statement.pdf', [
      '09/10/2026 ACH DEBIT PAYPEOPLE PAYROLL NET PAY $3,056.91',
      '09/24/2026 ACH DEBIT PAYPEOPLE PAYROLL NET PAY $3,644.27',
    ])
    const augustPeriod: ProofItem = {
      ...jordan,
      amount: 140,
      start: '2026-08-24',
      end: '2026-09-06',
      month: '2026-09',
    }

    it('matches a September payment whose pay period starts in August to the register paid in September', () => {
      const m = matchSlot(augustPeriod, 'register', [reg1, reg2])
      expect(m.pick).toBe('r1')
      expect(m.candidates[0]).toMatchObject({ fileId: 'r1', sure: true })
    })

    it("never takes another month's register or pay stub as a month's proof", () => {
      const m = matchSlot({ ...augustPeriod, month: '2026-08' }, 'register', [reg1])
      expect(m.pick).toBeNull()
      expect(m.candidates[0]!.why).toBe("Paid on 09/11/2026: another month's pay.")
      const stub = file('s', 'paystub', 'stub.pdf', [
        'Employee: Jordan Sample',
        'Pay period 08/24/2026 - 09/06/2026',
        'Pay date 09/11/2026',
        'Gross Pay $140.00',
      ])
      expect(matchSlot({ ...augustPeriod, month: '2026-08' }, 'stub', [stub]).pick).toBeNull()
      expect(matchSlot(augustPeriod, 'stub', [stub]).pick).toBe('s')
    })

    it('gives a staff line the debit of the run paid on its date, of two runs in the month', () => {
      const staff = (start: string): ProofItem => ({
        target: 'expense',
        id: 'x',
        kind: 'staff',
        name: null,
        amount: 2100,
        start,
        end: start,
        month: '2026-09',
      })
      const on = (start: string) =>
        matchSlot(staff(start), 'bank', [reg1, reg2, bank]).candidates[0]!.mark?.text
      expect(on('2026-09-11')).toMatch(/^09\/10\/2026 .* \$3,056\.91$/)
      expect(on('2026-09-25')).toMatch(/^09\/24\/2026 .* \$3,644\.27$/)
    })
  })
})

describe('names as a file prints them (January test, 2026-10-19)', () => {
  it('repairs a name saved twice in the wrong encoding, and keeps a real accent', () => {
    expect(plainText('CaseyÃ¢â‚¬â„¢ Demo')).toBe("Casey' Demo")
    expect(plainText('JOÃO Sample')).toBe('JOÃO Sample')
  })

  it('treats every apostrophe alike, and finds a name with a middle name around it', () => {
    expect(personIn("Casey' Demo", 'Casey’ Demo')).toBe(true)
    expect(personIn('CaseyÃ¢â‚¬â„¢ Demo', 'Casey’ Demo')).toBe(true)
    expect(personIn('Riley JoÃ¢â‚¬â„¢anne Example', 'Morgan "Riley" Example')).toBe(true)
    expect(nameIn("Demo, Casey'", 'Casey’ Demo')).toBe(true)
  })
})
