import { DEFAULT_HIGHLIGHTS } from '@ad/types'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  PARTICIPANTS,
  RUNS,
  sampleFiles,
  STAFF,
  stubsOf,
  totalsOf,
  UNLISTED_PARTICIPANT,
  UNLISTED_STAFF,
  VENDOR,
} from '../../prisma/payroll-workspace-sample'
import { dbTestsEnabled } from '../core/testing/tenant-db'
import { payLinesOf } from './pay-lines'
import { payMonthOf, payRunsOf } from './pay-runs'
import {
  findStaff,
  payOnRow,
  payUnclearLines,
  planMatch,
  readStub,
  registerLayout,
  severalPeopleLines,
  type MatchFile,
  type MatchMonth,
  type ParticipantRow,
  type StaffRow,
} from './staff-match'
import { chargedPayOf, chargesOf, sheetLines } from './payroll-details'
import type { StatementLine } from '@ad/types'
import { linesWithAmount, readStatement } from './statement-lines'
import { sharedOvercharged, unlistedPeople } from './workspace-payroll.service'

// The workspace payroll sample (docs/samples/payroll-2026-09-workspace, zipped as
// apps/web/public/samples/payroll-workspace-sample.zip) read by the app's own readers, as the workspace payroll match
// reads an upload: two pay runs paid in September (run 1's pay period starts in August), each with its own register,
// time report, pay stubs and bank debits. pdf.js needs Node's VM modules, as the database specs do (`npm test` sets the
// flag).
const suite = dbTestsEnabled ? describe : describe.skip
const DIR = join(__dirname, '../../../../docs/samples/payroll-2026-09-workspace')
const KIND: Record<string, MatchFile['kind']> = {
  Timesheets: 'timesheet',
  'Payroll registers': 'payroll-register',
  'Pay stubs': 'paystub',
  'Bank statements': 'bank-statement',
}
const [RUN1, RUN2] = RUNS as [(typeof RUNS)[0], (typeof RUNS)[0]]
const dollars = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2 })}`
/** A person's September pay: what both runs paid them. */
const septemberGross = (name: string) =>
  RUNS.flatMap((r) => r.people)
    .filter((p) => p.name === name)
    .reduce((t, p) => t + p.gross, 0)

suite('the workspace payroll sample', () => {
  let files: MatchFile[]
  let details: StatementLine[] = []
  const staff: StaffRow[] = STAFF.map((s, i) => ({
    id: `s-${i}`,
    name: s.name,
    engagementIds: s.name === 'Morgan Lee' ? ['e-isy', 'e-ait'] : [i === 1 ? 'e-isy' : 'e-ait'],
  }))
  const participants: ParticipantRow[] = PARTICIPANTS.map((name, i) => ({
    id: `p-${i}`,
    engagementId: 'e-isy',
    displayName: name,
    participantId: `P-${100 + i}`,
  }))
  const of = (kind: MatchFile['kind']) => files.filter((f) => f.kind === kind)
  const named = (kind: MatchFile['kind'], text: string) =>
    files.find((f) => f.kind === kind && f.fileName.includes(text))!
  // In-School Youth's staff line paid on run 2's pay date; Adult IT's a month-end charge, paid by both runs.
  const months: MatchMonth[] = [
    {
      reportId: 'r-isy',
      engagementId: 'e-isy',
      engagementName: 'In-School Youth Coding Pathway',
      status: 'draft',
      staffItems: [{ id: 'x-isy', date: '2026-09-25' }],
    },
    {
      reportId: 'r-ait',
      engagementId: 'e-ait',
      engagementName: 'Adult IT Training',
      status: 'draft',
      staffItems: [{ id: 'x-ait', date: '2026-09-30' }],
    },
  ]
  const plan = (period = '2026-09') =>
    planMatch({
      files,
      period,
      staff,
      participants,
      months,
      wex: [],
      highlight: DEFAULT_HIGHLIGHTS,
    })

  beforeAll(async () => {
    const made = await sampleFiles()
    files = []
    for (const [i, f] of made.entries()) {
      const committed = readFileSync(join(DIR, f.folder, f.name))
      // The committed files are what the generator makes now (run `npm run sample:payroll -w @ad/api` after a change).
      expect(committed.equals(f.bytes)).toBe(true)
      // Payroll details is a sheet, read on its own below; the match tests here run on the PDFs.
      if (f.folder === 'Payroll details') {
        details = await sheetLines(committed)
        continue
      }
      const text = await readStatement(committed)
      expect(text.scanned).toBe(false)
      files.push({
        id: `f-${i}`,
        documentId: null,
        kind: KIND[f.folder]!,
        fileName: f.name,
        lines: text.lines,
        items: text.items,
      })
    }
  })

  it('holds two runs: a time report, a register and pay stubs each, and one bank statement', () => {
    expect(files.map((f) => f.fileName)).toEqual([
      'Time report 08.24.2026 - 09.06.2026.pdf',
      'Payroll register 09.11.2026.pdf',
      'Pay stub Jordan Sample 09.11.2026.pdf',
      'Pay stub Riley Example 09.11.2026.pdf',
      'Pay stub Casey Demo 09.11.2026.pdf',
      'Time report 09.07.2026 - 09.20.2026.pdf',
      'Payroll register 09.25.2026.pdf',
      'Pay stub Jordan Sample 09.25.2026.pdf',
      'Pay stub Riley Example 09.25.2026.pdf',
      'Pay stub Casey Demo 09.25.2026.pdf',
      'Pay stub Alex Rivera 09.25.2026.pdf',
      'Lakeside Community Bank statement 2026-09.pdf',
    ])
    for (const f of files)
      expect(f.lines.map((l) => l.text)).toContain(
        'SAMPLE - fictional data for trying Audit Differently'
      )
  })

  it("charges in payroll details only the grant's people, each run's pay adding up to their register gross", () => {
    const charges = chargesOf(details)
    const names = new Set(charges.map((c) => c.name))
    expect([...names].sort()).toEqual(
      [
        'Casey Demo',
        'Jordan Sample',
        'Morgan Lee',
        'Priya Shah',
        'Riley Example',
        'Sam Ortiz',
      ].sort()
    )
    expect(names.has(UNLISTED_STAFF.name)).toBe(false)
    expect(names.has(UNLISTED_PARTICIPANT)).toBe(false)
    for (const run of RUNS)
      for (const p of run.people.filter((x) => names.has(x.name))) {
        const paid = chargedPayOf(charges, p.name).find((c) => c.end === run.end)
        expect([p.name, run.n, paid?.start, paid?.amount]).toEqual([
          p.name,
          run.n,
          run.start,
          p.gross,
        ])
      }
    // Morgan Lee works on both programs: half of each run on each job.
    expect(
      charges
        .filter((c) => c.name === 'Morgan Lee' && c.pay && c.end === RUN1.end)
        .map((c) => c.amount)
    ).toEqual([600, 600])
    // Work-experience pay is booked as such; the employer's taxes are not anyone's pay.
    expect(charges.filter((c) => c.wex && c.pay).map((c) => c.name)).toEqual(
      expect.arrayContaining(PARTICIPANTS)
    )
    expect(charges.filter((c) => /Social Security/.test(c.type)).every((c) => !c.pay)).toBe(true)
  })

  it("reads each register row's gross from its labelled column, never the larger year-to-date amount", () => {
    for (const run of RUNS) {
      const register = named(
        'payroll-register',
        `${run.payDate.slice(5, 7)}.${run.payDate.slice(8)}`
      )
      const layout = registerLayout(register.lines)
      expect(layout.columns).toEqual(['gross', 'other', 'net', 'ytd'])
      const rows = payLinesOf(register).map((l) => l!.text)
      // One pay per person; the heading, the pay period, the totals and what is debited are no one's pay.
      expect(rows).toHaveLength(run.people.length)
      for (const p of run.people) {
        const row = rows.find((r) => r.startsWith(p.name))!
        expect(p.ytdGross).toBeGreaterThan(p.gross)
        expect(payOnRow(row, layout)).toEqual({ amount: p.gross, unclear: false })
      }
      expect(payUnclearLines(register).size).toBe(0)
    }
    expect(RUN1.people).toHaveLength(7)
    expect(RUN2.people).toHaveLength(8)
  })

  it("reads each run and finds its own debit, near its own pay date: run 1's period starts in August, paid in September", () => {
    const runs = payRunsOf(files)
    const [bank] = of('bank-statement')
    expect(
      runs.map((r) => [r.payDate, r.start, r.end, r.totals, payMonthOf(r), r.debit?.line.text])
    ).toEqual(
      RUNS.map((run) => [
        run.payDate,
        run.start,
        run.end,
        [totalsOf(run).net],
        '2026-09',
        `${run.debitDate.slice(5, 7)}/${run.debitDate.slice(8)}/2026 ACH DEBIT PAYPEOPLE PAYROLL NET PAY ${dollars(totalsOf(run).net)}`,
      ])
    )
    expect(runs.every((r) => r.debit?.fileId === bank!.id)).toBe(true)
    // Each run's total is on its own debit only.
    expect(totalsOf(RUN1).net).not.toBe(totalsOf(RUN2).net)
    expect(RUN1.start.slice(0, 7)).toBe('2026-08')
  })

  it("finds each staff member's two register rows and time reports, and each run's debit, adding up September's pay", () => {
    const found = findStaff(staff, files, participants)
    const runs = payRunsOf(files)
    for (const [i, s] of STAFF.entries()) {
      const f = found[i]!
      expect(f.pay).toBe(septemberGross(s.name))
      expect(f.register.map((r) => r.runId)).toEqual(runs.map((r) => r.fileId))
      expect(f.timesheet.map((t) => t.runId)).toEqual(runs.map((r) => r.fileId))
      // Their bank lines are the two debits, each of its own run: no line names anyone.
      expect(f.bank.map((b) => [b.runId, b.line, b.amount, b.run])).toEqual(
        runs.map((r) => [r.fileId, r.debit!.line, r.debit!.amount, true])
      )
      expect(f.bankGuess).toEqual([])
    }
    expect(found.map((f) => f.pay)).toEqual([2400, 1800, 2000])
    expect(severalPeopleLines(files, staff, participants).size).toBe(0)
  })

  it("links each staff line to the run that paid it: on its pay date one run's, a month-end charge both", () => {
    const p = plan()
    const [r1, r2] = payRunsOf(files)
    const proofsOf = (item: string) =>
      p.links
        .filter((l) => l.itemId === item)
        .map((l) => [l.slot, l.fileId])
        .sort()
    const ts = (run: (typeof RUNS)[0]) =>
      named('timesheet', `${run.start.slice(5, 7)}.${run.start.slice(8)}`).id
    expect(proofsOf('x-isy')).toEqual(
      [
        ['timesheet', ts(RUN2)],
        ['register', r2!.fileId],
        ['bank', r2!.debit!.fileId],
      ].sort()
    )
    const isyBank = p.links.find((l) => l.itemId === 'x-isy' && l.slot === 'bank')!
    expect(isyBank.mark).toBe(r2!.debit!.line)
    // Adult IT's month-end line: both runs' time reports and registers, and the statement (both debits highlighted).
    expect(proofsOf('x-ait')).toEqual(
      [
        ['timesheet', ts(RUN1)],
        ['timesheet', ts(RUN2)],
        ['register', r1!.fileId],
        ['register', r2!.fileId],
        ['bank', r1!.debit!.fileId],
      ].sort()
    )
  })

  it("makes one payment per participant and run from its pay stub, with its own run's proofs and debit", () => {
    const p = plan()
    const runs = payRunsOf(files)
    for (const run of RUNS)
      for (const person of stubsOf(run)) {
        const stub = named(
          'paystub',
          `${person.name} ${run.payDate.slice(5, 7)}.${run.payDate.slice(8)}`
        )
        expect(readStub(stub.lines)).toMatchObject({
          start: run.start,
          end: run.end,
          payDate: run.payDate,
          gross: person.gross,
          net: person.net,
          grossUnclear: false,
        })
      }
    expect(
      p.stubs.map((s) => [
        s.named,
        s.participant?.displayName ?? null,
        s.action,
        s.flags,
        s.reading.start,
      ])
    ).toEqual([
      ...PARTICIPANTS.map((n) => [n, n, 'create', [], RUN1.start]),
      ...PARTICIPANTS.map((n) => [n, n, 'create', [], RUN2.start]),
      [UNLISTED_PARTICIPANT, null, 'none', ['no-participant'], RUN2.start],
    ])
    // Each payment's proofs are its run's: its time report, its register row, and its run's debit.
    for (const s of p.stubs.filter((x) => x.action === 'create')) {
      const run = runs.find((r) => r.start === s.reading.start)!
      expect(s.debit?.line).toBe(run.debit!.line)
      const mine = p.links.filter((l) => l.stubFileId === s.fileId)
      expect(mine.map((l) => l.slot)).toEqual(['stub', 'timesheet', 'register', 'bank'])
      expect(mine.find((l) => l.slot === 'register')!.fileId).toBe(run.fileId)
      expect(mine.find((l) => l.slot === 'bank')!.mark).toBe(run.debit!.line)
      expect(
        files.find((f) => f.id === mine.find((l) => l.slot === 'timesheet')!.fileId)!.fileName
      ).toContain(`${run.start!.slice(5, 7)}.${run.start!.slice(8)}`)
    }
  })

  it("places a pay by the month it was paid in: as August's, run 1 (paid 09/11) is another month's", () => {
    const p = plan('2026-08')
    // Every pay stub was paid in September: none is August's.
    expect(p.stubs.every((s) => s.flags.includes('other-month') && s.action === 'none')).toBe(true)
    // No register of September counts for August's staff.
    expect(p.staff.every((f) => !f.register.length && !f.bank.length)).toBe(true)
  })

  it('lists Taylor Brooks as on the registers and not on the staff list, and Alex Rivera nowhere among staff', () => {
    const unlisted = unlistedPeople(plan(), files, staff, participants)
    expect(unlisted.map((u) => [u.name, u.register.length, u.timesheet.length])).toEqual([
      [UNLISTED_STAFF.name, 2, 2],
    ])
  })

  it("covers each demo engagement's September staff charge on its own, and flags the two together (the seed's tour)", () => {
    const found = findStaff(staff, files, participants)
    const payOf = new Map(found.map((f) => [f.staff.id, f.pay]))
    // prisma/seed.ts: In-School Youth RYS-18 + RYS-20 + RYS-21, Adult IT AIT-1 + AIT-3 (a charge per run).
    const cards = [
      { engagementId: 'e-isy', engagementName: 'In-School Youth Coding Pathway', charged: 3600 },
      { engagementId: 'e-ait', engagementName: 'Adult IT Training', charged: 3800 },
    ]
    for (const c of cards) {
      const pay = found
        .filter((f) => f.staff.engagementIds.includes(c.engagementId))
        .reduce((t, f) => t + (f.pay ?? 0), 0)
      expect([c.engagementId, pay, c.charged <= pay]).toEqual([
        c.engagementId,
        c.engagementId === 'e-isy' ? 4200 : 4400,
        true,
      ])
    }
    // Each run's charge (the seed dates one per run) is within that run's pay of the staff tagged to its engagement.
    const runPay = (run: (typeof RUNS)[0], engagementId: string) =>
      run.people
        .filter((p) =>
          staff.some((x) => x.name === p.name && x.engagementIds.includes(engagementId))
        )
        .reduce((t, p) => t + p.gross, 0)
    const charges = { 'e-isy': [1500, 600 + 1500], 'e-ait': [1900, 1900] }
    for (const [id, [run1, run2]] of Object.entries(charges)) {
      expect(run1! <= runPay(RUN1, id)).toBe(true)
      expect(run2! <= runPay(RUN2, id)).toBe(true)
    }
    expect([runPay(RUN1, 'e-isy'), runPay(RUN2, 'e-isy'), runPay(RUN1, 'e-ait')]).toEqual([
      2055, 2145, 2200,
    ])
    expect(sharedOvercharged(cards, staff, payOf)).toEqual([
      {
        engagements: [
          { id: 'e-ait', name: 'Adult IT Training' },
          { id: 'e-isy', name: 'In-School Youth Coding Pathway' },
        ],
      },
    ])
  })

  it("shows each run's pay as one debit and its taxes as another, with the vendor payment, never the deposit in", () => {
    const [bank] = of('bank-statement')
    const pays = payLinesOf(bank!).map((l) => l!.text)
    const line = (date: string, what: string, n: number) =>
      `${date.slice(5, 7)}/${date.slice(8)}/2026 ${what} ${dollars(n)}`
    expect(pays).toEqual([
      line(RUN1.debitDate, 'ACH DEBIT PAYPEOPLE PAYROLL NET PAY', totalsOf(RUN1).net),
      line(RUN1.debitDate, 'ACH DEBIT PAYPEOPLE PAYROLL TAXES', totalsOf(RUN1).taxDebit),
      line(VENDOR.date, VENDOR.what, VENDOR.out),
      line(RUN2.debitDate, 'ACH DEBIT PAYPEOPLE PAYROLL NET PAY', totalsOf(RUN2).net),
      line(RUN2.debitDate, 'ACH DEBIT PAYPEOPLE PAYROLL TAXES', totalsOf(RUN2).taxDebit),
    ])
    for (const p of RUNS.flatMap((r) => r.people)) {
      expect(pays.some((t) => t.includes(p.name.toUpperCase()))).toBe(false)
      expect(linesWithAmount(bank!.lines, p.net)).toEqual([])
    }
  })
})
