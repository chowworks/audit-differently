import { describe, expect, it } from 'vitest'
import {
  datesIn,
  decideRegister,
  decideStub,
  decideTimesheet,
  registerFor as registerMatch,
  stubFor as stubMatch,
  timesheetFor as timesheetMatch,
  type MatchDoc,
  type MatchItem,
} from './payroll-match'

// The tests read the id; the guess-or-sure flag has its own test below.
const timesheetFor = (i: MatchItem, d: MatchDoc[]) => timesheetMatch(i, d)?.id ?? null
const registerFor = (i: MatchItem, d: MatchDoc[]) => registerMatch(i, d)?.id ?? null
const stubFor = (i: MatchItem, d: MatchDoc[]) => stubMatch(i, d)?.id ?? null

// Fictional names and files, shaped like a payroll provider's exports.
const docs: MatchDoc[] = [
  { id: 't1', kind: 'timesheet', fileName: 'Time and jobs report - 12.28.26 - 01.10.27.pdf' },
  { id: 't2', kind: 'timesheet', fileName: 'Time and jobs report - 01.11.27 - 01.24.27.pdf' },
  { id: 't3', kind: 'timesheet', fileName: 'Jan 2027 daily hours.pdf' },
  { id: 'r1', kind: 'payroll-register', fileName: '01.13.27 payroll register.pdf' },
  { id: 'r2', kind: 'payroll-register', fileName: '01.27.27 payroll register.pdf' },
  {
    id: 's1',
    kind: 'paystub',
    fileName: 'paystub-Riverbend-20270111-20270124-Jordan-Sample-emp-no-901.pdf',
  },
  {
    id: 's2',
    kind: 'paystub',
    fileName: 'paystub-Riverbend-20270111-20270124-Riley-Example-emp-no-902.pdf',
  },
  {
    id: 's3',
    kind: 'paystub',
    fileName: 'paystub-Riverbend-20261228-20270110-Jordan-Sample-emp-no-901.pdf',
  },
]
const jordan = {
  kind: 'participant' as const,
  start: '2027-01-11',
  end: '2027-01-24',
  name: 'Jordan Sample',
}

describe('payroll matching from file names', () => {
  it('reads the dates a file name holds, in the formats exports use', () => {
    expect(datesIn('Time and jobs report - 01.11.27 - 01.24.27.pdf')).toEqual([
      '2027-01-11',
      '2027-01-24',
    ])
    expect(datesIn('paystub-x-20270111-20270124-a-b')).toEqual(['2027-01-11', '2027-01-24'])
    expect(datesIn('01.27.27 payroll register')).toEqual(['2027-01-27'])
    expect(datesIn('statement 2027-01-05.pdf')).toEqual(['2027-01-05'])
    expect(datesIn('Jan 2027 daily hours')).toEqual([])
  })

  it('pre-fills the time report, register and stub of a participant’s pay period', () => {
    expect(timesheetFor(jordan, docs)).toBe('t2')
    expect(registerFor(jordan, docs)).toBe('r2')
    expect(stubFor(jordan, docs)).toBe('s1')
    const earlier = { ...jordan, start: '2026-12-28', end: '2027-01-10' }
    expect(timesheetFor(earlier, docs)).toBe('t1')
    expect(registerFor(earlier, docs)).toBe('r1')
    expect(stubFor(earlier, docs)).toBe('s3')
  })

  it('never takes a register debited after a staff line’s pay date', () => {
    expect(registerFor({ kind: 'staff', start: '2027-01-25', end: '2027-01-25' }, docs)).toBe('r1')
    expect(registerFor({ kind: 'staff', start: '2027-01-12', end: '2027-01-12' }, docs)).toBeNull()
  })

  it('takes a staff line’s date as its pay date: the register debited in the week before', () => {
    expect(registerFor({ kind: 'staff', start: '2027-01-30', end: '2027-01-30' }, docs)).toBe('r2')
  })

  it('leaves it empty when nothing fits or more than one does', () => {
    expect(stubFor({ ...jordan, name: 'Casey Demo' }, docs)).toBeNull()
    expect(registerFor({ ...jordan, end: '2027-06-01' }, docs)).toBeNull()
    const twice = [
      ...docs,
      { id: 'r3', kind: 'payroll-register', fileName: '01.28.27 register copy.pdf' },
    ]
    expect(registerFor(jordan, twice)).toBeNull()
    expect(stubFor({ kind: 'staff', start: '2027-01-11', end: '2027-01-24' }, docs)).toBeNull()
  })
})

// The downloadable sample (apps/web/public/samples/payroll-sample.zip) is the demo month's own payroll: every item
// of the seeded September must Auto-Match from its file names alone.
describe('the sample zip against the demo month', () => {
  const sample: MatchDoc[] = [
    { id: 'ts', kind: 'timesheet', fileName: 'Time and jobs report - 09.07.2026 - 09.20.2026.pdf' },
    { id: 'rg', kind: 'payroll-register', fileName: '09.22.26 payroll register.pdf' },
    ...['Jordan-Sample-emp-no-901', 'Riley-Example-emp-no-902', 'Casey-Demo-emp-no-903'].map(
      (who, i) => ({
        id: `st${i}`,
        kind: 'paystub',
        fileName: `paystub-Riverbend-Youth-Services-20260907-20260920-${who}.pdf`,
      })
    ),
  ]
  const period = { kind: 'participant' as const, start: '2026-09-07', end: '2026-09-20' }

  it('fills every participant’s timesheet, register and pay stub', () => {
    for (const [name, stub] of [
      ['Jordan Sample', 'st0'],
      ['Riley Example', 'st1'],
      ['Casey Demo', 'st2'],
    ] as const) {
      const item = { ...period, name }
      expect([
        timesheetFor(item, sample),
        registerFor(item, sample),
        stubFor(item, sample),
      ]).toEqual(['ts', 'rg', stub])
    }
  })

  it('fills the timesheet and register of the staff payroll line paid on 09/25, in arrears', () => {
    const staff = { kind: 'staff' as const, start: '2026-09-25', end: '2026-09-25' }
    expect(timesheetFor(staff, sample)).toBe('ts')
    expect(registerFor(staff, sample)).toBe('rg')
  })

  it('takes a staff pay date inside the period (paid current) or up to two weeks after it, else nothing', () => {
    const on = (date: string) => timesheetFor({ kind: 'staff', start: date, end: date }, sample)
    expect(on('2026-09-15')).toBe('ts')
    expect(on('2026-10-06')).toBe('ts')
    // Beyond two weeks and a weekend it is only a guess; far beyond, nothing.
    expect(
      timesheetMatch({ kind: 'staff', start: '2026-10-08', end: '2026-10-08' }, sample)
    ).toEqual({
      id: 'ts',
      sure: false,
    })
    expect(on('2026-12-01')).toBeNull()
    // Two reports fit a date two weeks after one period and inside the next: none is pre-filled.
    const two = [
      ...sample,
      {
        id: 'ts2',
        kind: 'timesheet',
        fileName: 'Time and jobs report - 09.21.2026 - 10.04.2026.pdf',
      },
    ]
    expect(timesheetFor({ kind: 'staff', start: '2026-10-02', end: '2026-10-02' }, two)).toBeNull()
  })
})

describe('widening the window', () => {
  const regs: MatchDoc[] = [
    { id: 'r1', kind: 'payroll-register', fileName: '09.22.26 payroll register.pdf' },
  ]
  const after = (end: string) => ({ kind: 'participant' as const, start: '2026-09-07', end })

  it('is sure close to the period and only guesses once widened', () => {
    expect(registerMatch(after('2026-09-20'), regs)).toEqual({ id: 'r1', sure: true })
    expect(registerMatch(after('2026-09-01'), regs)).toEqual({ id: 'r1', sure: false })
    expect(registerMatch(after('2026-07-01'), regs)).toBeNull()
  })

  it('stops at a window holding two files rather than picking one', () => {
    const two = [
      ...regs,
      { id: 'r2', kind: 'payroll-register', fileName: '09.24.26 payroll register.pdf' },
    ]
    expect(registerMatch(after('2026-09-20'), two)).toBeNull()
  })
})

describe('paid once a month', () => {
  const monthly: MatchDoc[] = [
    { id: 'tsep', kind: 'timesheet', fileName: 'Time report - 09.01.2026 - 09.30.2026.pdf' },
    { id: 'toct', kind: 'timesheet', fileName: 'Time report - 10.01.2026 - 10.31.2026.pdf' },
    { id: 'rsep', kind: 'payroll-register', fileName: '10.03.26 payroll register.pdf' },
    { id: 'roct', kind: 'payroll-register', fileName: '11.03.26 payroll register.pdf' },
  ]

  it('matches a monthly period and a pay date a few days or two weeks after it', () => {
    const sep = { kind: 'participant' as const, start: '2026-09-01', end: '2026-09-30' }
    expect(timesheetMatch(sep, monthly)).toEqual({ id: 'tsep', sure: true })
    expect(registerMatch(sep, monthly)).toEqual({ id: 'rsep', sure: true })
    const paid = (date: string) => ({ kind: 'staff' as const, start: date, end: date })
    expect(timesheetMatch(paid('2026-10-14'), monthly)).toBeNull() // inside October, two weeks after September
    expect(timesheetMatch(paid('2026-09-30'), monthly)).toEqual({ id: 'tsep', sure: true })
    expect(registerMatch(paid('2026-10-05'), monthly)).toEqual({ id: 'rsep', sure: true })
  })
})

describe('the reasons Auto-Match gives', () => {
  const sample: MatchDoc[] = [
    { id: 'ts', kind: 'timesheet', fileName: 'Time and jobs report - 09.07.2026 - 09.20.2026.pdf' },
    { id: 'rg', kind: 'payroll-register', fileName: '09.22.26 payroll register.pdf' },
    {
      id: 'st',
      kind: 'paystub',
      fileName: 'paystub-Riverbend-Youth-Services-20260907-20260920-Jordan-Sample-emp-no-901.pdf',
    },
  ]
  const jordan = {
    kind: 'participant' as const,
    start: '2026-09-07',
    end: '2026-09-20',
    name: 'Jordan Sample',
  }

  it('says why each file was matched', () => {
    expect(decideTimesheet(jordan, sample)).toMatchObject({
      file: 'Time and jobs report - 09.07.2026 - 09.20.2026.pdf',
      why: 'Its period, Sep 7–Sep 20, covers Sep 7–Sep 20.',
    })
    expect(decideRegister(jordan, sample)).toMatchObject({
      file: '09.22.26 payroll register.pdf',
      why: 'Dated Sep 22, 2 days after the pay period ended.',
    })
    expect(decideStub(jordan, sample).why).toMatch(/holds "Jordan Sample" and the pay period/)
  })

  it('says why nothing was', () => {
    const staff = { kind: 'staff' as const, start: '2026-09-19', end: '2026-09-19' }
    expect(decideRegister(staff, sample).why).toBe(
      'Every register is dated after the Sep 19 pay date, and a run is debited before it is paid.'
    )
    expect(decideStub({ ...jordan, name: 'Casey Demo' }, sample).why).toBe(
      'No stub\'s file name holds "Casey Demo".'
    )
    expect(decideTimesheet(jordan, []).why).toBe('No timesheet in the upload.')
  })
})
