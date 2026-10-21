import { DEFAULT_HIGHLIGHTS, DEFAULT_PAYROLL_READING } from '@ad/types'
import { sampleFiles } from '../../prisma/payroll-workspace-sample'
import { member, W } from '../core/testing/callers'
import { dbTestsEnabled } from '../core/testing/tenant-db'
import { MatchStatsService } from '../core/match-stats.service'
import { sheetLines } from './payroll-details'
import { readStatement } from './statement-lines'
import { WorkspacePayrollService } from './workspace-payroll.service'

// What step 2 of the workspace payroll page shows before Save, for the fictional September sample
// (docs/samples/payroll-2026-09-workspace) uploaded as one zip on the demo seed's September (prisma/seed.ts), with the
// tour's tags: Morgan Lee on In-School Youth and Adult IT Training, Priya Shah on In-School Youth, Sam Ortiz on Adult IT
// Training. pdf.js needs Node's VM modules, as the database specs do (`npm test` sets the flag).
const suite = dbTestsEnabled ? describe : describe.skip
const owner = member('owner')
const KIND: Record<string, string> = {
  Timesheets: 'timesheet',
  'Payroll registers': 'payroll-register',
  'Pay stubs': 'paystub',
  'Bank statements': 'bank-statement',
  'Payroll details': 'payroll-details',
}
const ISY = { id: 'e-isy', name: 'In-School Youth Coding Pathway' }
const AIT = { id: 'e-ait', name: 'Adult IT Training' }
const mark = { page: 1, x: 40, y: 600, width: 300, height: 12, text: 'a line' }
/**
 * A link already on the month from the engagement's own September run (not one of the workspace's files): a different
 * file from the sample's, but for Jordan's pay stub, the very file the sample holds (`sha-7`, run 2's).
 */
const own = (documentId: string, purpose: string, kind: string, words: string[] = []) => ({
  documentId,
  purpose,
  mark: kind === 'bank-statement' ? mark : null,
  marks: words.map((text) => ({ ...mark, text })),
  byMatch: false,
  document: { kind, sha256: documentId === 'd-stub-j' ? 'sha-7' : `bk-${documentId}` },
})
/** The seed's own run's words, as its reader highlights them: a person's timesheet row, and the register's dates and pay. */
const seedTimesheet = (name: string, gross: string, hours: string, group = 'WEX') => [
  `${name} RUN-2026-0925 09/07/2026 09/20/2026 ${gross} ${hours} ${group}`,
]
const seedRegister = (gross: string) => ['09/07/2026', '09/20/2026', '09/25/2026', gross]
/** Riley's pay stub as the bookkeeper filed it on the month, unlinked: the same file as the sample's run 2 stub (`sha-8`). */
const rileyOnMonth = {
  id: 'd-stub-r',
  workspaceId: W,
  engagementId: 'e-isy',
  kind: 'paystub',
  sha256: 'sha-8',
  storageKey: `${W}/e-isy/2026-09/d-stub-r.pdf`,
}
const expense = (
  id: string,
  itemNumber: string,
  reportLine: string,
  amount: number,
  documents: unknown[],
  date = '2026-09-25'
) => ({
  id,
  itemNumber,
  vendor: 'PayPeople Payroll',
  reportLine,
  totalCost: amount,
  allocatedAmount: amount,
  date: new Date(`${date}T00:00:00Z`),
  documents,
})
const participants = [
  { id: 'p-jordan', displayName: 'Jordan Sample', participantId: '900001' },
  { id: 'p-riley', displayName: 'Riley Example', participantId: '900002' },
  { id: 'p-casey', displayName: 'Casey Demo', participantId: '900003' },
]
const wex = (
  p: (typeof participants)[number],
  id: string,
  gross: number,
  documents: unknown[]
) => ({
  id,
  grossAmount: gross,
  payPeriodStart: new Date('2026-09-07T00:00:00Z'),
  payPeriodEnd: new Date('2026-09-20T00:00:00Z'),
  stubDocumentId: null,
  stubTookOver: false,
  participant: p,
  documents,
})

suite("the workspace payroll plan for the September sample, on the demo seed's September", () => {
  let service: WorkspacePayrollService

  beforeAll(async () => {
    const files = []
    for (const [i, f] of (await sampleFiles()).entries()) {
      const kind = KIND[f.folder]!
      // Payroll details is a sheet: its rows are its lines, as the worker reads it.
      const sheet = kind === 'payroll-details'
      const text = sheet
        ? { lines: await sheetLines(f.bytes), items: [] }
        : await readStatement(f.bytes)
      files.push({
        id: `f-${i}`,
        runId: 'run-ws',
        documentId: null,
        kind,
        sensitivity: kind === 'paystub' || sheet ? 'personal' : 'financial',
        fileName: f.name,
        contentType: sheet
          ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          : 'application/pdf',
        size: f.bytes.length,
        sha256: `sha-${i}`,
        storageKey: `${W}/workspace/2026-09/f-${i}.${sheet ? 'xlsx' : 'pdf'}`,
        pages: 1,
        scanned: false,
        status: 'read',
        error: null,
        lines: text.lines,
        items: text.items,
        readMs: 1,
      })
    }
    const run = {
      id: 'run-ws',
      workspaceId: W,
      monthlyReportId: null,
      period: '2026-09',
      createdById: owner.userId,
      createdAt: new Date(),
      replace: true,
      mode: 'replace',
      expectedFiles: files.length,
      setDocumentIds: [],
      files,
    }
    const months = [
      {
        id: 'r-isy',
        engagementId: ISY.id,
        period: '2026-09',
        status: 'draft',
        engagement: ISY,
        expenses: [
          // The seed's September of In-School Youth: its participants' pay line, fully proved by its own run; the
          // coordinator's wages with a timesheet and register; the lead instructor's and case manager's share, unproved.
          expense('x-13', 'RYS-13', 'wex', 784, [
            own('d-ts', 'timesheet', 'timesheet'),
            own('d-reg', 'register', 'payroll-register'),
            own('d-bank', 'payment', 'bank-statement'),
          ]),
          expense('x-18', 'RYS-18', 'staff-salaries', 1500, [
            own(
              'd-ts',
              'timesheet',
              'timesheet',
              seedTimesheet('Morgan Reyes', '$1,500.00', '40.0', 'Staff')
            ),
            own('d-reg', 'register', 'payroll-register', [
              '09/07/2026',
              '09/20/2026',
              '09/25/2026',
            ]),
          ]),
          // The lead instructor's and case manager's share, one charge per pay run of the sample.
          expense('x-20', 'RYS-20', 'staff-salaries', 600, []),
          expense('x-21', 'RYS-21', 'staff-salaries', 1500, [], '2026-09-11'),
        ],
        wexPayments: [
          wex(participants[0]!, 'w-jordan', 280, [
            own(
              'd-ts',
              'timesheet',
              'timesheet',
              seedTimesheet('Jordan Sample', '$280.00', '20.0')
            ),
            own('d-reg', 'register', 'payroll-register', seedRegister('$280.00')),
            own('d-stub-j', 'payment', 'paystub'),
          ]),
          wex(participants[1]!, 'w-riley', 224, [
            own(
              'd-ts',
              'timesheet',
              'timesheet',
              seedTimesheet('Riley Example', '$224.00', '16.0')
            ),
            own('d-reg', 'register', 'payroll-register', seedRegister('$224.00')),
          ]),
          wex(participants[2]!, 'w-casey', 300, [
            own('d-ts', 'timesheet', 'timesheet', seedTimesheet('Casey Demo', '$280.00', '20.0')),
            own('d-reg', 'register', 'payroll-register', seedRegister('$280.00')),
            own('d-stub-c', 'payment', 'paystub'),
          ]),
        ],
      },
      {
        id: 'r-ait',
        engagementId: AIT.id,
        period: '2026-09',
        status: 'draft',
        engagement: AIT,
        expenses: [
          expense('x-ait-1', 'AIT-1', 'staff-salaries', 1900, []),
          expense('x-ait-3', 'AIT-3', 'staff-salaries', 1900, [], '2026-09-11'),
        ],
        wexPayments: [],
      },
    ]
    const tagged = (id: string, name: string, engagements: (typeof ISY)[]) => ({
      id,
      name,
      workspaceId: W,
      role: null,
      assignments: engagements.map((e) => ({ engagementId: e.id, engagement: e })),
    })
    const prisma = {
      payrollMatchRun: {
        findFirst: jest.fn().mockResolvedValue(run),
        findMany: jest.fn().mockResolvedValue([]),
      },
      // The month's set is empty (a first upload); documents of an engagement's month are the bookkeeper's.
      document: {
        findMany: jest.fn(async (args: { where?: { engagementId?: unknown } }) =>
          args?.where?.engagementId ? [rileyOnMonth] : []
        ),
        count: jest.fn(async () => 0),
      },
      payrollMatchFile: { count: jest.fn().mockResolvedValue(0) },
      payrollDroppedDecision: { findMany: jest.fn(async () => []) },
      monthlyReport: { findMany: jest.fn().mockResolvedValue(months) },
      // The demo's budget lines: Staff Salaries holds staff pay and taxes, WEX the participants' (the defaults).
      budgetLine: {
        findMany: jest.fn(async () =>
          [ISY, AIT].flatMap((e) => [
            { id: `${e.id}-staff`, engagementId: e.id, payroll: ['staff-pay', 'staff-taxes'] },
            {
              id: `${e.id}-wex`,
              engagementId: e.id,
              payroll: ['participant-pay', 'participant-taxes'],
            },
          ])
        ),
      },
      // The months' own lines, as Save's payroll lines read them: a person's, none written by an earlier save.
      expense: {
        groupBy: jest.fn().mockResolvedValue([]),
        findMany: jest.fn(async () =>
          (months as { id: string; expenses: ReturnType<typeof expense>[] }[]).flatMap((m) =>
            m.expenses.map((e) => ({
              id: e.id,
              monthlyReportId: m.id,
              payrollKey: null,
              date: e.date,
              allocatedAmount: e.allocatedAmount,
              budgetLineId: null,
              reportLine: e.reportLine,
              payrollKind: null,
              itemNumber: e.itemNumber,
              // As the seed books them: a run's WEX wages, and the staff's.
              account: e.reportLine === 'wex' ? '63103 Salaries - WEX' : '60100 Salaries - Staff',
              memo: null,
            }))
          )
        ),
      },
      payrollPayLine: { findMany: jest.fn(async () => []) },
      staffMember: {
        findMany: jest.fn(async () => [
          tagged('s-morgan', 'Morgan Lee', [ISY, AIT]),
          tagged('s-priya', 'Priya Shah', [ISY]),
          tagged('s-sam', 'Sam Ortiz', [AIT]),
        ]),
      },
      staffPayProof: { findMany: jest.fn(async () => []) },
      participant: {
        findMany: jest
          .fn()
          .mockResolvedValue(participants.map((p) => ({ ...p, engagementId: ISY.id }))),
      },
      matchRunStat: { createMany: jest.fn() },
      payrollPayList: { findUnique: jest.fn().mockResolvedValue(null) },
    }
    service = new WorkspacePayrollService(
      prisma as never,
      { log: jest.fn() } as never,
      { refresh: jest.fn() } as never,
      {} as never,
      {} as never,
      { kick: jest.fn() } as never,
      { current: jest.fn().mockResolvedValue(DEFAULT_HIGHLIGHTS) } as never,
      {} as never,
      new MatchStatsService(prisma as never),
      { statOf: jest.fn().mockResolvedValue({}) } as never,
      { current: jest.fn().mockResolvedValue(DEFAULT_PAYROLL_READING) } as never,
      { attach: async (_w: string, f: unknown[]) => f, read: jest.fn() } as never
    )
  })

  it("attaches 43 files to 11 payroll items, each with its own run's register, time report and debit", async () => {
    const { plan } = await service.get(owner, 'run-ws')
    // 38 from the PDFs, and payroll details as the register proof of the items it charges.
    expect(plan.links).toBe(43)
    const TS1 = 'Time report 08.24.2026 - 09.06.2026.pdf'
    const TS2 = 'Time report 09.07.2026 - 09.20.2026.pdf'
    const REG1 = 'Payroll register 09.11.2026.pdf'
    const REG2 = 'Payroll register 09.25.2026.pdf'
    const BANK = 'Lakeside Community Bank statement 2026-09.pdf'
    const stub = (name: string, date: string) => `Pay stub ${name} ${date}.pdf`
    // Payroll details is each staff line's second register proof: one sheet, every line it charges.
    const SHEET = 'Payroll details 2026-09.xlsx'
    expect(
      plan.proof
        .filter((p) => p.files.some((f) => f.fileName === SHEET))
        .map((p) => [p.title, p.files.filter((f) => f.fileName === SHEET).map((f) => f.slot)])
        .sort()
    ).toEqual(
      [
        ['Expense AIT-1 PayPeople Payroll', ['register']],
        ['Expense AIT-3 PayPeople Payroll', ['register']],
        ['Expense RYS-18 PayPeople Payroll', ['register']],
        ['Expense RYS-20 PayPeople Payroll', ['register']],
        ['Expense RYS-21 PayPeople Payroll', ['register']],
      ].sort()
    )
    expect(
      plan.proof
        .map((p) => [
          p.title,
          p.files.filter((f) => f.fileName !== SHEET).map((f) => [f.slot, f.fileName]),
        ])
        .sort()
    ).toEqual(
      [
        // Each staff line gets the run paid on its date: RYS-21 and AIT-3 run 1's (09/11), the rest run 2's (09/25).
        [
          'Expense RYS-21 PayPeople Payroll',
          [
            ['timesheet', TS1],
            ['register', REG1],
            ['bank', BANK],
          ],
        ],
        [
          'Expense AIT-3 PayPeople Payroll',
          [
            ['timesheet', TS1],
            ['register', REG1],
            ['bank', BANK],
          ],
        ],
        [
          'Expense RYS-18 PayPeople Payroll',
          [
            ['timesheet', TS2],
            ['register', REG2],
            ['bank', BANK],
          ],
        ],
        [
          'Expense RYS-20 PayPeople Payroll',
          [
            ['timesheet', TS2],
            ['register', REG2],
            ['bank', BANK],
          ],
        ],
        [
          'Expense AIT-1 PayPeople Payroll',
          [
            ['timesheet', TS2],
            ['register', REG2],
            ['bank', BANK],
          ],
        ],
        // Run 1 (its period starts in August, paid 09/11): a new payment per participant, with run 1's proofs.
        ...['Jordan Sample', 'Riley Example', 'Casey Demo'].map((n) => [
          `${n}'s work-experience pay`,
          [
            ['stub', stub(n, '09.11.2026')],
            ['timesheet', TS1],
            ['register', REG1],
            ['bank', BANK],
          ],
        ]),
        // Run 2: the payments typed by hand, taken over, with run 2's proofs (Jordan's stub is already on file).
        [
          "Jordan Sample's work-experience pay",
          [
            ['timesheet', TS2],
            ['register', REG2],
            ['bank', BANK],
          ],
        ],
        [
          "Riley Example's work-experience pay",
          [
            ['stub', stub('Riley Example', '09.25.2026')],
            ['timesheet', TS2],
            ['register', REG2],
            ['bank', BANK],
          ],
        ],
        [
          "Casey Demo's work-experience pay",
          [
            ['stub', stub('Casey Demo', '09.25.2026')],
            ['timesheet', TS2],
            ['register', REG2],
            ['bank', BANK],
          ],
        ],
      ].sort()
    )
    // Each staff line's people: everyone tagged to its engagement.
    // Its timesheet, register, payroll details and bank line, each naming the line's two staff.
    const peopleOf = (title: string) =>
      plan.proof.find((p) => p.title.startsWith(title))!.files.map((f) => f.people)
    expect(peopleOf('Expense RYS-18')).toEqual(Array(4).fill(['Morgan Lee', 'Priya Shah']))
    expect(peopleOf('Expense AIT-1')).toEqual(Array(4).fill(['Morgan Lee', 'Sam Ortiz']))
    // The header's items are these 11 and RYS-13, fully proved already by the engagement's own run and given nothing.
    const { items } = await service.get(owner, 'run-ws')
    const inProof = new Set(plan.proof.map((p) => p.id ?? `stub-${p.stubFileId}`))
    expect(items.filter((i) => !inProof.has(i.id)).map((i) => [i.title, i.proved])).toEqual([
      ['Expense RYS-13 PayPeople Payroll', ['timesheet', 'register', 'bank']],
    ])
    expect(items.length + plan.stubs.filter((x) => x.action === 'create').length).toBe(12)
    // The count is the links listed, one per item and file.
    const pairs = plan.proof.flatMap((p) =>
      p.files.map((f) => `${p.id ?? p.stubFileId}:${f.fileId}`)
    )
    expect(new Set(pairs).size).toBe(pairs.length)
    expect(pairs).toHaveLength(plan.links)
  })

  it('links the same file already on file instead of a copy, and flags two different files as one proof', async () => {
    const { plan } = await service.get(owner, 'run-ws')
    // Jordan's stub is already on their payment, Riley's is filed on the month: both already on file.
    expect(plan.alreadyOnFile).toBe(2)
    expect(plan.proof.find((p) => p.id === 'w-jordan')!.files.some((f) => f.slot === 'stub')).toBe(
      false
    )
    expect(plan.proof.find((p) => p.title.startsWith('Riley'))!.files[0]).toMatchObject({
      slot: 'stub',
      fileName: 'Pay stub Riley Example 09.25.2026.pdf',
    })
    // Casey's payment keeps the bookkeeper's stub and gets the owner's: two different pay stubs, flagged.
    expect(plan.twoProofs.map((t) => t.message)).toContain(
      "Casey Demo's pay has two different pay stubs: check which is right"
    )
    // The seed's own timesheet and register are other files than the sample's, but they agree for each person (the
    // same pay and hours; Casey's typed $300.00 is not on them), and RYS-18's are the coordinator's, whom the sample
    // does not name: only Casey's two pay stubs are flagged.
    expect(plan.twoProofs.map((t) => t.message)).toEqual([
      "Casey Demo's pay has two different pay stubs: check which is right",
    ])
    expect(plan.twoProofs.some((t) => t.id === 'w-jordan' && t.slot === 'stub')).toBe(false)
    expect(plan.twoProofs.some((t) => t.id === 'w-riley' && t.slot === 'stub')).toBe(false)
  })

  it('says which engagements each file reaches, and what Save does to each payment', async () => {
    const { plan, pays } = await service.get(owner, 'run-ws')
    expect(plan.files.map((f) => [f.fileName, f.engagements.map((e) => e.id).sort()])).toEqual([
      ['Time report 08.24.2026 - 09.06.2026.pdf', ['e-ait', 'e-isy']],
      ['Payroll register 09.11.2026.pdf', ['e-ait', 'e-isy']],
      ['Pay stub Jordan Sample 09.11.2026.pdf', ['e-isy']],
      ['Pay stub Riley Example 09.11.2026.pdf', ['e-isy']],
      ['Pay stub Casey Demo 09.11.2026.pdf', ['e-isy']],
      ['Time report 09.07.2026 - 09.20.2026.pdf', ['e-ait', 'e-isy']],
      ['Payroll register 09.25.2026.pdf', ['e-ait', 'e-isy']],
      ['Pay stub Jordan Sample 09.25.2026.pdf', ['e-isy']],
      ['Pay stub Riley Example 09.25.2026.pdf', ['e-isy']],
      ['Pay stub Casey Demo 09.25.2026.pdf', ['e-isy']],
      // Alex Rivera's stub names someone on no participant list: it reaches no engagement.
      ['Pay stub Alex Rivera 09.25.2026.pdf', []],
      ['Lakeside Community Bank statement 2026-09.pdf', ['e-ait', 'e-isy']],
      ['Payroll details 2026-09.xlsx', ['e-ait', 'e-isy']],
    ])
    // Both runs' net pay debits are matched, each to an item of its own run, and no one person's line.
    for (const text of [
      '09/10/2026 ACH DEBIT PAYPEOPLE PAYROLL NET PAY',
      '09/24/2026 ACH DEBIT PAYPEOPLE PAYROLL NET PAY',
    ]) {
      const debit = pays.find((p) => p.mark?.text.startsWith(text))!
      expect([text, debit.state, debit.staff]).toEqual([text, 'matched', null])
    }
    // What lands on no engagement: Taylor Brooks and Alex Rivera, Alex's stub, both runs' taxes and a vendor's payment.
    expect(
      pays
        .filter((p) => p.state === 'unassigned')
        .map((p) => [p.fileName, p.mark?.text.split(' $')[0], p.flags])
    ).toEqual([
      ['Payroll register 09.11.2026.pdf', 'Taylor Brooks', ['not-on-a-list']],
      ['Payroll register 09.25.2026.pdf', 'Taylor Brooks', ['not-on-a-list']],
      ['Payroll register 09.25.2026.pdf', 'Alex Rivera', ['not-on-a-list']],
      ['Pay stub Alex Rivera 09.25.2026.pdf', 'Net Pay', ['no-participant']],
      [
        'Lakeside Community Bank statement 2026-09.pdf',
        '09/10/2026 ACH DEBIT PAYPEOPLE PAYROLL TAXES',
        ['not-on-a-list'],
      ],
      [
        'Lakeside Community Bank statement 2026-09.pdf',
        '09/18/2026 ACH DEBIT HILLTOP OFFICE SUPPLY',
        ['not-on-a-list'],
      ],
      [
        'Lakeside Community Bank statement 2026-09.pdf',
        '09/24/2026 ACH DEBIT PAYPEOPLE PAYROLL TAXES',
        ['not-on-a-list'],
      ],
    ])
    // One payment per participant and run: run 1's are made, run 2's (typed by hand) taken over, Casey's corrected.
    expect(
      plan.stubs.map((x) => [x.named, x.action, x.previousAmount, x.grossAmount, x.payPeriodStart])
    ).toEqual([
      ['Jordan Sample', 'create', null, 140, '2026-08-24'],
      ['Riley Example', 'create', null, 112, '2026-08-24'],
      ['Casey Demo', 'create', null, 140, '2026-08-24'],
      ['Jordan Sample', 'update', 280, 280, '2026-09-07'],
      ['Riley Example', 'update', 224, 224, '2026-09-07'],
      ['Casey Demo', 'update', 300, 280, '2026-09-07'],
      ['Alex Rivera', 'none', null, 168, '2026-09-07'],
    ])
    expect(plan.stubs.map((x) => x.bank?.mark?.text.slice(0, 5) ?? null)).toEqual([
      '09/10',
      '09/10',
      '09/10',
      '09/24',
      '09/24',
      '09/24',
      // Alex Rivera was paid in run 2 too, but names no one on a list: nothing is linked.
      '09/24',
    ])
    // Each staff member's September pay is both runs', with both runs' debits.
    expect(plan.staff.map((s) => [s.name, s.pay, s.found.bank.map((b) => b.run)])).toEqual([
      ['Morgan Lee', 2400, [true, true]],
      ['Priya Shah', 1800, [true, true]],
      ['Sam Ortiz', 2000, [true, true]],
    ])
    // Every run that paid them, under each proof, and their pay per run.
    for (const st of plan.staff) {
      expect(st.found.timesheet.map((x) => x.payDate)).toEqual(['2026-09-11', '2026-09-25'])
      const sheetId = plan.files.find((f) => f.kind === 'payroll-details')!.fileId
      // The registers' rows; payroll details charges the same two runs.
      expect(st.found.register.filter((x) => x.fileId !== sheetId).map((x) => x.payDate)).toEqual([
        '2026-09-11',
        '2026-09-25',
      ])
      expect(st.found.register.filter((x) => x.fileId === sheetId).map((x) => x.payDate)).toEqual([
        '2026-09-11',
        '2026-09-25',
      ])
      expect(st.found.bank.map((x) => [x.payDate, x.mark?.text.slice(0, 10)])).toEqual([
        ['2026-09-11', '09/10/2026'],
        ['2026-09-25', '09/24/2026'],
      ])
    }
    expect(plan.staff.map((x) => [x.name, x.payByRun.map((r) => [r.payDate, r.amount])])).toEqual([
      [
        'Morgan Lee',
        [
          ['2026-09-11', 1200],
          ['2026-09-25', 1200],
        ],
      ],
      [
        'Priya Shah',
        [
          ['2026-09-11', 855],
          ['2026-09-25', 945],
        ],
      ],
      [
        'Sam Ortiz',
        [
          ['2026-09-11', 1000],
          ['2026-09-25', 1000],
        ],
      ],
    ])
    expect(plan.unlisted[0]!.register.map((x) => x.payDate)).toEqual(['2026-09-11', '2026-09-25'])
    expect(plan.unlisted[0]!.timesheet.map((x) => x.payDate)).toEqual(['2026-09-11', '2026-09-25'])
    // Taylor Brooks: on both registers and time reports, not on the staff list.
    expect(plan.unlisted.map((u) => [u.name, u.register.length, u.timesheet.length])).toEqual([
      ['Taylor Brooks', 2, 2],
    ])
  })

  it("keeps the month's typed WEX wages for reconciliation only: the participants' payments count that pay", async () => {
    const { plan } = await service.get(owner, 'run-ws')
    expect(
      plan.payrollLines.keep.map((e) => [e.engagementName, e.itemNumber, e.amount, e.kind])
    ).toEqual([['In-School Youth Coding Pathway', 'RYS-13', 784, 'participant-pay']])
    // The staff's typed pay stays: the match proves it and writes no line of its own for those runs.
    expect(plan.payrollLines.keep.some((e) => e.kind.startsWith('staff'))).toBe(false)
  })
})
