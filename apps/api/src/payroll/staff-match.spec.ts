import { DEFAULT_HIGHLIGHTS, type StatementLine } from '@ad/types'
import { personIn } from './match-proof'
import {
  amountsOn,
  findStaff,
  hasNumber,
  participantOf,
  payOnRow,
  payUnclearLines,
  planMatch,
  readStub,
  registerLayout,
  printedName,
  registerPerson,
  severalPeopleLines,
  stubName,
  type MatchFile,
  type MatchMonth,
  type MatchWex,
  type ParticipantRow,
  type StaffRow,
} from './staff-match'

/** Fictional people, programs and pay throughout. */
const at = (text: string, i: number, page = 1): StatementLine => ({
  page,
  x: 40,
  y: 700 - i * 18,
  width: 400,
  height: 12,
  text,
})
const file = (
  id: string,
  kind: MatchFile['kind'],
  texts: string[],
  fileName = `${id}.pdf`,
  documentId: string | null = null
): MatchFile => ({ id, documentId, kind, fileName, lines: texts.map((t, i) => at(t, i)) })

const register = file('f-reg', 'payroll-register', [
  'Payroll register',
  'Pay period 03/01/2027 - 03/15/2027',
  'Emp # Name Hours Rate Gross Net',
  '1042 Morgan Lee 80.00 25.00 2,000.00 1,640.22',
  '1043 Avery Stone 80.00 30.00 2,400.00 1,951.10',
  '2001 Jordan Sample 20.00 14.00 280.00 258.58',
  'Taylor Brook 40.00 20.00 800.00 690.00',
  'Totals 220.00 5,480.00 4,539.90',
])
const bank = file('f-bank', 'bank-statement', [
  'Statement of account',
  '03/16 ACH PAYROLL MORGAN LEE 1,640.22',
  '03/16 ACH PAYROLL AVERY STONE 1,951.10',
  '03/16 ACH PAYROLL JORDAN SAMPLE 250.00',
  '03/16 Deposit 9,000.00',
  'Ending balance 12,345.67',
])
const timesheet = file('f-ts', 'timesheet', ['Timesheet', 'Employee: Morgan Lee', 'Total hours 80'])
const timesheetByName = file('f-ts2', 'timesheet', [], 'Avery-Stone_timesheet_March.pdf')
const stub = file('f-stub', 'paystub', [
  'Earnings statement',
  'Jordan Sample   Participant P-2001',
  'Pay period 03/01/2027 - 03/15/2027',
  'Earnings Current YTD',
  'Gross pay 280.00 1,120.00',
  'Net pay 258.58',
])

const morgan: StaffRow = {
  id: 's-morgan',
  name: 'Morgan Lee',
  engagementIds: ['e-isy', 'e-osy'],
}
const avery: StaffRow = {
  id: 's-avery',
  name: 'Avery Stone',
  engagementIds: ['e-isy'],
}
const riley: StaffRow = {
  id: 's-riley',
  name: 'Riley Example',
  engagementIds: [],
}
const jordan: ParticipantRow = {
  id: 'p-jordan',
  engagementId: 'e-isy',
  displayName: 'Jordan Sample',
  participantId: 'P-2001',
}

const month = (
  engagementId: string,
  name: string,
  staffItems: string[],
  status: MatchMonth['status'] = 'draft'
): MatchMonth => ({
  reportId: `r-${engagementId}`,
  engagementId,
  engagementName: name,
  status,
  staffItems: staffItems.map((id) => ({ id })),
})
const months = [
  month('e-isy', 'In-School Youth Coding Pathway', ['x-isy-sal', 'x-isy-fringe']),
  month('e-osy', 'Out-of-School Youth Bridge', ['x-osy-sal']),
]

describe('staff-match', () => {
  it('reads amounts, a register row’s pay and a participant id as a word of its own', () => {
    expect(amountsOn('1042 Morgan Lee 80.00 25.00 2,000.00 1,640.22')).toEqual([
      80, 25, 2000, 1640.22,
    ])
    const layout = registerLayout(register.lines)
    expect(payOnRow('1042 Morgan Lee 80.00 25.00 2,000.00 1,640.22', layout)).toEqual({
      amount: 2000,
      unclear: false,
    })
    expect(payOnRow('Morgan Lee').amount).toBeNull()
    expect(hasNumber('1042 Morgan Lee', '1042')).toBe(true)
    expect(hasNumber('21042 Morgan Lee', '1042')).toBe(false)
    expect(hasNumber('Morgan Lee 1042.00', '1042')).toBe(false)
  })

  it('finds each person by name, with their timesheet and bank line', () => {
    const [m, a, r] = findStaff(
      [morgan, avery, riley],
      [register, bank, timesheet, timesheetByName]
    )
    expect(m!.register.map((x) => x.line?.text)).toEqual([
      '1042 Morgan Lee 80.00 25.00 2,000.00 1,640.22',
    ])
    expect(m!.pay).toBe(2000)
    expect(m!.timesheet.map((x) => [x.fileId, x.line?.text])).toEqual([
      ['f-ts', 'Employee: Morgan Lee'],
    ])
    // The bank line that names them, with the register's net.
    expect(m!.bank.map((x) => [x.line?.text, x.amount])).toEqual([
      ['03/16 ACH PAYROLL MORGAN LEE 1,640.22', 1640.22],
    ])
    // A timesheet naming them in its file name alone is not theirs: file names are not enforced (owner, 2026-10-19).
    expect(a!.register.map((x) => x.amount)).toEqual([2400])
    expect(a!.timesheet).toEqual([])
    expect(a!.bank).toHaveLength(1)
    // On the list but in no file.
    expect(r).toMatchObject({ register: [], timesheet: [], bank: [], pay: null })
  })

  it('finds a bank line by the register’s amount when no line names the person, only when one line has it', () => {
    const anon = file('f-bank2', 'bank-statement', [
      '03/16 ACH PAYROLL 1,640.22',
      '03/16 ACH PAYROLL 1,951.10',
    ])
    const [m] = findStaff([morgan], [register, anon])
    // A guess for the owner to confirm, never sure proof.
    expect(m!.bank).toEqual([])
    expect(m!.bankGuess.map((x) => x.line?.text)).toEqual(['03/16 ACH PAYROLL 1,640.22'])
    const twice = file('f-bank3', 'bank-statement', ['03/16 ACH 1,640.22', '03/17 ACH 1,640.22'])
    expect(findStaff([morgan], [register, twice])[0]!.bankGuess).toEqual([])
  })

  it('leaves a row two people fit equally to no one, and flags it', () => {
    // Two people of one name, told apart on the list by a note in brackets: the files print the name alone.
    const twin = { ...morgan, id: 's-lee2', name: 'Morgan Lee (Adult IT)' }
    const reg = file('f-r', 'payroll-register', ['Morgan Lee 80.00 2,000.00'])
    const pays = file('f-b', 'bank-statement', ['03/16 ACH PAYROLL MORGAN LEE 1,640.22'])
    const ts = file('f-t', 'timesheet', ['Employee: Morgan Lee'], 'Morgan Lee timesheet.pdf')
    const [a, b] = findStaff([morgan, twin], [reg, pays, ts])
    for (const x of [a!, b!])
      expect(x).toMatchObject({ register: [], bank: [], bankGuess: [], timesheet: [], pay: null })
    expect([...severalPeopleLines([reg, pays], [morgan, twin], [])].map((l) => l.text)).toEqual([
      'Morgan Lee 80.00 2,000.00',
      '03/16 ACH PAYROLL MORGAN LEE 1,640.22',
    ])
    // Nothing of theirs is linked to an engagement.
    const p = planMatch({
      files: [reg, pays, ts],
      staff: [morgan, twin],
      participants: [],
      months,
      wex: [],
      highlight: DEFAULT_HIGHLIGHTS,
    })
    expect(p.links).toEqual([])
    // "Lee Morgan" is not Morgan Lee: the row is Morgan's alone.
    const lee = { ...morgan, id: 's-lee3', name: 'Lee Morgan' }
    expect(findStaff([morgan, lee], [reg])[0]!.register).toHaveLength(1)
  })

  it('leaves a line a staff member and a participant both fit to no one, and flags it', () => {
    const staffJordan: StaffRow = {
      id: 's-j',
      name: 'Jordan Sample (staff)',
      engagementIds: ['e-isy'],
    }
    const reg = file('f-r', 'payroll-register', ['Jordan Sample 20.00 280.00'])
    const pays = file('f-b', 'bank-statement', ['03/16 ACH PAYROLL JORDAN SAMPLE 258.58'])
    const [j] = findStaff([staffJordan], [reg, pays], [jordan])
    expect(j).toMatchObject({ register: [], bank: [], bankGuess: [] })
    expect(severalPeopleLines([reg, pays], [staffJordan], [jordan]).size).toBe(2)
    // Without the participant, the lines are the staff member's.
    expect(findStaff([staffJordan], [reg, pays])[0]!.register).toHaveLength(1)
  })

  it('matches a name by what the files print, without a note in brackets at its end', () => {
    expect(printedName('Morgan Lee (Adult IT)')).toBe('Morgan Lee')
    expect(printedName('Morgan Lee')).toBe('Morgan Lee')
    expect(printedName('(Adult IT)')).toBe('(Adult IT)')
    const [m] = findStaff([{ ...morgan, name: 'Morgan Lee (Adult IT)' }], [register])
    expect(m!.pay).toBe(2000)
  })

  it('reads a pay stub’s pay period, gross and net, and leaves what it does not print empty', () => {
    expect(readStub(stub.lines)).toMatchObject({
      start: '2027-03-01',
      end: '2027-03-15',
      gross: 280,
      net: 258.58,
    })
    expect(readStub(file('x', 'paystub', ['Jordan Sample', 'Net pay 258.58']).lines)).toMatchObject(
      {
        start: null,
        gross: null,
        net: 258.58,
      }
    )
  })

  it('finds the participant a stub names, by their participant id among several, and flags nobody or two', () => {
    expect(participantOf(stub, [jordan]).participant?.id).toBe('p-jordan')
    const twin = { ...jordan, id: 'p-jordan-osy', engagementId: 'e-osy', participantId: 'P-9999' }
    expect(participantOf(stub, [jordan, twin]).participant?.id).toBe('p-jordan')
    const twin2 = { ...twin, participantId: 'P-8888' }
    const noId = file('f-s2', 'paystub', [
      'Jordan Sample',
      'Pay period 03/01/2027 - 03/15/2027',
      'Gross pay 280.00',
    ])
    expect(participantOf(noId, [jordan, twin2])).toEqual({
      participant: null,
      flag: 'several-participants',
    })
    expect(participantOf(noId, [])).toEqual({ participant: null, flag: 'no-participant' })
  })

  describe('the plan', () => {
    const plan = (over: Partial<Parameters<typeof planMatch>[0]> = {}) =>
      planMatch({
        files: [register, bank, timesheet, timesheetByName, stub],
        staff: [morgan, avery, riley],
        participants: [jordan],
        months,
        wex: [],
        highlight: DEFAULT_HIGHLIGHTS,
        ...over,
      })

    it('links a person on two engagements to the staff payroll lines of both, and no one else’s', () => {
      const p = plan()
      const morganLinks = p.links
        .filter(
          (l) => l.target === 'expense' && l.marks.some((m) => /Morgan|MORGAN/.test(m.text ?? ''))
        )
        .map((l) => [l.itemId, l.fileId, l.purpose])
      expect(morganLinks).toEqual(
        expect.arrayContaining([
          ['x-isy-sal', 'f-reg', 'register'],
          ['x-isy-fringe', 'f-reg', 'register'],
          ['x-osy-sal', 'f-reg', 'register'],
          ['x-osy-sal', 'f-bank', 'payment'],
          ['x-osy-sal', 'f-ts', 'timesheet'],
        ])
      )
      // Avery is on In-School Youth only.
      expect(p.links.some((l) => l.itemId === 'x-osy-sal' && l.fileId === 'f-ts2')).toBe(false)
      // Nor In-School Youth: a timesheet with no lines names nobody, whatever its file name.
      expect(p.links.some((l) => l.itemId === 'x-isy-sal' && l.fileId === 'f-ts2')).toBe(false)
      // One link per line and file, carrying both people's rows on the shared register.
      const shared = p.links.find((l) => l.itemId === 'x-isy-sal' && l.fileId === 'f-reg')!
      expect(shared.marks.map((m) => m.text)).toEqual([
        '1042 Morgan Lee 80.00 25.00 2,000.00 1,640.22',
        '1043 Avery Stone 80.00 30.00 2,400.00 1,951.10',
      ])
      expect(shared.mark?.text).toMatch(/^1042 Morgan Lee/)
      // Every bank link has its line.
      expect(p.links.filter((l) => l.slot === 'bank').every((l) => !!l.mark)).toBe(true)
    })

    it("makes a participant's payment from their stub, on their engagement's month, with its proofs", () => {
      const p = plan()
      expect(p.stubs).toHaveLength(1)
      expect(p.stubs[0]).toMatchObject({
        action: 'create',
        wexId: null,
        participant: { id: 'p-jordan' },
        month: { reportId: 'r-e-isy' },
        reading: { start: '2027-03-01', end: '2027-03-15', gross: 280 },
      })
      // The register pays Jordan 280.00, as the stub says: nothing to flag (the bank's 250.00 line is not compared).
      expect(p.stubs[0]!.flags).toEqual([])
      expect(p.stubs[0]!.debit).toBeNull()
      const wex = p.links
        .filter((l) => l.target === 'wex')
        .map((l) => [l.stubFileId, l.fileId, l.purpose])
      expect(wex).toEqual([
        ['f-stub', 'f-stub', 'payment'],
        ['f-stub', 'f-reg', 'register'],
      ])
    })

    it('flags a stub whose pay is not what the register pays them, and still makes the payment', () => {
      const other = file('f-reg', 'payroll-register', [
        ...register.lines.map((l) => l.text.replace('280.00 258.58', '300.00 277.05')),
      ])
      const p = plan({ files: [other, bank, timesheet, timesheetByName, stub] })
      expect(p.stubs[0]).toMatchObject({ action: 'create', flags: ['register-disagrees'] })
    })

    it("links the pay run's one debit as the bank line of every item it paid: staff lines and payments", () => {
      const debit = file('f-bank', 'bank-statement', [
        'Statement of account',
        '03/16 ACH DEBIT PAYPEOPLE PAYROLL 4,539.90',
        '03/16 ACH DEBIT PAYPEOPLE TAXES 1,200.00',
        '03/16 Deposit 9,000.00',
      ])
      const p = plan({ files: [register, debit, timesheet, timesheetByName, stub] })
      const line = debit.lines[1]!
      for (const f of p.staff.filter((x) => x.register.length))
        expect(f.bank).toEqual([
          { fileId: 'f-bank', line, amount: 4539.9, run: true, runId: 'f-reg' },
        ])
      expect(p.staff.every((f) => !f.bankGuess.length)).toBe(true)
      expect(p.stubs[0]!.debit).toEqual({ fileId: 'f-bank', line, amount: 4539.9, run: true })
      const bankLinks = p.links.filter((l) => l.slot === 'bank')
      expect(bankLinks.map((l) => l.itemId ?? `stub-${l.stubFileId}`).sort()).toEqual(
        ['stub-f-stub', 'x-isy-fringe', 'x-isy-sal', 'x-osy-sal'].sort()
      )
      expect(bankLinks.every((l) => l.mark === line && l.purpose === 'payment')).toBe(true)
    })

    it('changes nothing when the stub’s payment is already as it says (matching again)', () => {
      const saved = { ...stub, documentId: 'd-stub' }
      const made: MatchWex = {
        id: 'w-1',
        reportId: 'r-e-isy',
        participantRowId: 'p-jordan',
        start: '2027-03-01',
        end: '2027-03-15',
        amount: 280,
        stubDocumentId: 'd-stub',
      }
      const same = plan({ files: [register, saved], wex: [made] })
      expect(same.stubs[0]).toMatchObject({ action: 'same', wexId: 'w-1' })
      const changed = plan({ files: [register, saved], wex: [{ ...made, amount: 260 }] })
      expect(changed.stubs[0]).toMatchObject({ action: 'update', wexId: 'w-1' })
      // One typed by hand for the same participant and pay period is taken over, not doubled.
      const typed = plan({
        files: [register, stub],
        wex: [{ ...made, stubDocumentId: null, amount: 275 }],
      })
      expect(typed.stubs[0]).toMatchObject({ action: 'update', wexId: 'w-1' })
    })

    it('flags a stub it cannot read, one naming nobody on a list, and one whose engagement has no month, and makes nothing', () => {
      const unreadable = file('f-u', 'paystub', ['Jordan Sample', 'Net pay 258.58'])
      expect(plan({ files: [unreadable] }).stubs[0]).toMatchObject({
        action: 'none',
        flags: ['stub-unreadable'],
      })
      const stranger = file('f-n', 'paystub', [
        'Pat Nobody',
        'Pay period 03/01/2027 - 03/15/2027',
        'Gross pay 99.00',
      ])
      expect(plan({ files: [stranger] }).stubs[0]).toMatchObject({
        action: 'none',
        flags: ['no-participant'],
      })
      expect(plan({ files: [stub], months: [months[1]!] }).stubs[0]).toMatchObject({
        action: 'none',
        flags: ['no-month'],
      })
      expect(plan({ files: [unreadable, stranger] }).links).toEqual([])
    })

    it('links nobody’s proofs to an engagement without a month for the period, or a person on no engagement', () => {
      const p = plan({ months: [months[1]!], participants: [] })
      expect(new Set(p.links.map((l) => l.itemId))).toEqual(new Set(['x-osy-sal']))
      expect(p.links.some((l) => l.marks.some((m) => /Avery/.test(m.text ?? '')))).toBe(false)
    })
  })

  it('suggests who a register row names, by name alone: no number it prints is kept', () => {
    expect(registerPerson('1042 Morgan Lee 80.00 25.00 2,000.00 1,640.22')).toEqual({
      name: 'Morgan Lee',
    })
    expect(registerPerson('Lee, Morgan Emp E-77 2,000.00')).toEqual({ name: 'Morgan Lee' })
    expect(registerPerson('Lee, Morgan E-77 2,000.00')).toEqual({ name: 'Morgan Lee' })
    expect(registerPerson('2,000.00 1,640.22')).toBeNull()
  })
})

describe('staff-match: the owner’s review (2026-10-18)', () => {
  it("reads a stub's gross after its label, never the first number on the line (B2)", () => {
    const stubOf = (...lines: string[]) =>
      readStub(
        file('s', 'paystub', ['Jordan Sample', 'Pay period 03/01/2027 - 03/15/2027', ...lines])
          .lines
      )
    expect(stubOf('Hours 20.00 Gross pay 280.00')).toMatchObject({ gross: 280 })
    expect(stubOf('Gross: $280.00 YTD 1,120.00')).toMatchObject({ gross: 280 })
    // A year-to-date line is not this period's.
    expect(stubOf('Gross pay 280.00', 'YTD Gross 1,120.00')).toMatchObject({ gross: 280 })
    // Several amounts after the label and nothing saying which is this period's: not guessed.
    expect(stubOf('Gross pay 280.00 1,120.00')).toMatchObject({ gross: null, grossUnclear: true })
    // With a "Current … YTD" heading, the first is this period's.
    expect(stubOf('Current YTD', 'Gross pay 280.00 1,120.00')).toMatchObject({ gross: 280 })
    // Two gross lines that disagree: not guessed.
    expect(stubOf('Gross pay 280.00', 'Gross wages 300.00')).toMatchObject({
      gross: null,
      grossUnclear: true,
    })
  })

  it("shows the timesheet of the stub's pay period: its report first, else their days in a month's file", () => {
    const late = file('f-stub2', 'paystub', [
      'Earnings statement',
      'Jordan Sample   Participant P-2001',
      'Pay period 03/16/2027 - 03/31/2027',
      'Earnings Current YTD',
      'Gross pay 300.00 1,420.00',
      'Net pay 277.05',
    ])
    // A month's daily hours, both pay periods; the second period's own report.
    const daily = file('f-daily', 'timesheet', [
      'Daily hours March 2027',
      'Mar 1st - Mar 15th Jordan Sample 2027-03-03 4.00',
      'Mar 16th - Mar 31st Jordan Sample 2027-03-17 4.00',
      'Mar 16th - Mar 31st Jordan Sample 2027-03-24 4.00',
    ])
    const report = file('f-rep', 'timesheet', [
      'Time and jobs report',
      'Pay period 03/16/2027 - 03/31/2027',
      'Jordan Sample 03/16/2027 - 03/31/2027 20.00 300.00',
    ])
    const input = {
      staff: [],
      participants: [jordan],
      months,
      wex: [],
      highlight: DEFAULT_HIGHLIGHTS,
    }
    const withReport = planMatch({ ...input, files: [daily, report, late] })
    expect(withReport.stubs[0]!.timesheet).toMatchObject({ fileId: 'f-rep' })
    // Only the month's file: one of their days inside the period, never the 3rd (another period's).
    const monthOnly = planMatch({ ...input, files: [daily, late] })
    expect(monthOnly.stubs[0]!.timesheet!.line!.text).toContain('2027-03-17')
    const link = monthOnly.links.find((l) => l.fileId === 'f-daily')!
    expect(link.marks.every((m) => !(m as { text?: string }).text?.includes('2027-03-03'))).toBe(
      true
    )
  })

  it('flags a stub whose gross is ambiguous as unreadable and makes no payment (B2)', () => {
    const vague = file('f-v', 'paystub', [
      'Jordan Sample',
      'Pay period 03/01/2027 - 03/15/2027',
      'Gross pay 280.00 1,120.00',
    ])
    const p = planMatch({
      files: [vague],
      staff: [],
      participants: [jordan],
      months,
      wex: [],
      highlight: DEFAULT_HIGHLIGHTS,
    })
    expect(p.stubs[0]).toMatchObject({ action: 'none', flags: ['stub-unreadable'] })
  })

  it('matches people by their full name in order, or "Last, First", never a part of it (B3)', () => {
    expect(personIn('ACH PAYROLL MORGAN LEE 1,640.22', 'Morgan Lee')).toBe(true)
    expect(personIn('Lee, Morgan 2,000.00', 'Morgan Lee')).toBe(true)
    expect(personIn('Morgan Leeds 2,000.00', 'Morgan Lee')).toBe(false)
    expect(personIn('Lee Morgan 2,000.00', 'Morgan Lee')).toBe(false)
    // First and last names match, middle names or none (owner's decision, 2026-10-19).
    expect(personIn('Morgan J Lee', 'Morgan Lee')).toBe(true)
    expect(personIn('PAID TO: Morgan Jay Quinn Lee', 'Morgan Lee')).toBe(true)
    expect(personIn('Lee, Morgan J 2,000.00', 'Morgan Lee')).toBe(true)
    // Another first name in quotes: either one.
    expect(personIn('Casey Rae Demo', 'Jordan "Casey" Demo')).toBe(true)
    expect(personIn('Jordan Demo 280.00', 'Jordan "Casey" Demo')).toBe(true)
    expect(personIn('Riley Demo 280.00', 'Jordan "Casey" Demo')).toBe(false)
    expect(personIn('Avery-Stone timesheet', 'Avery Stone')).toBe(false)
    expect(personIn('Avery Stone timesheet March', 'Avery Stone')).toBe(true)
    // A stub that two participants fit by name, told apart by nothing: flagged, no payment.
    const twin = { ...jordan, id: 'p-j2', engagementId: 'e-osy', participantId: 'P-8888' }
    const loose = file('f-l', 'paystub', ['Sample, Jordan', 'Gross pay 280.00'])
    expect(participantOf(loose, [jordan, twin]).flag).toBe('several-participants')
    // A bank line two people fit is flagged too.
    const both = file('f-b2', 'bank-statement', ['03/16 ACH MORGAN LEE 1,640.22'])
    const other = { ...morgan, id: 's-m2', name: 'Morgan Lee (Adult IT)' }
    expect(severalPeopleLines([both], [morgan, other], []).size).toBe(1)
  })

  it('keeps a bank line found by its amount alone as a guess, never a link (B4)', () => {
    const anon = file('f-bank2', 'bank-statement', ['03/16 ACH PAYROLL 1,640.22'])
    const p = planMatch({
      files: [register, anon],
      staff: [morgan],
      participants: [],
      months,
      wex: [],
      highlight: DEFAULT_HIGHLIGHTS,
    })
    expect(p.staff[0]!.bankGuess.map((g) => g.line?.text)).toEqual(['03/16 ACH PAYROLL 1,640.22'])
    expect(p.links.some((l) => l.fileId === 'f-bank2')).toBe(false)
  })

  it("takes a register row's current gross, never a larger year-to-date amount, and flags a row it can't tell (B5)", () => {
    const ytd = file('f-ytd', 'payroll-register', [
      'Emp # Name Gross Net YTD Gross',
      '1042 Morgan Lee 2,000.00 1,640.22 24,000.00',
      'Avery Stone Gross 2,400.00 Net 1,951.10 YTD 28,800.00',
    ])
    const layout = registerLayout(ytd.lines)
    expect(layout).toEqual({ columns: ['gross', 'net', 'ytd'] })
    expect(payOnRow(ytd.lines[1]!.text, layout)).toEqual({ amount: 2000, unclear: false })
    // A label on the row itself comes first.
    expect(payOnRow(ytd.lines[2]!.text, layout)).toEqual({ amount: 2400, unclear: false })
    const [m] = findStaff([morgan], [ytd])
    expect(m!.pay).toBe(2000)
    // No heading and no label: the first amount after the name, flagged when there are several.
    expect(payOnRow('Morgan Lee 2,000.00 24,000.00')).toEqual({ amount: 2000, unclear: true })
    expect(payOnRow('Morgan Lee 2,000.00')).toEqual({ amount: 2000, unclear: false })
    const bare = file('f-bare', 'payroll-register', ['Morgan Lee 2,000.00 24,000.00'])
    expect([...payUnclearLines(bare)].map((l) => l.text)).toEqual(['Morgan Lee 2,000.00 24,000.00'])
    expect(payUnclearLines(ytd).size).toBe(0)
  })

  it('never matches a register row by a number on it, only by the full name (B6)', () => {
    // A number with another name: no one's.
    const byNumber = file('f-n', 'payroll-register', ['Emp # Name Gross', '1042 M. Lee 2,000.00'])
    expect(findStaff([morgan], [byNumber])[0]!.register).toEqual([])
    // Two of one name: no number on the row tells them apart, so the row is no one's.
    const other = { ...morgan, id: 's-m2', name: 'Morgan Lee (Adult IT)', engagementIds: ['e-osy'] }
    const headed = file('f-h', 'payroll-register', ['Emp # Name Gross', '1077 Morgan Lee 2,000.00'])
    const [a, b] = findStaff([morgan, other], [headed])
    expect([a!.register.length, b!.register.length]).toEqual([0, 0])
    expect(severalPeopleLines([headed], [morgan, other], []).size).toBe(1)
  })

  describe('one payment per participant and pay period (B1)', () => {
    const second = file('f-stub2', 'paystub', [
      'Earnings statement',
      'Jordan Sample   Participant P-2001',
      'Pay period 03/01/2027 - 03/15/2027',
      'Gross pay 280.00',
    ])
    const made: MatchWex = {
      id: 'w-1',
      reportId: 'r-e-isy',
      participantRowId: 'p-jordan',
      start: '2027-03-01',
      end: '2027-03-15',
      amount: 280,
      stubDocumentId: 'd-stub',
    }
    const plan = (files: MatchFile[], wex: MatchWex[]) =>
      planMatch({
        files,
        staff: [],
        participants: [jordan],
        months,
        wex,
        highlight: DEFAULT_HIGHLIGHTS,
      })

    it('flags a second stub of the same pay period as a duplicate and changes nothing for it', () => {
      const p = plan([stub, second], [])
      expect(p.stubs.map((x) => [x.fileId, x.action, x.flags])).toEqual([
        ['f-stub', 'create', []],
        ['f-stub2', 'none', ['duplicate']],
      ])
      expect(p.links.filter((l) => l.stubFileId === 'f-stub2')).toEqual([])
    })

    it('flags a stub whose pay period another stub of the set already paid', () => {
      const p = plan([second], [made])
      expect(p.stubs[0]).toMatchObject({ action: 'none', flags: ['duplicate'] })
    })

    it('takes over a payment typed by hand, and one whose stub leaves the set', () => {
      const typed = plan([second], [{ ...made, stubDocumentId: null, amount: 275 }])
      expect(typed.stubs[0]).toMatchObject({ action: 'update', wexId: 'w-1', takesOverTyped: true })
      const leaving = plan([second], [{ ...made, stubLeaving: true }])
      // Its stub is uploaded again under a new name: the payment is changed, not made twice.
      expect(leaving.stubs[0]).toMatchObject({
        action: 'update',
        wexId: 'w-1',
        takesOverTyped: false,
      })
    })
  })
})

describe('staff-match: original files, as the payroll company exports them (owner, 2026-11-01)', () => {
  const runReport = file('f-pay', 'payroll-register', [
    'Pay period 09/16/2026 - 09/30/2026',
    'Pay date 10/06/2026',
    'Total direct deposits 5,000.00',
  ])
  const bankOct = file('f-bank', 'bank-statement', [
    '10/05/2026 ACH DEBIT PAYPEOPLE PAYROLL 5,000.00',
  ])
  // A job report: a row per person and project, a person's total with no project.
  const jobs = file('f-jobs', 'timesheet', [
    'Pay date | 10/06/2026',
    'Employee | Client Projects | Salary Amount',
    'Morgan Lee |  | 3000.00',
    'Morgan Lee | Board (In-School Youth 2026) | 1000.00',
    'Morgan Lee | Adult IT Training | 2000.00',
    'Priya Shah |  | 2000.00',
    'Priya Shah | Adult IT Training | 2000.00',
  ])
  const priya: StaffRow = { id: 's-priya', name: 'Priya Shah', engagementIds: ['e-isy'] }
  const stubOf = (name: string) =>
    file(`f-stub-${name}`, 'paystub', [
      `Employee: ${name}`,
      'Pay period 09/16/2026 - 09/30/2026',
      'Pay date 10/06/2026',
      'Gross pay 3,000.00',
      'Net pay 2,200.00',
    ])
  const isy = (items: MatchMonth['staffItems']): MatchMonth => ({
    reportId: 'r-isy',
    engagementId: 'e-isy',
    engagementName: 'In-School Youth Coding Pathway',
    names: ['Board (In-School Youth 2026)'],
    status: 'draft',
    staffItems: items,
  })
  const plan = (items: MatchMonth['staffItems'], files: MatchFile[]) =>
    planMatch({
      files,
      period: '2026-09',
      staff: [{ ...morgan, engagementIds: ['e-isy'] }, priya],
      participants: [],
      months: [isy(items)],
      wex: [],
      highlight: DEFAULT_HIGHLIGHTS,
      // The workspace's list holds the engagement's own names too: still its rows, never a tie.
      programs: ['Adult IT Training', 'Board (In-School Youth 2026)'],
    })
  const proofs = (p: ReturnType<typeof plan>, item: string) =>
    p.links
      .filter((l) => l.itemId === item)
      .map((l) => `${l.slot}:${l.fileId}${l.slot === 'timesheet' ? `:${l.mark?.text}` : ''}`)
      .sort()

  it("links each person's line to their own proofs of its own run, and a job report's row of its program only", () => {
    const p = plan(
      [
        { id: 'x-morgan', date: '2026-09-30', staffId: morgan.id, end: '2026-09-30' },
        { id: 'x-priya', date: '2026-09-30', staffId: 's-priya', end: '2026-09-30' },
      ],
      [runReport, bankOct, jobs]
    )
    expect(proofs(p, 'x-morgan')).toEqual([
      'bank:f-bank',
      'register:f-pay',
      'timesheet:f-jobs:Morgan Lee | Board (In-School Youth 2026) | 1000.00',
    ])
    // Priya has no row of the program: her total and another program's row prove nothing here.
    expect(proofs(p, 'x-priya')).toEqual(['bank:f-bank', 'register:f-pay'])
  })

  it("takes a staff member's pay stub as proof on their own line of its run, never as a participant's payment", () => {
    const p = plan(
      [
        { id: 'x-morgan', date: '2026-09-30', staffId: morgan.id, end: '2026-09-30' },
        { id: 'x-priya', date: '2026-09-30', staffId: 's-priya', end: '2026-09-30' },
      ],
      [runReport, stubOf('Morgan Lee')]
    )
    const s = p.stubs[0]!
    expect([s.staff?.id, s.flags, s.action, s.named]).toEqual([morgan.id, [], 'none', 'Morgan Lee'])
    expect(proofs(p, 'x-morgan')).toContain('stub:f-stub-Morgan Lee')
    expect(proofs(p, 'x-priya')).not.toContain('stub:f-stub-Morgan Lee')
  })
})

describe('staff-match, reviewed (2026-11-01)', () => {
  const isy: MatchMonth = {
    reportId: 'r-isy',
    engagementId: 'e-isy',
    engagementName: 'In-School Youth Coding Pathway',
    status: 'draft',
    staffItems: [{ id: 'x-morgan', date: '2026-09-30', staffId: morgan.id, end: '2026-09-30' }],
  }
  const ait: MatchMonth = {
    reportId: 'r-ait',
    engagementId: 'e-ait',
    engagementName: 'Adult IT Training',
    status: 'draft',
    staffItems: [{ id: 'x-morgan-ait', date: '2026-09-30', staffId: morgan.id, end: '2026-09-30' }],
  }
  const both: StaffRow = { ...morgan, engagementIds: ['e-isy', 'e-ait'] }
  const plan = (files: MatchFile[], staff = [both]) =>
    planMatch({
      files,
      period: '2026-09',
      staff,
      participants: [],
      months: [isy, ait],
      wex: [],
      highlight: DEFAULT_HIGHLIGHTS,
    })

  it("proves each engagement's line with its own program's pay from payroll details, never the person's total", () => {
    const details = file('f-det', 'payroll-details', [
      '2026-09-30 | [PayPeople] Salary for In-School Youth Coding Pathway jobs for Morgan Lee. Payroll run: Sep 16 - Sep 30: Riverbend | 63102 Payroll Expenses:Salaries | 612.50',
      '2026-09-30 | [PayPeople] Salary for Adult IT Training jobs for Morgan Lee. Payroll run: Sep 16 - Sep 30: Riverbend | 63102 Payroll Expenses:Salaries | 300.00',
      '2026-08-31 | [PayPeople] Salary for In-School Youth Coding Pathway jobs for Morgan Lee. Payroll run: Aug 16 - Aug 31: Riverbend | 63102 Payroll Expenses:Salaries | 400.00',
    ])
    details.lines = details.lines.map((l) => ({ ...l, x: 0 }))
    const p = plan([details])
    const register = (item: string) =>
      p.links.filter((l) => l.itemId === item && l.slot === 'register').map((l) => l.mark?.text)
    expect(register('x-morgan')).toEqual([details.lines[0]!.text])
    expect(register('x-morgan-ait')).toEqual([details.lines[1]!.text])
    expect(p.staff[0]!.charged).toEqual([
      { start: '2026-09-16', end: '2026-09-30', amount: 612.5 },
      { start: '2026-09-16', end: '2026-09-30', amount: 300 },
    ])
  })

  it('links a PDF time report of the line’s period with no register to the line of that run', () => {
    const report = file('f-tr', 'timesheet', [
      'Time report',
      'Pay period 09/16/2026 - 09/30/2026',
      'Morgan Lee 80.0 In-School Youth',
    ])
    const p = plan([report], [{ ...morgan, engagementIds: ['e-isy'] }])
    expect(p.links.some((l) => l.itemId === 'x-morgan' && l.slot === 'timesheet')).toBe(true)
  })

  it("takes a stub as a staff member's own only when it is paid to them, and reads a name beside a second column's label", () => {
    const approved = file('f-st1', 'paystub', [
      'Employee: Casey Unlisted',
      'Pay period 09/16/2026 - 09/30/2026',
      'Gross pay 300.00',
      'Approved by: Morgan Lee',
    ])
    const twoColumns = file('f-st2', 'paystub', [
      'PAY PERIOD:',
      '9/16/2026 - 9/30/2026',
      'PAID TO: T NET PAY:',
      'Morgan Lee $1,452.10',
      'Gross Pay $2,050.00',
    ])
    expect(stubName(twoColumns.lines)).toBe('Morgan Lee')
    const p = plan([approved, twoColumns], [{ ...morgan, engagementIds: ['e-isy'] }])
    expect(p.stubs.map((x) => [x.fileId, x.staff?.id ?? null, x.flags])).toEqual([
      ['f-st1', null, ['no-participant']],
      ['f-st2', morgan.id, []],
    ])
  })
})
