import type { StatementLine } from '@ad/types'
import { datesOf, matchSlot, nameIn, type ProofFile, type ProofItem } from './match-proof'

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
})
