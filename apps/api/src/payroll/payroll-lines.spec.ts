import { payrollDetailsXlsx, RUNS } from '../../prisma/payroll-workspace-sample'
import { chargesOf, sheetLines, type PayrollCharge } from './payroll-details'
import {
  engagementOfCharge,
  payrollItemNumber,
  payrollLinesOf,
  type LineMonth,
} from './payroll-lines'
import type { ParticipantRow, StaffRow } from './staff-match'

const staff: StaffRow[] = [
  { id: 's-morgan', name: 'Morgan Lee', engagementIds: ['e-isy', 'e-ait'] },
  { id: 's-priya', name: 'Priya Shah', engagementIds: ['e-isy'] },
  { id: 's-sam', name: 'Sam Ortiz', engagementIds: ['e-ait'] },
]
const participants: ParticipantRow[] = ['Jordan Sample', 'Riley Example', 'Casey Demo'].map(
  (displayName, i) => ({ id: `p-${i}`, engagementId: 'e-isy', displayName, participantId: `${i}` })
)
const month = (id: 'isy' | 'ait', over: Partial<LineMonth> = {}): LineMonth => ({
  reportId: `r-${id}`,
  engagementId: `e-${id}`,
  engagementName: id === 'isy' ? 'In-School Youth Coding Pathway' : 'Adult IT Training',
  lines: [
    { id: `${id}-salaries`, payroll: ['staff-pay'] },
    { id: `${id}-fringe`, payroll: ['staff-taxes'] },
    { id: `${id}-wex`, payroll: ['participant-pay', 'participant-taxes'] },
  ],
  enteredStaffDates: [],
  ...over,
})
const [RUN1, RUN2] = RUNS as [(typeof RUNS)[0], (typeof RUNS)[0]]

describe('payrollLinesOf', () => {
  let charges: PayrollCharge[]
  beforeAll(async () => {
    charges = chargesOf(await sheetLines(await payrollDetailsXlsx()))
  })

  it("puts each person's pay in each run on the line ticked Staff pay, of the engagement the job names", () => {
    const { writes, skipped } = payrollLinesOf({
      charges,
      staff,
      participants,
      months: [month('isy'), month('ait')],
    })
    const pay = writes
      .filter((w) => w.kind === 'staff-pay')
      .map((w) => [w.engagementId, w.who, w.date, w.amount, w.budgetLineId])
    expect(pay).toEqual(
      expect.arrayContaining([
        ['e-isy', 'Morgan Lee', RUN1.payDate, 600, 'isy-salaries'],
        ['e-ait', 'Morgan Lee', RUN1.payDate, 600, 'ait-salaries'],
        ['e-isy', 'Priya Shah', RUN1.payDate, 855, 'isy-salaries'],
        ['e-isy', 'Priya Shah', RUN2.payDate, 945, 'isy-salaries'],
        ['e-ait', 'Sam Ortiz', RUN2.payDate, 1000, 'ait-salaries'],
      ])
    )
    expect(pay).toHaveLength(8)
    expect(skipped).toEqual([])
  })

  it("keeps the run's split by program on a line whose person's pay is charged to several, and none on one that is not", () => {
    const { writes } = payrollLinesOf({
      charges,
      staff,
      participants,
      months: [month('isy'), month('ait')],
    })
    const morgan = writes.find(
      (w) => w.engagementId === 'e-isy' && w.who === 'Morgan Lee' && w.kind === 'staff-pay'
    )!
    expect(morgan.split!.kind).toBe('pay')
    expect(morgan.split!.rows.filter((r) => r.mine).map((r) => r.amount)).toEqual([morgan.amount])
    expect(morgan.split!.rows).toHaveLength(2)
    const priya = writes.find((w) => w.who === 'Priya Shah' && w.kind === 'staff-pay')!
    expect(priya.split).toBeNull()
  })

  it("puts the employer's taxes on Staff taxes and benefits, and the participants' taxes per run on Participant taxes", () => {
    const { writes } = payrollLinesOf({
      charges,
      staff,
      participants,
      months: [month('isy'), month('ait')],
    })
    expect(writes.find((w) => w.key === `staff:s-priya:${RUN1.end}:taxes`)).toMatchObject({
      budgetLineId: 'isy-fringe',
      amount: 65.41,
    })
    const part = writes.filter((w) => w.kind === 'participant-taxes')
    expect(part.map((w) => [w.key, w.budgetLineId, w.date])).toEqual([
      [`participants:${RUN1.end}:taxes`, 'isy-wex', RUN1.payDate],
      [`participants:${RUN2.end}:taxes`, 'isy-wex', RUN2.payDate],
    ])
    // Their pay is never a line: it counts from their payments.
    expect(writes.some((w) => w.kind === 'participant-pay')).toBe(false)
  })

  it('leaves a run a person already entered on the month, and says when no line holds a kind', () => {
    const { writes, skipped } = payrollLinesOf({
      charges,
      staff,
      participants,
      months: [
        month('isy', { enteredStaffDates: [RUN1.payDate] }),
        month('ait', { lines: [{ id: 'ait-program', payroll: [] }] }),
      ],
    })
    expect(writes.some((w) => w.reportId === 'r-isy' && w.date === RUN1.payDate && w.staffId)).toBe(
      false
    )
    expect(writes.some((w) => w.reportId === 'r-ait')).toBe(false)
    expect(skipped).toEqual(
      expect.arrayContaining([
        { who: 'Priya Shah', end: RUN1.end, why: 'entered' },
        { who: 'Sam Ortiz', end: RUN1.end, why: 'no-line' },
      ])
    )
  })

  it('totals the payroll no budget line takes, by engagement month and kind, for the page to flag', () => {
    const lined = payrollLinesOf({
      charges,
      staff,
      participants,
      months: [month('isy'), month('ait')],
    })
    // Every line taken: nothing to flag.
    expect(lined.unbudgeted).toEqual([])
    const onAit = (kind: string) =>
      lined.writes
        .filter((w) => w.reportId === 'r-ait' && w.kind === kind)
        .reduce((t, w) => Math.round((t + w.amount) * 100) / 100, 0)
    const { writes, unbudgeted } = payrollLinesOf({
      charges,
      staff,
      participants,
      months: [month('isy'), month('ait', { lines: [{ id: 'ait-program', payroll: [] }] })],
    })
    // What would have been Adult IT Training's lines, by kind, left off and said.
    expect(unbudgeted).toEqual([
      { reportId: 'r-ait', engagementId: 'e-ait', kind: 'staff-pay', amount: onAit('staff-pay') },
      {
        reportId: 'r-ait',
        engagementId: 'e-ait',
        kind: 'staff-taxes',
        amount: onAit('staff-taxes'),
      },
    ])
    expect(onAit('staff-pay')).toBeGreaterThan(0)
    expect(writes.some((w) => w.reportId === 'r-ait')).toBe(false)
  })

  it("puts a participant's taxes on the engagement the job names when they are on two, and says when none is named", () => {
    const tax = (job: string | null, end: string): PayrollCharge => ({
      name: 'Jordan Sample',
      type: 'Employer Medicare Tax',
      job,
      account: 'Work experience taxes',
      amount: 12.5,
      date: end,
      start: null,
      end,
      program: null,
      pay: false,
      wex: true,
      line: { page: 1, text: 'Jordan Sample', x: 0, y: 0, width: 0, height: 0 },
    })
    const { writes, skipped } = payrollLinesOf({
      charges: [tax('Board (Adult IT Training)', '2026-01-10'), tax(null, '2026-01-24')],
      staff,
      participants: [
        ...participants,
        { id: 'p-ait', engagementId: 'e-ait', displayName: 'Jordan Sample', participantId: '9' },
      ],
      months: [month('isy'), month('ait')],
    })
    expect(writes.map((w) => [w.engagementId, w.key, w.amount])).toEqual([
      ['e-ait', 'participants:2026-01-10:taxes', 12.5],
    ])
    expect(skipped).toEqual([{ who: 'Jordan Sample', end: '2026-01-24', why: 'no-engagement' }])
  })

  it("finds a person's engagement by the program the charge names, and their own one alone when it names none", () => {
    const names = new Map([
      ['e-isy', ['In-School Youth Coding Pathway']],
      ['e-ait', ['Adult IT Training', 'Adults - Board AIT (2026)']],
    ])
    const of = (job: string | null, ids: string[], program: string | null = null) =>
      engagementOfCharge({ job, program }, ids, names)
    expect(of('Board (Adult IT Training)', ['e-isy', 'e-ait'])).toEqual({ id: 'e-ait' })
    // The class column names it by another of its names (the workspace's program names).
    expect(of(null, ['e-isy', 'e-ait'], 'Adults - Board AIT (2026)')).toEqual({ id: 'e-ait' })
    // A program that is not one of ours is no one's here, even for a person on one engagement.
    expect(of('General operations', ['e-isy', 'e-ait'])).toEqual({ id: null, why: 'other-program' })
    expect(of('General operations', ['e-isy'])).toEqual({ id: null, why: 'other-program' })
    // Another engagement's program is not this person's to carry.
    expect(of('Adult IT Training', ['e-isy'])).toEqual({ id: null, why: 'other-program' })
    expect(of(null, ['e-isy'])).toEqual({ id: 'e-isy' })
    expect(of(null, ['e-isy', 'e-ait'])).toEqual({ id: null, why: 'no-engagement' })
  })

  it('leaves out a run of another month (the month its work was done) and a run that nets to nothing', () => {
    const pay = (end: string, date: string, amount: number): PayrollCharge => ({
      name: 'Priya Shah',
      type: 'Salary',
      job: 'In-School Youth Coding Pathway',
      account: 'Salaries - Employees',
      amount,
      date,
      start: null,
      end,
      program: null,
      pay: true,
      wex: false,
      line: { page: 1, text: 'Priya Shah', x: 0, y: 0, width: 0, height: 0 },
    })
    const { writes, skipped } = payrollLinesOf({
      charges: [
        // August's second half, accrued, reversed and booked again in September: August's.
        pay('2026-08-31', '2026-09-01', -300),
        pay('2026-08-31', '2026-09-04', 300),
        // September's second half, paid in October: September's.
        pay('2026-09-30', '2026-09-30', 410),
        // Booked and reversed in the month: nothing to write.
        pay('2026-09-15', '2026-09-17', 200),
        pay('2026-09-15', '2026-09-20', -200),
      ],
      staff,
      participants,
      months: [month('isy')],
      period: '2026-09',
    })
    expect(writes.map((w) => [w.end, w.amount])).toEqual([['2026-09-30', 410]])
    expect(skipped).toContainEqual({ who: 'Priya Shah', end: '2026-08-31', why: 'other-month' })
  })

  it('numbers each line PR-<run end>-<whose>, taxes with T', () => {
    const { writes } = payrollLinesOf({
      charges,
      staff,
      participants,
      months: [month('isy'), month('ait')],
    })
    const numbers = writes.map(payrollItemNumber)
    expect(new Set(numbers.map((n, i) => `${writes[i]!.engagementId}|${n}`)).size).toBe(
      writes.length
    )
    expect(payrollItemNumber(writes.find((w) => w.kind === 'participant-taxes')!)).toBe(
      `PR-${RUN1.end.replace(/-/g, '')}-PART-T`
    )
  })
})
