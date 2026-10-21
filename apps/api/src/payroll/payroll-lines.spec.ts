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

  it("finds a shared person's engagement only by the job's name, and their own one alone", () => {
    const names = new Map([
      ['e-isy', 'In-School Youth Coding Pathway'],
      ['e-ait', 'Adult IT Training'],
    ])
    expect(engagementOfCharge('Board (Adult IT Training)', ['e-isy', 'e-ait'], names)).toBe('e-ait')
    expect(engagementOfCharge('General operations', ['e-isy', 'e-ait'], names)).toBeNull()
    expect(engagementOfCharge(null, ['e-isy'], names)).toBe('e-isy')
  })

  it('numbers each line PR-<pay date>-<whose>, taxes with T', () => {
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
      `PR-${RUN1.payDate.replace(/-/g, '')}-PART-T`
    )
  })
})
