import { PDFDocument } from 'pdf-lib'
import type { PayrollSplitDto, StatementLine } from '@ad/types'
import { itemCopy } from './mark-pdf'
import type { PayrollCharge } from './payroll-details'
import { hoursOf, splitOf } from './payroll-split'
import { splitNoteText } from './split-note'

// Fictional: Jordan Sample's pay for Sep 16 - Sep 30, charged to three programs by the hours on the time report.
const line = (y: number, cells: string[]): StatementLine => ({
  page: 1,
  x: 0,
  y,
  width: 1,
  height: 1,
  text: cells.join(' | '),
})
const report = [
  line(1, ['Payroll journal report']),
  line(2, ['Pay period', 'Sep 16 - Sep 30']),
  line(3, [
    'Employee',
    'Employee Id',
    'Client Projects',
    'Salary Amount',
    'Salary Hours',
    'Holiday Hours Hours',
  ]),
  line(4, ['Jordan Sample', '7', '', '2000.00', '80.0', '0']),
  line(5, ['Jordan Sample', '7', 'Youth Coding Pathway', '1000.00', '36.0', '4.0']),
  line(6, ['Jordan Sample', '7', 'Adult IT Training', '750.00', '30.0', '0']),
  line(7, ['Jordan Sample', '7', 'Community Tech', '250.00', '10.0', '0']),
]
const charge = (job: string, amount: number, over: Partial<PayrollCharge> = {}): PayrollCharge => ({
  name: 'Jordan Sample',
  type: 'Salary',
  job,
  account: '63100 Salaries',
  amount,
  date: '2026-09-30',
  start: '2026-09-16',
  end: '2026-09-30',
  program: null,
  pay: true,
  wex: false,
  line: line(1, [job]),
  ...over,
})

describe('hoursOf', () => {
  it("adds up each row's hours columns by person and program, never an amount column, and skips the person's total", () => {
    expect(hoursOf({ lines: report }, () => '2026-09-30')).toEqual([
      { name: 'Jordan Sample', program: 'Youth Coding Pathway', end: '2026-09-30', hours: 40 },
      { name: 'Jordan Sample', program: 'Adult IT Training', end: '2026-09-30', hours: 30 },
      { name: 'Jordan Sample', program: 'Community Tech', end: '2026-09-30', hours: 10 },
    ])
  })

  it('reads nothing from a file without a program column and hours', () => {
    expect(hoursOf({ lines: [line(1, ['Name', 'Gross', 'Net'])] })).toEqual([])
  })
})

describe('splitOf', () => {
  const youth = charge('Youth Coding Pathway', 1000)
  const charges = [
    youth,
    charge('Adult IT Training', 750),
    charge('Community Tech', 250),
    // An employer tax of the same run: not pay, so not in the pay split.
    charge('Youth Coding Pathway', 76.5, { pay: false, type: 'Employer Medicare Tax' }),
    // Another run: not this line's.
    charge('Adult IT Training', 900, { end: '2026-09-15', start: '2026-09-01' }),
  ]
  const base = {
    who: 'Jordan Sample',
    printed: 'Jordan Sample',
    end: '2026-09-30',
    start: '2026-09-16',
    pay: true,
    charges,
    mine: new Set([youth]),
    hours: hoursOf({ lines: report }, () => '2026-09-30'),
  }

  it("splits the person's pay in the run by program, with each program's hours, the line's own marked", () => {
    expect(splitOf(base)).toEqual({
      kind: 'pay',
      who: 'Jordan Sample',
      start: '2026-09-16',
      end: '2026-09-30',
      rows: [
        { program: 'Youth Coding Pathway', hours: 40, amount: 1000, mine: true },
        { program: 'Adult IT Training', hours: 30, amount: 750, mine: false },
        { program: 'Community Tech', hours: 10, amount: 250, mine: false },
      ],
    })
  })

  it('folds the names a program goes by into one row, and leaves hours off when a program has none', () => {
    const got = splitOf({
      ...base,
      charges: [...charges, charge('Coding Pathway - Youth (class)', 0.01)],
      programs: [['Youth Coding Pathway', 'Coding Pathway - Youth (class)']],
      hours: base.hours.filter((h) => h.program !== 'Community Tech'),
    })
    expect(got!.rows.map((r) => [r.program, r.hours, r.amount])).toEqual([
      ['Youth Coding Pathway', null, 1000.01],
      ['Adult IT Training', null, 750],
      ['Community Tech', null, 250],
    ])
  })

  it('needs no split when the pay is all one program', () => {
    expect(splitOf({ ...base, charges: [youth] })).toBeNull()
  })
})

describe('the note of a split', () => {
  const split: PayrollSplitDto = {
    kind: 'pay',
    who: 'Jordan Sample',
    start: '2026-09-16',
    end: '2026-09-30',
    rows: [
      { program: 'Youth Coding Pathway', hours: 40, amount: 1000, mine: true },
      { program: 'Adult IT Training', hours: 30, amount: 750, mine: false },
      { program: 'Community Tech', hours: 10, amount: 250, mine: false },
    ],
  }

  it('says why the line is less than the pay, by hours, with each program and the total', () => {
    const t = splitNoteText(split)
    expect(t.title).toBe("Why this line is $1,000.00 of Jordan Sample's $2,000.00 pay")
    expect(t.body).toContain('whole pay for Sep 16 – Sep 30, 2026: $2,000.00')
    expect(t.body).toContain(
      'This line is the share of Youth Coding Pathway: 40.00 of 80.00 hours, $1,000.00.'
    )
    expect(t.rows.map((r) => [r.program, r.hours, r.share, r.amount, r.mine])).toEqual([
      ['Youth Coding Pathway', '40.00', '50.00%', '$1,000.00', true],
      ['Adult IT Training', '30.00', '37.50%', '$750.00', false],
      ['Community Tech', '10.00', '12.50%', '$250.00', false],
    ])
    expect(t.total).toEqual({ hours: '80.00', amount: '$2,000.00' })
  })

  it("says a taxes line's figures are the employer's, which a stub does not show in full", () => {
    const t = splitNoteText({ ...split, kind: 'taxes' })
    expect(t.title).toBe('Why this line is $1,000.00')
    expect(t.body).toContain('a pay stub does not show in full')
  })

  it("puts the note before the stub's pages on the item's copy", async () => {
    const pdf = await PDFDocument.create()
    pdf.addPage([612, 792])
    pdf.addPage([612, 792])
    const original = await pdf.save()
    const withNote = await itemCopy(
      original,
      [{ page: 2, x: 10, y: 10, width: 50, height: 10 }],
      split
    )
    expect(withNote.notDrawn).toEqual([])
    expect((await PDFDocument.load(withNote.bytes)).getPageCount()).toBe(3)
    const without = await itemCopy(original, [])
    expect((await PDFDocument.load(without.bytes)).getPageCount()).toBe(2)
  })
})
