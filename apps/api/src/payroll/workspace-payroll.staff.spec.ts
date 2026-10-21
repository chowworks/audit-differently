import { DEFAULT_HIGHLIGHTS, DEFAULT_PAYROLL_READING, type StatementLine } from '@ad/types'
import { member, W } from '../core/testing/callers'
import { MatchStatsService } from '../core/match-stats.service'
import { payrollDetailsXlsx } from '../../prisma/payroll-workspace-sample'
import { sheetLines } from './payroll-details'
import type { PayrollLineWrite } from './payroll-lines'
import { cleanMark } from './payroll.service'
import { WorkspacePayrollService } from './workspace-payroll.service'

/**
 * The workspace payroll match by the lists (GitHub issue #22; owner's decisions, 2026-10-18): staff proof linked by
 * engagement tags, participants' pay made from their stubs, the engagement cards and the reconciliation's flags.
 * Fictional people, programs and pay.
 */
const owner = member('owner')
const bookkeeper = member('bookkeeper')
const auditor = member('auditor')

const at = (text: string, i: number): StatementLine => ({
  page: 1,
  x: 40,
  y: 700 - i * 18,
  width: 400,
  height: 12,
  text,
})
const REGISTER = [
  'Emp # Name Hours Rate Gross Net',
  'Pay period 03/01/2027 - 03/15/2027',
  '1042 Morgan Lee 80.00 25.00 2,000.00 1,640.22',
  'Avery Stone 80.00 30.00 2,400.00 1,951.10',
  'Jordan Sample 20.00 14.00 280.00 258.58',
  'Taylor Brook 40.00 20.00 800.00 690.00',
  'Totals 220.00 5,480.00 4,539.90',
]
const BANK = [
  '03/16 ACH PAYROLL MORGAN LEE 1,640.22',
  '03/16 ACH PAYROLL AVERY STONE 1,951.10',
  '03/16 ACH PAYROLL JORDAN SAMPLE 258.58',
]
const STUB = [
  'Earnings statement   Current   YTD',
  'Jordan Sample',
  'Pay period 03/01/2027 - 03/15/2027',
  'Gross pay 280.00 1,120.00',
  'Net pay 258.58',
]
const lines = (texts: string[]) => texts.map(at)

type FileOpts = { documentId?: string | null; sha256?: string; fileName?: string }
const file = (id: string, kind: string, texts: string[], o: FileOpts = {}) => ({
  id,
  runId: 'run-ws',
  documentId: o.documentId ?? null,
  kind,
  sensitivity: kind === 'paystub' ? 'personal' : 'financial',
  fileName: o.fileName ?? `${id}.pdf`,
  contentType: 'application/pdf',
  size: 1,
  sha256: o.sha256 ?? `sha-${id}`,
  storageKey: `${W}/workspace/2027-03/${id}.pdf`,
  pages: 1,
  scanned: false,
  status: 'read',
  error: null,
  lines: lines(texts),
  items: [],
  readMs: 1,
})

type Link = {
  documentId: string
  purpose: string
  mark: unknown
  marks: unknown
  byMatch?: boolean
  document: { kind: string }
}

/** A document of the month's set, as the database holds it. */
type SetDoc = {
  id: string
  workspaceId: string
  engagementId: null
  period: string
  kind: string
  sensitivity: string
  fileName: string
  contentType: string
  size: number
  sha256: string
  storageKey: string
  uploadedAt: Date
}
const setDoc = (
  id: string,
  kind: string,
  o: { fileName?: string; sha256?: string } = {}
): SetDoc => ({
  id,
  workspaceId: W,
  engagementId: null,
  period: '2027-03',
  kind,
  sensitivity: kind === 'paystub' ? 'personal' : 'financial',
  fileName: o.fileName ?? `${id}.pdf`,
  contentType: 'application/pdf',
  size: 1,
  sha256: o.sha256 ?? `sha-${id}`,
  storageKey: `${W}/workspace/2027-03/${id}.pdf`,
  uploadedAt: new Date('2027-04-01T00:00:00Z'),
})

function setup(
  opts: {
    files?: ReturnType<typeof file>[]
    /** The month's set when the run started (default: the run's files already on file). */
    set?: SetDoc[]
    mode?: string
    expectedFiles?: number | null
    status?: string
    /** Links already on the staff salaries line of In-School Youth. */
    staffLinks?: Link[]
    wex?: {
      id: string
      stubDocumentId: string | null
      documents: Link[]
      grossAmount?: number
      stubTookOver?: boolean
    }[]
    staff?: {
      id: string
      name: string
      role?: string
      engagements: string[]
    }[]
  } = {}
) {
  const files = opts.files ?? [
    file('f-reg', 'payroll-register', REGISTER),
    file('f-bank', 'bank-statement', BANK),
    file('f-stub', 'paystub', STUB),
  ]
  const setDocs: SetDoc[] =
    opts.set ??
    files
      .filter((f) => f.documentId)
      .map((f) => setDoc(f.documentId!, f.kind, { fileName: f.fileName, sha256: f.sha256 }))
  const run = {
    id: 'run-ws',
    workspaceId: W,
    monthlyReportId: null,
    period: '2027-03',
    createdById: owner.userId,
    createdAt: new Date(),
    replace: false,
    mode: opts.mode ?? 'add',
    expectedFiles: opts.expectedFiles ?? null,
    setDocumentIds: setDocs.map((d) => d.id),
    files,
  }
  const expense = (id: string, itemNumber: string, reportLine: string, amount: number) => ({
    id,
    itemNumber,
    vendor: 'Payroll company',
    reportLine,
    totalCost: amount,
    allocatedAmount: amount,
    date: new Date('2027-03-16T00:00:00Z'),
    documents: [] as Link[],
  })
  const months = [
    {
      id: 'r-isy',
      engagementId: 'e-isy',
      period: '2027-03',
      status: opts.status ?? 'draft',
      engagement: { id: 'e-isy', name: 'In-School Youth Coding Pathway' },
      expenses: [
        {
          ...expense('x-isy-sal', 'ISY-1', 'staff-salaries', 2500),
          documents: opts.staffLinks ?? [],
        },
        expense('x-isy-fringe', 'ISY-2', 'staff-fringe', 500),
      ],
      wexPayments: (opts.wex ?? []).map((w) => ({
        id: w.id,
        grossAmount: w.grossAmount ?? 280,
        payPeriodStart: new Date('2027-03-01T00:00:00Z'),
        payPeriodEnd: new Date('2027-03-15T00:00:00Z'),
        stubDocumentId: w.stubDocumentId,
        stubTookOver: w.stubTookOver ?? false,
        participant: { id: 'p-jordan', displayName: 'Jordan Sample', participantId: 'P-2001' },
        documents: w.documents,
      })),
    },
    {
      id: 'r-osy',
      engagementId: 'e-osy',
      period: '2027-03',
      status: 'draft',
      engagement: { id: 'e-osy', name: 'Out-of-School Youth Bridge' },
      expenses: [expense('x-osy-sal', 'OSY-1', 'staff-salaries', 2500)],
      wexPayments: [],
    },
  ]
  const engagementName = (id: string) => months.find((m) => m.engagementId === id)!.engagement.name
  const staff = (
    opts.staff ?? [
      {
        id: 's-morgan',
        name: 'Morgan Lee',
        engagements: ['e-isy', 'e-osy'],
      },
      { id: 's-avery', name: 'Avery Stone', engagements: ['e-isy'] },
      { id: 's-riley', name: 'Riley Example', engagements: [] },
    ]
  ).map((s) => ({
    ...s,
    workspaceId: W,
    role: s.role ?? null,
    assignments: s.engagements.map((e) => ({
      engagementId: e,
      engagement: { id: e, name: engagementName(e) },
    })),
  }))
  let n = 0
  const tx = {
    $queryRaw: jest.fn(async () => []),
    document: {
      create: jest.fn(async ({ data }) => ({ id: `d-${++n}`, ...data })),
      createMany: jest.fn(),
      deleteMany: jest.fn(),
      findMany: jest.fn(async () => setDocs),
      count: jest.fn(async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.length),
    },
    payrollDroppedDecision: { createMany: jest.fn() },
    payrollMatchFile: { createMany: jest.fn() },
    payrollPayLine: {
      createMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      findMany: jest.fn(async () => []),
    },
    staffPayProof: { deleteMany: jest.fn(), createMany: jest.fn() },
    wexPayment: {
      create: jest.fn(async ({ data }) => ({ id: `wx-${++n}`, ...data })),
      findFirst: jest.fn(async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        participantId: 'p-jordan',
        payPeriodStart: new Date('2027-03-01T00:00:00Z'),
        payPeriodEnd: new Date('2027-03-15T00:00:00Z'),
        grossAmount: 260,
      })),
      update: jest.fn(),
      delete: jest.fn(),
    },
    expenseDocument: {
      upsert: jest.fn(),
      createMany: jest.fn(),
      deleteMany: jest.fn(),
      update: jest.fn(),
      findMany: jest.fn(async () => []),
    },
    wexPaymentDocument: {
      upsert: jest.fn(),
      createMany: jest.fn(),
      deleteMany: jest.fn(),
      update: jest.fn(),
      findMany: jest.fn(async () => []),
    },
    payrollMatchRun: {
      findFirst: jest.fn(async () => ({ files: run.files.map((f) => ({ id: f.id })) })),
      delete: jest.fn(),
    },
  }
  const payLines: Record<string, unknown>[] = []
  const proofs: Record<string, unknown>[] = []
  const dropped: Record<string, unknown>[] = []
  const prisma = {
    // The budget lines a covered books' payroll row is tested against: none holds participant pay unless a test says.
    budgetLine: { findMany: jest.fn().mockResolvedValue([]) },
    payrollMatchRun: {
      findFirst: jest.fn().mockResolvedValue(run),
      findMany: jest.fn().mockResolvedValue([]),
    },
    document: {
      findMany: jest.fn(async () => setDocs),
      count: jest.fn(async () => setDocs.length || 3),
    },
    payrollMatchFile: { count: jest.fn().mockResolvedValue(0) },
    payrollDroppedDecision: { findMany: jest.fn(async () => dropped) },
    monthlyReport: { findMany: jest.fn().mockResolvedValue(months) },
    expense: {
      groupBy: jest.fn().mockResolvedValue([]),
      findMany: jest.fn().mockResolvedValue([]),
    },
    payrollPayLine: { findMany: jest.fn(async () => payLines) },
    staffMember: { findMany: jest.fn(async () => staff) },
    staffPayProof: { findMany: jest.fn(async () => proofs) },
    wexPayment: { findMany: jest.fn().mockResolvedValue([]) },
    participant: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'p-jordan',
          engagementId: 'e-isy',
          displayName: 'Jordan Sample',
          participantId: 'P-2001',
        },
      ]),
    },
    matchRunStat: { createMany: jest.fn() },
    payrollPayList: { findUnique: jest.fn().mockResolvedValue(null) },
  }
  const logged: { description: string; changes?: unknown }[] = []
  const log = {
    log: jest.fn(async (_c: unknown, e: { description: string }) => void logged.push(e)),
    also: jest.fn(
      async (_t: unknown, _c: unknown, e: { description: string }) => void logged.push(e)
    ),
    alsoMany: jest.fn(
      async (_t: unknown, _c: unknown, es: { description: string }[]) => void logged.push(...es)
    ),
    change: jest.fn(
      async (
        _c: unknown,
        write: (t: typeof tx) => Promise<unknown>,
        entry: { description: string } | ((r: unknown) => { description: string })
      ) => {
        const out = await write(tx)
        logged.push(typeof entry === 'function' ? entry(out) : entry)
        return out
      }
    ),
  }
  const reports = {
    reopenWith: jest.fn(async () => async () => {}),
    sendBackWith: jest.fn(async () => async () => {}),
  }
  const checks = { refresh: jest.fn() }
  const match = { remove: jest.fn(), statOf: jest.fn().mockResolvedValue({}) }
  const storage = { read: jest.fn(), delete: jest.fn().mockResolvedValue(undefined) }
  const service = new WorkspacePayrollService(
    prisma as never,
    log as never,
    checks as never,
    reports as never,
    {} as never,
    { kick: jest.fn() } as never,
    { current: jest.fn().mockResolvedValue(DEFAULT_HIGHLIGHTS) } as never,
    storage as never,
    new MatchStatsService(prisma as never),
    match as never,
    { current: jest.fn().mockResolvedValue(DEFAULT_PAYROLL_READING) } as never,
    { attach: async (_w: string, f: unknown[]) => f, read: jest.fn() } as never
  )
  return {
    service,
    tx,
    prisma,
    logged,
    reports,
    checks,
    run,
    months,
    payLines,
    proofs,
    staff,
    setDocs,
    dropped,
    storage,
    match,
    log,
  }
}

/** The document Save filed for a run's file: its id, from the one statement that filed them. */
const filed = (s: ReturnType<typeof setup>, fileId: string): string =>
  (s.tx.document.createMany.mock.calls[0]?.[0].data as { id: string; storageKey: string }[]).find(
    (d) => d.storageKey.endsWith(`/${fileId}.pdf`)
  )!.id

describe('WorkspacePayrollService by the lists', () => {
  describe('staff proof, by engagement tags', () => {
    it('shows before Save what it will link and make, each person with what was found of them', async () => {
      const s = setup()
      const out = await s.service.get(owner, 'run-ws')
      expect(
        out.plan.staff.map((p) => [
          p.name,
          p.pay,
          p.register,
          p.bank,
          p.engagements.map((e) => e.id),
        ])
      ).toEqual([
        ['Morgan Lee', 2000, ['f-reg'], ['f-bank'], ['e-isy', 'e-osy']],
        ['Avery Stone', 2400, ['f-reg'], ['f-bank'], ['e-isy']],
        ['Riley Example', null, [], [], []],
      ])
      expect(out.plan.stubs).toEqual([
        expect.objectContaining({
          fileId: 'f-stub',
          participant: expect.objectContaining({ id: 'p-jordan', engagementId: 'e-isy' }),
          payPeriodStart: '2027-03-01',
          payPeriodEnd: '2027-03-15',
          grossAmount: 280,
          action: 'create',
          flags: [],
        }),
      ])
      expect(out.plan.reopen).toEqual([])
      // Each pay in the files: a staff member's row is on their engagement, Taylor is on no list.
      const pay = (text: string) => out.pays.find((p) => p.mark?.text.startsWith(text))!
      expect(pay('1042 Morgan')).toMatchObject({
        state: 'matched',
        staff: { id: 's-morgan', name: 'Morgan Lee' },
        item: { id: 'x-isy-sal' },
      })
      expect(pay('Taylor Brook')).toMatchObject({ state: 'unassigned', flags: ['not-on-a-list'] })
    })

    it("links a person on two engagements to both engagements' staff payroll lines, and keeps what was found of them", async () => {
      const s = setup()
      await s.service.save(owner, 'run-ws', { links: [] })
      const made = s.tx.expenseDocument.createMany.mock.calls[0][0].data as {
        expenseId: string
        documentId: string
        purpose: string
        marks: { text: string }[]
      }[]
      const docOf = (fileId: string) => filed(s, fileId)
      const has = (expenseId: string, fileId: string, purpose: string) =>
        made.some(
          (m) =>
            m.expenseId === expenseId && m.documentId === docOf(fileId) && m.purpose === purpose
        )
      // Morgan is on both: their register row and bank line prove both engagements' lines.
      for (const x of ['x-isy-sal', 'x-isy-fringe', 'x-osy-sal']) {
        expect([x, has(x, 'f-reg', 'register')]).toEqual([x, true])
        expect([x, has(x, 'f-bank', 'payment')]).toEqual([x, true])
      }
      // Avery is on In-School Youth only: their row is highlighted there, never on Out-of-School Youth.
      const reg = filed(s, 'f-reg')
      const bank = filed(s, 'f-bank')
      const osy = made.find((m) => m.expenseId === 'x-osy-sal' && m.documentId === reg)!
      expect(osy.marks.map((m) => m.text)).toEqual([
        '1042 Morgan Lee 80.00 25.00 2,000.00 1,640.22',
      ])
      const isy = made.find((m) => m.expenseId === 'x-isy-sal' && m.documentId === reg)!
      expect(isy.marks.map((m) => m.text)).toEqual([
        '1042 Morgan Lee 80.00 25.00 2,000.00 1,640.22',
        'Avery Stone 80.00 30.00 2,400.00 1,951.10',
      ])
      // What was found of each person, for the cards.
      const kept = s.tx.staffPayProof.createMany.mock.calls[0][0].data as Record<string, unknown>[]
      expect(kept.map((k) => [k.staffMemberId, k.documentId, k.kind, k.amount, k.guessed])).toEqual(
        [
          ['s-morgan', reg, 'payroll-register', '2000.00', false],
          ['s-morgan', bank, 'bank-statement', '1640.22', false],
          ['s-avery', reg, 'payroll-register', '2400.00', false],
          ['s-avery', bank, 'bank-statement', '1951.10', false],
        ]
      )
      expect(s.tx.staffPayProof.deleteMany).toHaveBeenCalledWith({
        where: { workspaceId: W, period: '2027-03' },
      })
      expect(s.checks.refresh.mock.calls.map((c) => c[0]).sort()).toEqual(['r-isy', 'r-osy'])
      // No person's name or pay reaches a line: staff are counted, participants never named.
      for (const l of s.logged) expect(l.description).not.toMatch(/Morgan|Avery|Jordan|2,000|280/)
      expect(s.logged.at(-1)!.description).toBe(
        'Saved the workspace payroll files for March 2027 (added payroll files): 3 files filed, 3 files in all, 8 pays found, 2 people on the staff list found, 1 work-experience payment made or changed from pay stubs, 8 proofs linked or changed, across 2 engagements'
      )
    })
  })

  describe("participants' pay, from their stubs", () => {
    it('makes the payment from the stub on the month of the engagement whose list names them, and links the stub', async () => {
      const s = setup()
      await s.service.save(owner, 'run-ws', { links: [] })
      expect(s.tx.wexPayment.create).toHaveBeenCalledTimes(1)
      const { data } = s.tx.wexPayment.create.mock.calls[0][0]
      expect(data).toEqual({
        monthlyReportId: 'r-isy',
        participantId: 'p-jordan',
        payPeriodStart: new Date('2027-03-01T00:00:00Z'),
        payPeriodEnd: new Date('2027-03-15T00:00:00Z'),
        grossAmount: '280.00',
        stubDocumentId: filed(s, 'f-stub'),
      })
      const wexId = (await s.tx.wexPayment.create.mock.results[0]!.value).id
      const links = s.tx.wexPaymentDocument.createMany.mock.calls[0][0].data as Record<
        string,
        unknown
      >[]
      expect(links.map((l) => [l.wexPaymentId, l.documentId, l.purpose])).toEqual([
        [wexId, filed(s, 'f-stub'), 'payment'],
        [wexId, filed(s, 'f-reg'), 'register'],
      ])
      // Logged by field name only, never the participant or their pay.
      expect(s.logged).toContainEqual(
        expect.objectContaining({
          description:
            'Added a work-experience payment to March 2027 of In-School Youth Coding Pathway from a pay stub',
          changes: expect.arrayContaining([{ field: 'Gross pay' }, { field: 'Participant' }]),
        })
      )
    })

    it('changes nothing when matched again against the same files, and reopens no month for it', async () => {
      const stubLine = at('Gross pay 280.00 1,120.00', 4)
      const s = setup({
        status: 'submitted',
        staff: [],
        files: [file('f-stub', 'paystub', STUB, { documentId: 'd-stub' })],
        wex: [
          {
            id: 'w-1',
            stubDocumentId: 'd-stub',
            documents: [
              {
                documentId: 'd-stub',
                purpose: 'payment',
                // As stored: the database gives a box's keys back in its own order.
                mark: {
                  x: stubLine.x,
                  y: stubLine.y,
                  page: 1,
                  text: stubLine.text,
                  width: 400,
                  height: 12,
                },
                marks: [cleanMark(stubLine)],
                document: { kind: 'paystub' },
              },
            ],
          },
        ],
      })
      const out = await s.service.get(owner, 'run-ws')
      expect(out.plan.stubs[0]).toMatchObject({ action: 'same', wexPaymentId: 'w-1' })
      expect(out.plan).toMatchObject({ links: 0, reopen: [] })
      // A submitted month and no reason: nothing to change, so nothing to reopen.
      await s.service.save(owner, 'run-ws', { links: [] })
      expect(s.reports.reopenWith).not.toHaveBeenCalled()
      expect(s.tx.wexPayment.create).not.toHaveBeenCalled()
      expect(s.tx.wexPayment.update).not.toHaveBeenCalled()
      expect(s.tx.wexPaymentDocument.upsert).not.toHaveBeenCalled()
      // Its flags are those of this match.
      expect(s.tx.payrollPayLine.updateMany).toHaveBeenCalledWith({
        where: { documentId: { in: ['d-stub'] }, kind: 'paystub' },
        data: { flags: [] },
      })
      // Nothing left the set and nothing joined it.
      expect(s.tx.document.deleteMany).not.toHaveBeenCalled()
      expect(s.tx.document.createMany).not.toHaveBeenCalled()
    })

    it("changes the stub's payment when its pay differs, reopening its month with the owner's reason", async () => {
      const s = setup({
        status: 'submitted',
        staff: [],
        files: [file('f-stub', 'paystub', STUB, { documentId: 'd-stub' })],
        wex: [{ id: 'w-1', stubDocumentId: 'd-stub', documents: [], grossAmount: 260 }],
      })
      expect((await s.service.get(owner, 'run-ws')).plan.reopen.map((m) => m.reportId)).toEqual([
        'r-isy',
      ])
      await expect(s.service.save(owner, 'run-ws', { links: [] })).rejects.toThrow(
        'Say why March 2027 of In-School Youth Coding Pathway is reopened'
      )
      expect(s.tx.wexPayment.update).not.toHaveBeenCalled()
      await s.service.save(owner, 'run-ws', {
        links: [],
        reopenReason: 'Stub corrected by payroll',
      })
      expect(s.reports.reopenWith).toHaveBeenCalledWith(owner, 'r-isy', 'Stub corrected by payroll')
      expect(s.tx.wexPayment.update).toHaveBeenCalledWith({
        where: { id: 'w-1' },
        data: expect.objectContaining({ grossAmount: '280.00', stubDocumentId: 'd-stub' }),
      })
      expect(s.tx.wexPaymentDocument.createMany.mock.calls[0][0].data).toContainEqual(
        expect.objectContaining({ wexPaymentId: 'w-1', documentId: 'd-stub', byMatch: true })
      )
    })

    it('flags a stub whose pay cannot be read, and one naming nobody on a participant list, and makes no payment', async () => {
      const s = setup({
        staff: [],
        files: [
          file('f-u', 'paystub', ['Jordan Sample', 'Net pay 258.58']),
          file('f-n', 'paystub', [
            'Pat Nobody',
            'Pay period 03/01/2027 - 03/15/2027',
            'Gross pay 99.00',
          ]),
        ],
      })
      const out = await s.service.get(owner, 'run-ws')
      expect(out.plan.stubs.map((x) => [x.fileId, x.action, x.flags])).toEqual([
        ['f-u', 'none', ['stub-unreadable']],
        ['f-n', 'none', ['no-participant']],
      ])
      expect(out.pays.map((p) => p.flags)).toEqual([['stub-unreadable'], ['no-participant']])
      await s.service.save(owner, 'run-ws', { links: [] })
      expect(s.tx.wexPayment.create).not.toHaveBeenCalled()
      const kept = s.tx.payrollPayLine.createMany.mock.calls[0][0].data.map(
        (r: { flags: string[] }) => r.flags
      )
      expect(kept).toEqual([['stub-unreadable'], ['no-participant']])
      expect(s.logged.at(-1)!.description).toMatch(/2 pay stubs flagged/)
    })

    it('flags a stub whose pay is not what the register pays them, never by a bank line, and still makes the payment', async () => {
      const s = setup({
        staff: [],
        files: [
          file('f-reg', 'payroll-register', [
            'Pay period 03/01/2027 - 03/15/2027',
            'Name Gross Net',
            'Jordan Sample 300.00 277.05',
          ]),
          // A bank line naming them with another amount is no longer compared: a bank shows one debit per pay run.
          file('f-bank', 'bank-statement', ['03/16 ACH PAYROLL JORDAN SAMPLE 250.00']),
          file('f-stub', 'paystub', STUB),
        ],
      })
      const out = await s.service.get(owner, 'run-ws')
      expect(out.plan.stubs[0]).toMatchObject({ action: 'create', flags: ['register-disagrees'] })
    })

    it("links the pay run's one debit to the payment as its bank line", async () => {
      const s = setup({
        staff: [],
        files: [
          file('f-reg', 'payroll-register', [
            'Pay period 03/01/2027 - 03/15/2027',
            'Pay date 03/19/2027',
            'Name Gross Net',
            'Jordan Sample 280.00 258.58',
            'Total direct deposits 258.58',
          ]),
          file('f-bank', 'bank-statement', ['03/18 ACH DEBIT PAYPEOPLE PAYROLL 258.58']),
          file('f-stub', 'paystub', STUB),
        ],
      })
      const out = await s.service.get(owner, 'run-ws')
      expect(out.plan.stubs[0]).toMatchObject({
        action: 'create',
        flags: [],
        bank: {
          fileId: 'f-bank',
          run: true,
          mark: { text: '03/18 ACH DEBIT PAYPEOPLE PAYROLL 258.58' },
        },
      })
      expect(out.plan.proof[0]!.files.map((f) => [f.slot, f.fileId])).toEqual([
        ['stub', 'f-stub'],
        ['register', 'f-reg'],
        ['bank', 'f-bank'],
      ])
      // The debit is matched to the payment, and is no one person's line.
      const debit = out.pays.find((p) => p.fileId === 'f-bank')!
      expect(debit).toMatchObject({ state: 'matched', staff: null })
      // Saved as the run's matched debit, so the month's check reads it as the payment's bank line.
      await s.service.save(owner, 'run-ws', { links: [] })
      const made = s.tx.wexPaymentDocument.createMany.mock.calls.flatMap(
        (c: { data: { purpose: string; payRun: boolean; documentId: string }[] }[]) => c[0].data
      )
      expect(made.map((l) => [l.purpose, l.payRun])).toEqual([
        ['payment', false],
        ['register', false],
        ['payment', true],
      ])
    })
  })

  describe('matching again', () => {
    it('starts a run of the files on file, for an owner, and says so when there are none', async () => {
      const s = setup({ mode: 'match' })
      s.prisma.document.count.mockResolvedValueOnce(0)
      await expect(s.service.matchAgain(owner, W, '2027-03')).rejects.toThrow(
        'No workspace payroll files are saved for March 2027: upload them first'
      )
      await expect(s.service.matchAgain(auditor, W, '2027-03')).rejects.toThrow(/Only an owner/)
      await expect(s.service.matchAgain(bookkeeper, W, '2027-03')).rejects.toThrow(/Only an owner/)
      // The caller's open run of the month for the same change holds them already: it is answered.
      const out = await s.service.matchAgain(owner, W, '2027-03')
      expect(out.id).toBe('run-ws')
      expect(out.mode).toBe('match')
    })
  })

  describe('the engagement cards', () => {
    const cards = (s: ReturnType<typeof setup>) => {
      s.prisma.monthlyReport.findMany.mockResolvedValueOnce([
        {
          id: 'r-isy',
          engagementId: 'e-isy',
          status: 'draft',
          engagement: {
            id: 'e-isy',
            name: 'In-School Youth Coding Pathway',
            budgetLines: [
              { amount: 9000, reportLine: 'staff-salaries' },
              { amount: 1000, reportLine: 'staff-fringe' },
              { amount: 6000, reportLine: 'wex' },
            ],
          },
          expenses: [
            { allocatedAmount: 2500, reportLine: 'staff-salaries' },
            { allocatedAmount: 500, reportLine: 'staff-salaries' },
          ],
          wexPayments: [{ grossAmount: 280 }],
        },
        {
          id: 'r-osy',
          engagementId: 'e-osy',
          status: 'submitted',
          engagement: {
            id: 'e-osy',
            name: 'Out-of-School Youth Bridge',
            budgetLines: [{ amount: 30000, reportLine: 'staff-salaries' }],
          },
          expenses: [{ allocatedAmount: 2500, reportLine: 'staff-salaries' }],
          wexPayments: [],
        },
      ])
      // Charged before this month: a staff payroll line of an earlier month.
      s.prisma.expense.findMany.mockResolvedValueOnce([
        {
          engagementId: 'e-isy',
          monthlyReportId: 'r-aug',
          reportLine: 'staff-salaries',
          budgetLineId: null,
          allocatedAmount: 8000,
          payrollKey: null,
          payrollKind: null,
          account: null,
          memo: null,
        },
      ])
      s.proofs.push(
        { staffMemberId: 's-morgan', kind: 'payroll-register', amount: 2000 },
        { staffMemberId: 's-morgan', kind: 'bank-statement', amount: 1640.22 },
        { staffMemberId: 's-avery', kind: 'payroll-register', amount: 2400 },
        { staffMemberId: 's-avery', kind: 'timesheet', amount: null }
      )
      return s
    }

    it("shows each engagement's charge, staff budget and tagged staff, and whether the files cover it", async () => {
      const s = cards(setup())
      const out = await s.service.engagements(owner, W, '2027-03')
      // Work experience: this month's payments against the WEX budget lines (a staff line's budget kept apart).
      expect(out.engagements[0]!.wex).toEqual({
        thisMonth: 280,
        payments: 1,
        before: 0,
        approved: 6000,
      })
      expect(out.engagements[0]!.staffBudget.approved).toBe(10000)
      const [isy, osy] = out.engagements
      expect(isy).toMatchObject({
        engagementName: 'In-School Youth Coding Pathway',
        charged: 3000,
        // Over budget: 10,000 approved, 8,000 before, 3,000 now.
        staffBudget: { approved: 10000, chargedBefore: 8000, left: -1000 },
        payFound: 4400,
        covered: true,
      })
      expect(isy!.staff.map((p) => [p.name, p.pay, p.proof, p.alsoOn.map((e) => e.name)])).toEqual([
        [
          'Morgan Lee',
          2000,
          { timesheet: false, register: true, bank: true },
          ['Out-of-School Youth Bridge'],
        ],
        ['Avery Stone', 2400, { timesheet: true, register: true, bank: false }, []],
      ])
      // Morgan's full pay counts on each card: on Out-of-School Youth it is less than the charge.
      expect(osy).toMatchObject({
        charged: 2500,
        staffBudget: { approved: 30000, chargedBefore: 0, left: 27500 },
        payFound: 2000,
        covered: false,
      })
      expect(osy!.staff.map((p) => [p.name, p.alsoOn.map((e) => e.name)])).toEqual([
        ['Morgan Lee', ['In-School Youth Coding Pathway']],
      ])
      // Across the two engagements Morgan shares, the charges (5,500) are more than everyone's pay (4,400) counted once.
      expect(out.sharedStaffOvercharged).toEqual([
        {
          engagements: [
            { id: 'e-isy', name: 'In-School Youth Coding Pathway' },
            { id: 'e-osy', name: 'Out-of-School Youth Bridge' },
          ],
        },
      ])
      expect(s.logged.map((l) => l.description)).toEqual([
        'Opened the staff payroll by engagement for March 2027: 2 engagements, 1 charged more than the pay in the files, 1 group of engagements sharing staff charged more than their pay',
      ])
      expect(JSON.stringify(out.sharedStaffOvercharged)).not.toMatch(/Morgan|2000|4400/)
    })

    it('is for owners and auditors: a bookkeeper finds nothing', async () => {
      const s = cards(setup())
      await expect(s.service.engagements(bookkeeper, W, '2027-03')).rejects.toThrow(/Not Found/)
      await expect(s.service.engagements(member('owner', 'ws-2'), W, '2027-03')).rejects.toThrow(
        /Not Found/
      )
      await expect(s.service.engagements(auditor, W, '2027-03')).resolves.toMatchObject({
        period: '2027-03',
      })
    })
  })

  describe('the reconciliation', () => {
    it('flags staff on no engagement, keeps a stub’s flags, and finds a staff row on its engagement', async () => {
      const s = setup()
      // Saved: a staff line linked to the register, the person's row found, and Riley found but on no engagement.
      s.months[0]!.expenses[0]!.documents = [
        {
          documentId: 'd-reg',
          purpose: 'register',
          mark: at(REGISTER[3]!, 3),
          marks: [],
          document: { kind: 'payroll-register' },
        },
      ]
      const row = (text: string, i: number) => ({
        documentId: 'd-reg',
        period: '2027-03',
        kind: 'payroll-register',
        mark: at(text, i),
        flags: [],
        document: { fileName: 'register.pdf' },
      })
      s.payLines.push(
        { id: 'pl-m', ...row(REGISTER[2]!, 2) },
        { id: 'pl-r', ...row('3001 Riley Example 10.00 140.00', 9) },
        {
          id: 'pl-s',
          documentId: 'd-stub',
          period: '2027-03',
          kind: 'paystub',
          mark: null,
          flags: ['no-participant'],
          document: { fileName: 'stub.pdf' },
        }
      )
      s.proofs.push(
        {
          staffMemberId: 's-morgan',
          documentId: 'd-reg',
          kind: 'payroll-register',
          mark: at(REGISTER[2]!, 2),
        },
        {
          staffMemberId: 's-riley',
          documentId: 'd-reg',
          kind: 'payroll-register',
          mark: at('3001 Riley Example 10.00 140.00', 9),
        }
      )
      const out = await s.service.reconciliation(auditor, W, '2027-03')
      const byId = (id: string) => out.pays.find((p) => p.id === id)!
      // Morgan's row: on In-School Youth's staff salaries line, where the register is linked.
      expect(byId('pl-m')).toMatchObject({
        state: 'matched',
        staff: { id: 's-morgan' },
        item: { id: 'x-isy-sal' },
      })
      expect(byId('pl-r')).toMatchObject({ state: 'unassigned', flags: ['staff-untagged'] })
      expect(byId('pl-s')).toMatchObject({ state: 'unassigned', flags: ['no-participant'] })
      expect(out.staffOnNoEngagement).toEqual([
        { id: 's-riley', name: 'Riley Example', inFiles: true, paid: null, charged: null },
      ])
      expect(out.counts.flagged).toBe(2)
      await expect(s.service.reconciliation(bookkeeper, W, '2027-03')).rejects.toThrow(/Not Found/)
    })
  })

  describe('a pay belongs to the month it was paid in', () => {
    it("files April's run as another month's: its register rows and its bank debit say so, in the reconciliation too", async () => {
      const s = setup({
        files: [
          file('f-reg', 'payroll-register', [
            'Pay period 03/15/2027 - 03/28/2027',
            'Pay date 04/02/2027',
            'Name Gross Net',
            'Morgan Lee 2,000.00 1,640.22',
            'Total direct deposits 1,640.22',
          ]),
          file('f-bank', 'bank-statement', ['04/01/2027 ACH DEBIT PAYPEOPLE PAYROLL 1,640.22']),
        ],
      })
      const open = await s.service.get(owner, 'run-ws')
      const flagsOf = (text: string) => open.pays.find((p) => p.mark?.text.startsWith(text))!.flags
      expect(flagsOf('Morgan Lee')).toContain('other-month')
      expect(flagsOf('04/01/2027')).toContain('other-month')
      // March's staff lines get nothing of April's run.
      expect(open.plan.proof).toEqual([])
      await s.service.save(owner, 'run-ws', { links: [] })
      const kept = s.tx.payrollPayLine.createMany.mock.calls.flatMap(
        (c: { data: { kind: string; flags: string[]; mark?: { text: string } }[] }[]) => c[0].data
      )
      expect(kept.map((l) => [l.kind, l.flags])).toEqual([
        ['payroll-register', ['other-month']],
        ['bank-statement', ['other-month']],
      ])
      // The reconciliation shows the kept flag on the debit line.
      s.payLines.push({
        id: 'pl-debit',
        documentId: 'd-bank',
        period: '2027-03',
        kind: 'bank-statement',
        mark: at('04/01/2027 ACH DEBIT PAYPEOPLE PAYROLL 1,640.22', 0),
        flags: ['other-month'],
        document: { fileName: 'bank.pdf', sha256: 'sha-bank' },
      })
      const out = await s.service.reconciliation(owner, W, '2027-03')
      expect(out.pays.find((p) => p.id === 'pl-debit')).toMatchObject({
        state: 'unassigned',
        flags: ['other-month'],
      })
    })
  })

  describe('suggestions for the staff list', () => {
    it("offers who the month's registers name and the lists do not, to an owner alone", async () => {
      const s = setup()
      s.payLines.push(
        ...REGISTER.slice(2, 6).map((text, i) => ({
          documentId: 'd-reg',
          kind: 'payroll-register',
          mark: at(text, i),
          document: { fileName: 'register.pdf' },
        }))
      )
      expect(await s.service.staffSuggestions(owner, W, '2027-03')).toEqual([
        { name: 'Taylor Brook', fileName: 'register.pdf' },
      ])
      // From the open run's files too.
      expect(await s.service.staffSuggestions(owner, W, '2027-03', 'run-ws')).toEqual([
        { name: 'Taylor Brook', fileName: 'f-reg.pdf' },
      ])
      expect(s.logged.map((l) => l.description)).toContain(
        'Looked for staff on the payroll registers for March 2027: 1 suggestion'
      )
      await expect(s.service.staffSuggestions(auditor, W, '2027-03')).rejects.toThrow(/Not Found/)
      await expect(s.service.staffSuggestions(bookkeeper, W, '2027-03')).rejects.toThrow(
        /Not Found/
      )
    })
  })
})

/**
 * One set of payroll files per workspace month (owner's decision, 2026-10-18): Replace all, Add files, Remove a file
 * and Match again all change the one set, and Save writes the difference from the whole set matched again.
 */
describe('the month’s one set of payroll files', () => {
  /** What Save linked for a run's files, as the database would hold it after: the match's own links. */
  const savedLinks = async (files: ReturnType<typeof file>[]) => {
    const first = setup({ files, mode: 'match' })
    await first.service.save(owner, 'run-ws', { links: [] })
    const made = (first.tx.expenseDocument.createMany.mock.calls[0]?.[0].data ?? []) as {
      expenseId: string
      documentId: string
      purpose: string
      mark: unknown
      marks: unknown
    }[]
    const kindOf = (d: string) => files.find((f) => f.documentId === d)!.kind
    return (expenseId: string): Link[] =>
      made
        .filter((m) => m.expenseId === expenseId)
        .map((m) => ({ ...m, byMatch: true, document: { kind: kindOf(m.documentId) } }))
  }

  it('Replace all: the zip becomes the set, a file of the set no longer in it leaves, an unchanged one stays as it is', async () => {
    const s = setup({
      mode: 'replace',
      expectedFiles: 2,
      set: [setDoc('d-old-reg', 'payroll-register'), setDoc('d-bank', 'bank-statement')],
      files: [
        // The bank statement was in the zip again, the same name and contents: taken from the set, not stored again.
        file('f-bank', 'bank-statement', BANK, {
          documentId: 'd-bank',
          fileName: 'd-bank.pdf',
          sha256: 'sha-d-bank',
        }),
        file('f-reg', 'payroll-register', REGISTER),
      ],
    })
    const out = await s.service.get(owner, 'run-ws')
    expect(out.mode).toBe('replace')
    expect(out.plan.change).toEqual({
      joining: [{ fileId: 'f-reg', fileName: 'f-reg.pdf', kind: 'payroll-register' }],
      leaving: [
        {
          documentId: 'd-old-reg',
          fileName: 'd-old-reg.pdf',
          kind: 'payroll-register',
          why: 'left',
        },
      ],
      unchanged: 1,
      total: 2,
    })
    expect(out.plan.complete).toBe(true)
    await s.service.save(owner, 'run-ws', { links: [] })
    expect(s.tx.document.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['d-old-reg'] } } })
    expect(s.tx.document.createMany.mock.calls[0][0].data.map((d: { id: string }) => d.id)).toEqual(
      [filed(s, 'f-reg')]
    )
    // The run, which holds files of the set, goes before the files that leave.
    expect(s.tx.payrollMatchRun.delete.mock.invocationCallOrder[0]).toBeLessThan(
      s.tx.document.deleteMany.mock.invocationCallOrder[0]!
    )
    // Its stored object goes only once the save committed.
    expect(s.storage.delete).toHaveBeenCalledWith(`${W}/workspace/2027-03/d-old-reg.pdf`)
    expect(s.logged.map((l) => l.description)).toContain(
      "Removed a payroll register for March 2027 from the workspace's payroll files"
    )
    expect(s.logged.at(-1)!.description).toMatch(
      /^Saved the workspace payroll files for March 2027 \(replaced all the payroll files\): 1 file filed, 1 file removed, 2 files in all/
    )
  })

  it('Replace all: refuses to save before every file of the zip arrived, rather than removing the rest', async () => {
    const s = setup({
      mode: 'replace',
      expectedFiles: 3,
      set: [setDoc('d-old-reg', 'payroll-register')],
      files: [file('f-reg', 'payroll-register', REGISTER)],
    })
    expect((await s.service.get(owner, 'run-ws')).plan.complete).toBe(false)
    await expect(s.service.save(owner, 'run-ws', { links: [] })).rejects.toThrow(
      "1 of the zip's 3 files have arrived: send the zip again to finish the upload"
    )
    expect(s.log.change).not.toHaveBeenCalled()
  })

  it("Add files: one pay stub added later touches only that participant's payment and month", async () => {
    const onFile = [
      file('f-reg', 'payroll-register', REGISTER, { documentId: 'd-reg' }),
      file('f-bank', 'bank-statement', BANK, { documentId: 'd-bank' }),
    ]
    const linksOf = await savedLinks(onFile)
    const s = setup({ files: [...onFile, file('f-stub', 'paystub', STUB)] })
    // The staff lines' proofs are already as the match left them.
    s.months[0]!.expenses[0]!.documents = linksOf('x-isy-sal')
    s.months[0]!.expenses[1]!.documents = linksOf('x-isy-fringe')
    s.months[1]!.expenses[0]!.documents = linksOf('x-osy-sal')
    s.months[1]!.status = 'submitted'
    const out = await s.service.get(owner, 'run-ws')
    expect(out.plan.months.map((m) => m.reportId)).toEqual(['r-isy'])
    expect(out.plan.reopen).toEqual([])
    expect(out.plan.payments).toEqual({ create: 1, update: 0, remove: 0 })
    // Out-of-School Youth is submitted and nothing of it changes: no reason asked, nothing reopened.
    await s.service.save(owner, 'run-ws', { links: [] })
    expect(s.reports.reopenWith).not.toHaveBeenCalled()
    expect(s.tx.expenseDocument.createMany).not.toHaveBeenCalled()
    expect(s.tx.expenseDocument.update).not.toHaveBeenCalled()
    expect(s.tx.expenseDocument.deleteMany).not.toHaveBeenCalled()
    expect(s.tx.wexPayment.create).toHaveBeenCalledTimes(1)
    expect(s.tx.document.deleteMany).not.toHaveBeenCalled()
    expect(s.checks.refresh.mock.calls).toEqual([['r-isy']])
  })

  it('Remove a file: the payment made from its pay stub goes; one typed by hand and taken over stays, untied', async () => {
    const s = setup({
      mode: 'remove',
      staff: [],
      set: [
        setDoc('d-stub', 'paystub'),
        setDoc('d-stub2', 'paystub'),
        setDoc('d-reg', 'payroll-register'),
      ],
      files: [file('f-reg', 'payroll-register', REGISTER, { documentId: 'd-reg' })],
      wex: [
        { id: 'w-made', stubDocumentId: 'd-stub', documents: [] },
        { id: 'w-typed', stubDocumentId: 'd-stub2', stubTookOver: true, documents: [] },
        { id: 'w-hand', stubDocumentId: null, documents: [] },
      ],
    })
    const out = await s.service.get(owner, 'run-ws')
    expect(out.plan.change.leaving.map((l) => [l.documentId, l.why])).toEqual([
      ['d-stub', 'left'],
      ['d-stub2', 'left'],
    ])
    expect(out.plan.payments).toMatchObject({ remove: 1 })
    await s.service.save(owner, 'run-ws', { links: [] })
    expect(s.tx.wexPayment.delete.mock.calls).toEqual([[{ where: { id: 'w-made' } }]])
    expect(s.tx.wexPayment.update).toHaveBeenCalledWith({
      where: { id: 'w-typed' },
      data: { stubDocumentId: null, stubTookOver: false },
    })
    // A payment typed by hand is never removed.
    expect(JSON.stringify(s.tx.wexPayment.delete.mock.calls)).not.toMatch(/w-hand|w-typed/)
    expect(s.logged.map((l) => l.description)).toEqual(
      expect.arrayContaining([
        "Removed a work-experience payment from March 2027 of In-School Youth Coding Pathway: its pay stub left the month's payroll files",
        "Kept a work-experience payment in March 2027 of In-School Youth Coding Pathway, typed by hand, when its pay stub left the month's payroll files",
      ])
    )
  })

  it('knows a file by its contents: the same file uploaded again is one file, never a second copy', async () => {
    // Add files: the set's register again under a new name is the same file; it takes the old one's place.
    const s = setup({
      files: [
        file('f-reg', 'payroll-register', REGISTER, { documentId: 'd-reg', sha256: 'sha-X' }),
        file('f-reg2', 'payroll-register', REGISTER, { sha256: 'sha-X', fileName: 'March.pdf' }),
      ],
    })
    const out = await s.service.get(owner, 'run-ws')
    expect(out.plan.change).toMatchObject({
      leaving: [{ documentId: 'd-reg', why: 'changed' }],
      unchanged: 0,
      total: 1,
    })
    // Replace all: a file of the zip that is the set's own (name, kind and contents) is taken from the set, not stored.
    const { createHash } = await import('node:crypto')
    const bytes = Buffer.from('%PDF-1.4 register')
    const sha = createHash('sha256').update(bytes).digest('hex')
    const r = setup({
      mode: 'replace',
      expectedFiles: 1,
      files: [],
      set: [setDoc('d-reg', 'payroll-register', { fileName: 'March.pdf', sha256: sha })],
    })
    const stage = jest.fn()
    ;(r.service as unknown as { documents: { stage: unknown } }).documents = { stage }
    r.prisma.document.findMany.mockResolvedValueOnce(r.setDocs)
    const upload = {
      originalname: 'March.pdf',
      mimetype: 'application/pdf',
      size: bytes.length,
      buffer: bytes,
    }
    await r.service.add(
      owner,
      'run-ws',
      [upload, { ...upload, originalname: 'copy.pdf' }],
      ['payroll-register', 'payroll-register']
    )
    expect(stage).not.toHaveBeenCalled()
    expect(r.tx.payrollMatchFile.createMany.mock.calls[0][0].data).toEqual([
      expect.objectContaining({ documentId: 'd-reg', sha256: sha }),
    ])
  })

  it("keeps the owner's decisions while their file stays the same, and drops them, saying why, when it changes", async () => {
    const hand: Link = {
      documentId: 'd-reg',
      purpose: 'register',
      mark: at(REGISTER[3]!, 3),
      marks: [],
      byMatch: false,
      document: { kind: 'payroll-register' },
    }
    const notFunded = {
      id: 'pl-t',
      documentId: 'd-reg',
      period: '2027-03',
      kind: 'payroll-register',
      mark: at(REGISTER[6]!, 6),
      notFundedReason: 'Paid from general funds',
      document: { fileName: 'd-reg.pdf' },
    }
    // Match again, the register unchanged: the hand link stays as it is, nothing is dropped.
    const same = setup({
      mode: 'match',
      files: [file('f-reg', 'payroll-register', REGISTER, { documentId: 'd-reg' })],
      staffLinks: [hand],
    })
    same.payLines.push(notFunded)
    const kept = await same.service.get(owner, 'run-ws')
    expect(kept.plan.dropped).toEqual([])
    await same.service.save(owner, 'run-ws', { links: [] })
    expect(same.tx.expenseDocument.deleteMany).not.toHaveBeenCalled()
    expect(same.tx.expenseDocument.update).not.toHaveBeenCalled()
    expect(same.tx.payrollDroppedDecision.createMany).not.toHaveBeenCalled()
    // A new register of the same name, other contents: the old one leaves, and its decisions with it.
    const changed = setup({
      files: [
        file('f-reg', 'payroll-register', REGISTER, { documentId: 'd-reg', fileName: 'd-reg.pdf' }),
        file('f-new', 'payroll-register', REGISTER, { fileName: 'd-reg.pdf', sha256: 'sha-new' }),
      ],
      staffLinks: [hand],
    })
    changed.payLines.push(notFunded)
    const plan = (await changed.service.get(owner, 'run-ws')).plan
    expect(plan.dropped).toEqual([
      expect.objectContaining({
        fileName: 'd-reg.pdf',
        decision: 'linked',
        why: 'changed',
        itemTitle: 'Expense ISY-1 Payroll company',
        engagementName: 'In-School Youth Coding Pathway',
      }),
      expect.objectContaining({ fileName: 'd-reg.pdf', decision: 'not-funded', why: 'changed' }),
    ])
    await changed.service.save(owner, 'run-ws', { links: [] })
    expect(changed.tx.payrollDroppedDecision.createMany.mock.calls[0][0].data).toEqual([
      expect.objectContaining({ decision: 'linked', why: 'changed', droppedById: owner.userId }),
      expect.objectContaining({ decision: 'not-funded', why: 'changed', itemTitle: null }),
    ])
    expect(changed.logged.map((l) => l.description)).toContain(
      "Removed a payroll register for March 2027 from the workspace's payroll files, replaced by a new copy, with 2 decisions made on it"
    )
    // The reconciliation says so.
    changed.dropped.push({
      id: 'dd-1',
      fileName: 'd-reg.pdf',
      kind: 'payroll-register',
      decision: 'not-funded',
      why: 'changed',
      itemTitle: null,
      engagementName: null,
      droppedByEmail: owner.email,
      droppedAt: new Date('2027-04-02T00:00:00Z'),
    })
    const rec = await changed.service.reconciliation(owner, W, '2027-03')
    expect(rec.dropped).toEqual([
      {
        id: 'dd-1',
        fileName: 'd-reg.pdf',
        kind: 'payroll-register',
        decision: 'not-funded',
        why: 'changed',
        itemTitle: null,
        engagementName: null,
        by: owner.email,
        at: '2027-04-02T00:00:00.000Z',
      },
    ])
  })

  it('lists the closed and submitted months a change touches, and reopens them inside the save with one reason', async () => {
    const s = setup({
      mode: 'remove',
      status: 'submitted',
      set: [setDoc('d-reg', 'payroll-register'), setDoc('d-bank', 'bank-statement')],
      files: [file('f-bank', 'bank-statement', BANK, { documentId: 'd-bank' })],
    })
    // The register leaving takes its link from In-School Youth's submitted month.
    s.months[0]!.expenses[0]!.documents = [
      {
        documentId: 'd-reg',
        purpose: 'register',
        mark: at(REGISTER[2]!, 2),
        marks: [],
        byMatch: true,
        document: { kind: 'payroll-register' },
      },
    ]
    const out = await s.service.get(owner, 'run-ws')
    expect(out.plan.reopen.map((m) => [m.reportId, m.status])).toEqual([['r-isy', 'submitted']])
    await expect(s.service.save(owner, 'run-ws', { links: [] })).rejects.toThrow(
      'Say why March 2027 of In-School Youth Coding Pathway is reopened'
    )
    expect(s.tx.document.deleteMany).not.toHaveBeenCalled()
    await s.service.save(owner, 'run-ws', { links: [], reopenReason: 'Register replaced' })
    expect(s.reports.reopenWith).toHaveBeenCalledWith(owner, 'r-isy', 'Register replaced')
    expect(s.tx.document.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['d-reg'] } } })
  })

  it("refuses more than 1,000 files in a month's set, and never drops one", async () => {
    await expect(
      setup().service.start(owner, W, '2027-03', { mode: 'replace', expected: 1001 })
    ).rejects.toThrow(/at most 1,000; this would make 1,001/)
    await expect(setup().service.start(owner, W, '2027-03', { mode: 'replace' })).rejects.toThrow(
      /how many different files/
    )
    const full = Array.from({ length: 1000 }, (_, i) =>
      file(`f-${i}`, 'timesheet', [], { documentId: `d-${i}` })
    )
    const s = setup({ files: full, set: [] })
    const stage = jest.fn()
    ;(s.service as unknown as { documents: { stage: unknown } }).documents = { stage }
    const bytes = Buffer.from('%PDF-1.4 one more')
    await expect(
      s.service.add(
        owner,
        'run-ws',
        [
          {
            originalname: 'more.pdf',
            mimetype: 'application/pdf',
            size: bytes.length,
            buffer: bytes,
          },
        ],
        ['timesheet']
      )
    ).rejects.toThrow(/at most 1,000; this would make 1,001\. Nothing was changed/)
    expect(stage).not.toHaveBeenCalled()
    expect(s.tx.payrollMatchFile.createMany).not.toHaveBeenCalled()
  })

  it("starts a change removing only the caller's own unsaved run of the month, never anyone else's (B7)", async () => {
    const s = setup()
    s.prisma.payrollMatchRun.findFirst.mockResolvedValueOnce(null)
    ;(s.tx as unknown as { payrollMatchRun: { create: jest.Mock } }).payrollMatchRun.create =
      jest.fn(async ({ data }) => ({ ...data }))
    await s.service.start(owner, W, '2027-03', { mode: 'add' })
    expect(s.prisma.payrollMatchRun.findMany).toHaveBeenCalledWith({
      where: {
        workspaceId: W,
        period: '2027-03',
        monthlyReportId: null,
        createdById: owner.userId,
      },
      include: { files: true },
    })
  })

  it("refuses a change of a full set before removing the caller's own unsaved run, so nothing was changed", async () => {
    const full = Array.from({ length: 1001 }, (_, i) => setDoc(`d-${i}`, 'timesheet'))
    const s = setup({ set: full })
    s.prisma.payrollMatchRun.findFirst.mockResolvedValueOnce(null)
    s.prisma.payrollMatchRun.findMany.mockResolvedValueOnce([{ ...s.run, createdAt: new Date() }])
    await expect(s.service.start(owner, W, '2027-03', { mode: 'add' })).rejects.toThrow(
      /Nothing was changed/
    )
    expect(s.match.remove).not.toHaveBeenCalled()
  })

  it('shows a bank line found by its amount alone as guessed, never as proof on the cards (B4)', async () => {
    const s = setup()
    const line = at('03/16 ACH PAYROLL 1,640.22', 1)
    s.payLines.push({
      id: 'pl-b',
      documentId: 'd-bank',
      period: '2027-03',
      kind: 'bank-statement',
      mark: line,
      flags: [],
      document: { fileName: 'bank.pdf' },
    })
    s.proofs.push({
      staffMemberId: 's-morgan',
      documentId: 'd-bank',
      kind: 'bank-statement',
      amount: 1640.22,
      mark: line,
      guessed: true,
    })
    const rec = await s.service.reconciliation(owner, W, '2027-03')
    expect(rec.pays[0]).toMatchObject({
      state: 'guessed',
      staff: { id: 's-morgan' },
      item: { id: 'x-isy-sal' },
    })
    s.prisma.monthlyReport.findMany.mockResolvedValueOnce([
      {
        id: 'r-isy',
        engagementId: 'e-isy',
        status: 'draft',
        engagement: { id: 'e-isy', name: 'In-School Youth Coding Pathway', budgetLines: [] },
        expenses: [],
        wexPayments: [],
      },
    ])
    const cards = await s.service.engagements(owner, W, '2027-03')
    expect(cards.engagements[0]!.staff[0]!.proof.bank).toBe(false)
  })
})

describe('payroll lines Save writes from payroll details', () => {
  type LinesPlan = {
    payrollLinesPlan: (...a: unknown[]) => Promise<{
      create: PayrollLineWrite[]
      change: { id: string; write: PayrollLineWrite }[]
      touched: string[]
    }>
    payrollLineData: (w: PayrollLineWrite) => { memo: string }
  }
  /** Adult IT Training's September, already submitted, against the sample's payroll details. */
  async function plan(existing: Record<string, unknown>[]) {
    const s = setup()
    const service = s.service as unknown as LinesPlan
    ;(s.prisma as unknown as { budgetLine: unknown }).budgetLine = {
      findMany: jest.fn().mockResolvedValue([
        { id: 'ait-salaries', engagementId: 'e-ait', payroll: ['staff-pay'] },
        { id: 'ait-fringe', engagementId: 'e-ait', payroll: ['staff-taxes'] },
      ]),
    }
    s.prisma.expense.findMany.mockResolvedValueOnce(existing)
    const details = {
      id: 'f-details',
      kind: 'payroll-details',
      documentId: 'd-details',
      lines: await sheetLines(await payrollDetailsXlsx()),
    }
    const months = [
      {
        reportId: 'r-ait',
        engagementId: 'e-ait',
        engagementName: 'Adult IT Training',
        status: 'submitted',
      },
    ]
    return service.payrollLinesPlan(
      [details],
      { staff: [], stubs: [] },
      [{ id: 's-sam', name: 'Sam Ortiz', engagementIds: ['e-ait'] }],
      [],
      months,
      new Set()
    )
  }
  /** A line as an earlier save wrote it, read back as the database returns it. */
  const asWritten = (service: LinesPlan, w: PayrollLineWrite, i: number) => {
    const d = service.payrollLineData(w)
    return {
      ...d,
      id: `x-${i}`,
      monthlyReportId: w.reportId,
      payrollKey: w.key,
      payrollKind: null,
      reportLine: 'staff-salaries',
      documents: [],
    }
  }

  it('leaves a line already written as Save would write it alone, and touches no submitted month for it', async () => {
    const first = await plan([])
    expect(first.create.length).toBeGreaterThan(0)
    const service = setup().service as unknown as LinesPlan
    const again = await plan(first.create.map((w, i) => asWritten(service, w, i)))
    expect(again.create).toEqual([])
    expect(again.change).toEqual([])
    expect(again.touched).toEqual([])
  })

  it('changes a line whose description differs, and touches its month so Save reopens it first', async () => {
    const first = await plan([])
    const service = setup().service as unknown as LinesPlan
    const rows = first.create.map((w, i) => asWritten(service, w, i))
    rows[0]!.memo = 'Pay, typed by hand'
    const again = await plan(rows)
    expect(again.change.map((c) => c.id)).toEqual(['x-0'])
    expect(again.touched).toEqual(['r-ait'])
  })
})
