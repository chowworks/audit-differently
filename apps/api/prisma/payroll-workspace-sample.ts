import * as ExcelJS from 'exceljs'
import { unzipSync, zipSync } from 'fflate'
import { layoutPdf, type PdfRow } from './pdf'

/**
 * The workspace payroll sample (GitHub issue #22): fictional September 2026 payroll for Riverbend Youth Services, for
 * demos and the owner's tour of the workspace payroll page. Like a real month it holds two pay runs (owner's decision,
 * 2026-10-19), each with its own register, its own time report for its pay period, a pay stub per participant, and its
 * own two bank debits: one for the run's net pay and one for its taxes. Run 1's pay period starts in August, but it is
 * paid in September, so it is September's pay (a pay belongs to the month of its pay date). Three staff, shared between
 * the demo's two engagements once the owner tags them, and the three work-experience participants of In-School Youth
 * Coding Pathway, paid in both runs; and, so the tour shows both kinds of pay that land on no engagement, a program
 * assistant who is not on the tour's staff list (both runs) and a participant on no engagement's participant list (run 2).
 * The bank statement never has a line per person. Every page is footed as a sample, and read by the app's own readers
 * in `src/payroll/payroll-workspace-sample.spec.ts`. `scripts/make-payroll-sample.ts` writes the files and the zip.
 * Fictional people, companies and amounts only (CLAUDE.md, "Data rules").
 */

export const SAMPLE_FOOTER = 'SAMPLE - fictional data for trying Audit Differently'
export const COMPANY = 'Riverbend Youth Services'
export const PROVIDER = 'PayPeople Payroll (fictional)'
export const BANK = 'Lakeside Community Bank (fictional)'

export interface SamplePerson {
  name: string
  group: 'Staff' | 'Work experience'
  /** As the timesheet prints it. */
  role: string
  program: string
  hours: number
  gross: number
  /** Withheld this period. */
  taxes: number
  net: number
  /** Gross for the year so far, this period included: always more than this period's gross. */
  ytdGross: number
}

const cents = (n: number) => Math.round(n * 100) / 100
/** Staff: 22% withheld. Participants: Social Security and Medicare. `n`: how many pay periods so far this year. */
const person = (
  name: string,
  group: SamplePerson['group'],
  role: string,
  program: string,
  hours: number,
  gross: number,
  n: number
): SamplePerson => {
  const taxes = cents(gross * (group === 'Staff' ? 0.22 : 0.0765))
  return {
    name,
    group,
    role,
    program,
    hours,
    gross,
    taxes,
    net: cents(gross - taxes),
    ytdGross: cents(gross * n),
  }
}

/** The staff the tour adds to the staff list and tags to the engagements, as the timesheet names them. */
export const STAFF = [
  { name: 'Morgan Lee', role: 'Lead instructor', program: 'In-School Youth, Adult IT' },
  { name: 'Priya Shah', role: 'Case manager', program: 'In-School Youth' },
  { name: 'Sam Ortiz', role: 'Bootcamp leader', program: 'Adult IT Training' },
]
/** On the registers and the timesheets, not on the tour's staff list: their pay reaches no engagement. */
export const UNLISTED_STAFF = {
  name: 'Taylor Brooks',
  role: 'Program assistant',
  program: 'General operations',
}
/** In-School Youth Coding Pathway's work-experience participants, on its participant list in the demo. */
export const PARTICIPANTS = ['Jordan Sample', 'Riley Example', 'Casey Demo']
/** Paid with a pay stub in run 2, on no engagement's participant list. */
export const UNLISTED_PARTICIPANT = 'Alex Rivera'

/** One pay run: its pay period, pay date and debit date (yyyy-mm-dd), and everyone it pays, in the register's order. */
export interface SampleRun {
  n: 1 | 2
  start: string
  end: string
  payDate: string
  /** The day the payroll company debits the run's pay and taxes, the day before its pay date. */
  debitDate: string
  people: SamplePerson[]
}

const staffOf = (s: (typeof STAFF)[number], hours: number, gross: number, n: number) =>
  person(s.name, 'Staff', s.role, s.program, hours, gross, n)
const youth = (name: string, program: string, hours: number, n: number) =>
  person(name, 'Work experience', 'Participant', program, hours, cents(hours * 14), n)
const [MORGAN, PRIYA, SAM] = STAFF as [(typeof STAFF)[0], (typeof STAFF)[0], (typeof STAFF)[0]]
const ISY_WEX = 'In-School Youth (WEX)'

/**
 * September's two runs. Each staff member's September pay adds up to the figures the tour's engagement cards read
 * (Morgan $2,400.00, Priya $1,800.00, Sam $2,000.00).
 */
export const RUNS: SampleRun[] = [
  {
    n: 1,
    start: '2026-08-24',
    end: '2026-09-06',
    payDate: '2026-09-11',
    debitDate: '2026-09-10',
    people: [
      staffOf(MORGAN, 40, 1200, 17),
      staffOf(PRIYA, 38, 855, 17),
      staffOf(SAM, 40, 1000, 17),
      staffOf(UNLISTED_STAFF, 20, 400, 17),
      youth('Jordan Sample', ISY_WEX, 10, 3),
      youth('Riley Example', ISY_WEX, 8, 3),
      youth('Casey Demo', ISY_WEX, 10, 3),
    ],
  },
  {
    n: 2,
    start: '2026-09-07',
    end: '2026-09-20',
    payDate: '2026-09-25',
    debitDate: '2026-09-24',
    people: [
      staffOf(MORGAN, 40, 1200, 18),
      staffOf(PRIYA, 42, 945, 18),
      staffOf(SAM, 40, 1000, 18),
      staffOf(UNLISTED_STAFF, 20, 400, 18),
      youth('Jordan Sample', ISY_WEX, 20, 4),
      youth('Riley Example', ISY_WEX, 16, 4),
      youth('Casey Demo', ISY_WEX, 20, 4),
      youth(UNLISTED_PARTICIPANT, 'Summer Youth (WEX)', 12, 2),
    ],
  },
]

/** Everyone a run pays with a pay stub: its participants. */
export const stubsOf = (run: SampleRun) => run.people.filter((p) => p.group === 'Work experience')

/** 09/07/2026, as the payroll company and the bank print a date. */
export const us = (iso: string) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`
export const money = (n: number) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
/** What one run adds up to: gross, withheld, net (its net pay debit), the employer's taxes and its tax debit. */
export function totalsOf(run: SampleRun) {
  const sum = (f: (p: SamplePerson) => number) => cents(run.people.reduce((t, p) => t + f(p), 0))
  const gross = sum((p) => p.gross)
  const taxes = sum((p) => p.taxes)
  /** The employer's share of Social Security and Medicare, debited with what was withheld. */
  const employer = cents(gross * 0.0765)
  return {
    gross,
    taxes,
    net: sum((p) => p.net),
    ytdGross: sum((p) => p.ytdGross),
    employer,
    taxDebit: cents(taxes + employer),
  }
}
/** An unrelated payment on the statement: a vendor, not payroll. */
export const VENDOR = { what: 'ACH DEBIT HILLTOP OFFICE SUPPLY', date: '2026-09-18', out: 412.6 }
export const DEPOSIT_IN = 9800
const periodWords = (run: SampleRun) => `${us(run.start)} - ${us(run.end)}`
/** 09.25.2026, as the files' names print a date. */
const dotted = (iso: string) => us(iso).replace(/\//g, '.')

/** The payroll company's time report for one run: one row per person, with the pay period, hours, gross and program. */
export function timesheetPdf(run: SampleRun): Promise<Buffer> {
  const at = [48, 140, 262, 312, 384]
  return layoutPdf(
    'Time report',
    [
      [COMPANY, '·', PROVIDER],
      ['Pay period', us(run.start), '-', us(run.end)],
      null,
      { at, cells: ['Employee', 'Pay period', 'Hours', 'Gross pay', 'Program'] },
      ...run.people.map((p) => ({
        at,
        cells: [p.name, periodWords(run), p.hours.toFixed(1), money(p.gross), p.program],
      })),
      null,
      'Hours approved by each site supervisor for the pay period.',
    ],
    SAMPLE_FOOTER
  )
}

/**
 * One run's payroll register: one row per person (gross, taxes, net and the year to date), with totals, and what the
 * run debits the bank: the direct deposits (the net pay) and the taxes.
 */
export function registerPdf(run: SampleRun): Promise<Buffer> {
  const at = [48, 170, 260, 340, 430]
  const t = totalsOf(run)
  return layoutPdf(
    'Payroll register',
    [
      [COMPANY, '·', PROVIDER],
      ['Pay period', us(run.start), '-', us(run.end)],
      ['Pay date', us(run.payDate)],
      null,
      { at, cells: ['Employee', 'Gross pay', 'Taxes', 'Net pay', 'YTD gross'] },
      ...run.people.map((p) => ({
        at,
        cells: [p.name, money(p.gross), money(p.taxes), money(p.net), money(p.ytdGross)],
      })),
      null,
      { at, cells: ['Totals', money(t.gross), money(t.taxes), money(t.net), money(t.ytdGross)] },
      null,
      ['Total direct deposits', money(t.net), '·', 'debited', us(run.debitDate)],
      [
        'Total taxes debited (withheld and employer)',
        money(t.taxDebit),
        '·',
        'debited',
        us(run.debitDate),
      ],
    ],
    SAMPLE_FOOTER
  )
}

/** One participant's pay stub for one run: who, the pay period and pay date, then the gross after its label, and the net. */
export function stubPdf(run: SampleRun, p: SamplePerson): Promise<Buffer> {
  const rows: PdfRow[] = [
    ['Employer:', COMPANY, '·', 'paid through', PROVIDER],
    // Each part of the name its own run, so a name highlight covers exactly that word.
    ['Employee:', ...p.name.split(' ')],
    ['Program:', p.program],
    ['Pay period', us(run.start), '-', us(run.end)],
    ['Pay date', us(run.payDate)],
    null,
    ['Hours', p.hours.toFixed(2)],
    ['Gross Pay', money(p.gross)],
    ['Social Security and Medicare', money(p.taxes)],
    ['Net Pay', money(p.net)],
    null,
    ['Year-to-date gross', money(p.ytdGross)],
    'Direct deposit to account ending 0000',
  ]
  return layoutPdf('Pay stub', rows, SAMPLE_FOOTER)
}

/** The bank statement's lines, by date: each run's net pay debit and tax debit, a deposit in and a vendor's payment. */
export function bankRows(): { date: string; what: string; out?: number; in?: number }[] {
  return [
    ...RUNS.flatMap((r) => [
      { date: r.debitDate, what: 'ACH DEBIT PAYPEOPLE PAYROLL NET PAY', out: totalsOf(r).net },
      { date: r.debitDate, what: 'ACH DEBIT PAYPEOPLE PAYROLL TAXES', out: totalsOf(r).taxDebit },
    ]),
    { date: '2026-09-14', what: 'ACH CREDIT DEMO WORKFORCE BOARD REIMB', in: DEPOSIT_IN },
    { date: VENDOR.date, what: VENDOR.what, out: VENDOR.out },
  ].sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * The bank's September statement as a bank prints payroll: each run's pay as one ACH debit of its register's direct
 * deposits, its taxes as another, and unrelated lines (a deposit in, a vendor's payment). No line names anyone.
 */
export function bankStatementPdf(): Promise<Buffer> {
  const at = [48, 120, 430, 510]
  const rows = bankRows()
  const out = cents(rows.reduce((t, r) => t + (r.out ?? 0) - (r.in ?? 0), 0))
  return layoutPdf(
    BANK,
    [
      [`Business checking statement · ${COMPANY} · account ending 0000`],
      ['Statement period', '09/01/2026', '-', '09/30/2026'],
      ['Beginning balance', money(25000)],
      null,
      { at, cells: ['Date', 'Description', 'Withdrawals', 'Deposits'] },
      ...rows.map((r) => ({
        at,
        cells: [
          us(r.date),
          r.what,
          r.out != null ? money(r.out) : '',
          r.in != null ? money(r.in) : '',
        ],
      })),
      null,
      ['Ending balance', money(cents(25000 - out))],
    ],
    SAMPLE_FOOTER
  )
}

/** The grant programs the sample's payroll details charges, as its rows name the job. */
export const PROGRAM_JOBS = {
  isy: 'Demo Workforce Board (In-School Youth Coding Pathway)',
  ait: 'Demo Workforce Board (Adult IT Training)',
}

/**
 * Who payroll details charges to a grant program, and how much of their gross goes to each job: everyone the runs pay
 * except Taylor Brooks (general operations) and Alex Rivera (Summer Youth), whose pay reaches no engagement in the
 * sample either. Morgan Lee works on both programs, half each.
 */
const SPLITS: Record<string, [string, number][]> = {
  'Morgan Lee': [
    [PROGRAM_JOBS.isy, 0.5],
    [PROGRAM_JOBS.ait, 0.5],
  ],
  'Priya Shah': [[PROGRAM_JOBS.isy, 1]],
  'Sam Ortiz': [[PROGRAM_JOBS.ait, 1]],
  'Jordan Sample': [[PROGRAM_JOBS.isy, 1]],
  'Riley Example': [[PROGRAM_JOBS.isy, 1]],
  'Casey Demo': [[PROGRAM_JOBS.isy, 1]],
}

/** "Aug 24th", as the payroll company's descriptions print a day. */
const dayWords = (iso: string) => {
  const d = Number(iso.slice(8, 10))
  const th =
    d % 10 === 1 && d !== 11
      ? 'st'
      : d % 10 === 2 && d !== 12
        ? 'nd'
        : d % 10 === 3 && d !== 13
          ? 'rd'
          : 'th'
  const month = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ][Number(iso.slice(5, 7)) - 1]
  return `${month} ${d}${th}`
}

/** One charge of payroll details: a person's share of one run's pay (or its employer taxes) on one job. */
export interface SampleCharge {
  run: SampleRun
  name: string
  job: string
  wex: boolean
  tax: boolean
  amount: number
}

/** Every charge payroll details holds: each run's pay rows and their employer-tax rows, per person and job. */
export function chargesOfSample(): SampleCharge[] {
  return RUNS.flatMap((run) =>
    run.people.flatMap((p) =>
      (SPLITS[p.name] ?? []).flatMap(([job, share]) => {
        const pay = cents(p.gross * share)
        const wex = p.group === 'Work experience'
        return [
          { run, name: p.name, job, wex, tax: false, amount: pay },
          { run, name: p.name, job, wex, tax: true, amount: cents(pay * 0.0765) },
        ]
      })
    )
  )
}

/**
 * Payroll details for September, as the payroll company exports the program's share of each run: a group heading per
 * run and account ("09.11 Salaries - Employees"), then a row per person and job with the date, the company, the
 * description ("[PayPeople] Salary for <job> jobs for <name>. Payroll run: Aug 24th - Sep 6th: <company>"), the
 * account and the amount charged. Its pay adds up to the registers' gross for everyone it charges.
 */
export async function payrollDetailsXlsx(): Promise<Buffer> {
  const book = new ExcelJS.Workbook()
  // Fixed, so the same sample always makes the same file.
  book.created = book.modified = new Date('2026-10-01T12:00:00Z')
  const sheet = book.addWorksheet('September 2026 payroll details')
  sheet.columns = [
    { width: 26 },
    { width: 12 },
    { width: 12 },
    { width: 96 },
    { width: 72 },
    { width: 16 },
  ]
  sheet.addRow(['Item #', 'Date', 'Vendor', 'Memo/Description', 'Account', 'Allocated Amount'])
  const ACCOUNTS = {
    staff: '63102 Payroll Expenses:Salaries, Officers & Employees:Salaries - Employees',
    wex: '63103 Payroll Expenses:Salaries, Officers & Employees:Salaries - Work Experience (WEX)',
    staffTax: '63202 Payroll Expenses:Payroll Taxes:Employees - Taxes',
    wexTax: '63203 Payroll Expenses:Payroll Taxes:Work Experience (WEX) - Taxes',
  }
  const charges = chargesOfSample()
  for (const run of RUNS)
    for (const [key, wex, tax] of [
      ['staff', false, false],
      ['wex', true, false],
      ['staffTax', false, true],
      ['wexTax', true, true],
    ] as const) {
      const rows = charges.filter((c) => c.run === run && c.wex === wex && c.tax === tax)
      if (!rows.length) continue
      const account = ACCOUNTS[key]
      sheet.addRow([`${dotted(run.payDate).slice(0, 5)} ${account.split(':').pop()}`])
      for (const c of rows)
        sheet.addRow([
          '',
          new Date(`${run.payDate}T00:00:00Z`),
          'PayPeople',
          `[PayPeople] ${tax ? 'Employer Social Security and Medicare' : 'Salary'} for ${c.job} jobs for ${c.name}. Payroll run: ${dayWords(run.start)} - ${dayWords(run.end)}: ${COMPANY}`,
          account,
          c.amount,
        ])
    }
  sheet.addRow([])
  sheet.addRow([SAMPLE_FOOTER])
  // The library stamps each part of the file with the time it was written: repacked at a fixed time, so the same sample
  // always makes the same bytes.
  const parts = unzipSync(new Uint8Array(await book.xlsx.writeBuffer()))
  const at = new Date('2026-10-01T12:00:00Z')
  return Buffer.from(
    zipSync(Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, [v, { mtime: at }]])))
  )
}

/** The sample's files: the zip's folder, the file's name, and its bytes. Each run's files, then the statement. */
export async function sampleFiles(): Promise<{ folder: string; name: string; bytes: Buffer }[]> {
  const out: { folder: string; name: string; bytes: Buffer }[] = []
  for (const run of RUNS) {
    out.push({
      folder: 'Timesheets',
      name: `Time report ${dotted(run.start)} - ${dotted(run.end)}.pdf`,
      bytes: await timesheetPdf(run),
    })
    out.push({
      folder: 'Payroll registers',
      name: `Payroll register ${dotted(run.payDate)}.pdf`,
      bytes: await registerPdf(run),
    })
    for (const p of stubsOf(run))
      out.push({
        folder: 'Pay stubs',
        name: `Pay stub ${p.name} ${dotted(run.payDate)}.pdf`,
        bytes: await stubPdf(run, p),
      })
  }
  out.push({
    folder: 'Bank statements',
    name: 'Lakeside Community Bank statement 2026-09.pdf',
    bytes: await bankStatementPdf(),
  })
  out.push({
    folder: 'Payroll details',
    name: 'Payroll details 2026-09.xlsx',
    bytes: await payrollDetailsXlsx(),
  })
  return out
}
