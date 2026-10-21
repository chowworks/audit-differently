import { PDFDocument, StandardFonts } from 'pdf-lib'
import { DEFAULT_HIGHLIGHTS, DEFAULT_PAYROLL_READING, type StatementLine } from '@ad/types'
import { member, W } from '../core/testing/callers'
import { MatchStatsService } from '../core/match-stats.service'
import { readStatement } from './statement-lines'
import {
  coveredBy,
  twoDiffer,
  twoProofsOn,
  WorkspacePayrollService,
} from './workspace-payroll.service'
import type { WorkspaceItem } from './workspace-items'

/**
 * The workspace payroll match (GitHub issue #22): one register for September 2026 proves the pay of two engagements'
 * participants, and names a third person who is on no engagement. Fictional people and pay.
 */
const owner = member('owner')
const bookkeeper = member('bookkeeper')
const auditor = member('auditor')

async function registerPdf(): Promise<Buffer> {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([612, 792])
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  ;[
    'Payroll register',
    'Pay period 09/07/2026 - 09/20/2026',
    'Jordan Sample 20.00 280.00',
    'Casey Demo 25.00 312.50',
    'Riley Example 10.00 140.00',
    'Totals 55.00 732.50',
  ].forEach((t, i) => page.drawText(t, { x: 50, y: 700 - i * 18, size: 10, font }))
  return Buffer.from(await pdf.save())
}

type Link = {
  documentId: string
  purpose: string
  mark: unknown
  marks: unknown
  document: { kind: string }
}

async function setup(opts: { statusB?: string; links?: Record<string, Link[]> } = {}) {
  const bytes = await registerPdf()
  const read = await readStatement(bytes)
  const file = {
    id: 'f-reg',
    runId: 'run-ws',
    documentId: null as string | null,
    kind: 'payroll-register',
    sensitivity: 'financial',
    fileName: 'register-september.pdf',
    contentType: 'application/pdf',
    size: bytes.length,
    sha256: 'sha',
    storageKey: `${W}/workspace/2026-09/reg.pdf`,
    pages: 1,
    scanned: false,
    status: 'read',
    error: null,
    lines: read.lines,
    items: read.items,
    readMs: 10,
  }
  const run = {
    id: 'run-ws',
    workspaceId: W,
    monthlyReportId: null,
    period: '2026-09',
    createdById: owner.userId,
    createdAt: new Date(),
    replace: false,
    mode: 'add' as string | null,
    expectedFiles: null as number | null,
    setDocumentIds: [] as string[],
    files: [file],
  }
  /** The month's set of payroll files as the database holds it. */
  const setDocs: Record<string, unknown>[] = []
  const wex = (id: string, name: string, amount: number) => ({
    id,
    grossAmount: amount,
    payPeriodStart: new Date('2026-09-07T00:00:00Z'),
    payPeriodEnd: new Date('2026-09-20T00:00:00Z'),
    participant: { id: id.replace('w-', 'p-'), displayName: name, participantId: `P-${id}` },
    stubDocumentId: null as string | null,
    documents: opts.links?.[id] ?? [],
  })
  const months = [
    {
      id: 'r-a',
      engagementId: 'e-a',
      period: '2026-09',
      status: 'draft',
      engagement: { id: 'e-a', name: 'Riverbend Youth Works' },
      expenses: [],
      wexPayments: [wex('w-jordan', 'Jordan Sample', 280)],
    },
    {
      id: 'r-b',
      engagementId: 'e-b',
      period: '2026-09',
      status: opts.statusB ?? 'draft',
      engagement: { id: 'e-b', name: 'Harbor Tech Pathways' },
      expenses: [],
      wexPayments: [wex('w-casey', 'Casey Demo', 312.5)],
    },
  ]
  let n = 0
  const payLines: Record<string, unknown>[] = []
  /** Links saved to a document since the page read it (another tab), as the transaction sees them. */
  const linksNow: { mark: unknown; marks: unknown }[] = []
  const tx = {
    // The pay line locked FOR UPDATE: the row as it stands.
    $queryRaw: jest.fn(async (_sql: unknown, id: string) => {
      const l = payLines.find((x) => x.id === id)
      return l ? [{ notFundedReason: l.notFundedReason ?? null }] : []
    }),
    document: {
      create: jest.fn(async ({ data }) => ({ id: `d-${++n}`, ...data })),
      createMany: jest.fn(),
      deleteMany: jest.fn(),
      findMany: jest.fn(async () => setDocs),
      count: jest.fn(async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.length),
    },
    payrollDroppedDecision: { createMany: jest.fn() },
    payrollMatchFile: { createMany: jest.fn() },
    payrollPayLine: { createMany: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    staffPayProof: { deleteMany: jest.fn(), createMany: jest.fn() },
    wexPayment: {
      create: jest.fn(async ({ data }) => ({ id: `wx-${++n}`, ...data })),
      findFirst: jest.fn(),
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
      findMany: jest.fn(async () => linksNow),
    },
    payrollMatchRun: {
      create: jest.fn(async ({ data }) => ({ id: 'run-new', ...data })),
      // The run as it stands inside the save: all its files still there.
      findFirst: jest.fn(async () => ({ files: run.files.map((f) => ({ id: f.id })) })),
      delete: jest.fn(),
    },
    workspace: { update: jest.fn() },
  }
  const prisma = {
    // The budget lines a covered books' payroll row is tested against: none holds participant pay unless a test says.
    budgetLine: { findMany: jest.fn().mockResolvedValue([]) },
    payrollMatchRun: {
      findFirst: jest.fn().mockResolvedValue(run),
      findMany: jest.fn().mockResolvedValue([]),
    },
    payrollMatchFile: { create: jest.fn(), count: jest.fn().mockResolvedValue(0) },
    payrollDroppedDecision: { findMany: jest.fn().mockResolvedValue([]) },
    document: {
      findMany: jest.fn(async () => setDocs),
      count: jest.fn(async () => setDocs.length),
    },
    monthlyReport: {
      findMany: jest.fn().mockResolvedValue(months),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    payrollPayLine: {
      groupBy: jest.fn().mockResolvedValue([]),
      findMany: jest.fn(async () => payLines),
      findFirst: jest.fn(async ({ where }: { where: { id: string } }) =>
        payLines.find((l) => l.id === where.id)
      ),
    },
    workspace: { findFirst: jest.fn().mockResolvedValue({ bookkeepersSeeStaffPayroll: true }) },
    // The books against the payroll files: no payroll transaction, no line the match wrote, no payment yet.
    expense: { findMany: jest.fn().mockResolvedValue([]) },
    wexPayment: { findMany: jest.fn().mockResolvedValue([]) },
    staffMember: { findMany: jest.fn().mockResolvedValue([]) },
    // The engagements' participant lists: Jordan on Riverbend's, Casey on Harbor Tech's.
    participant: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'p-jordan',
          engagementId: 'e-a',
          displayName: 'Jordan Sample',
          participantId: 'P-w-jordan',
        },
        {
          id: 'p-casey',
          engagementId: 'e-b',
          displayName: 'Casey Demo',
          participantId: 'P-w-casey',
        },
      ]),
    },
    staffPayProof: { findMany: jest.fn().mockResolvedValue([]) },
    user: { findFirst: jest.fn().mockResolvedValue({ email: owner.email }) },
    matchRunStat: { createMany: jest.fn() },
    payrollPayList: { findUnique: jest.fn().mockResolvedValue(null) },
  }
  const lines: { description: string; changes?: unknown }[] = []
  const log = {
    log: jest.fn(async (_c: unknown, e: { description: string }) => void lines.push(e)),
    also: jest.fn(
      async (_t: unknown, _c: unknown, e: { description: string }) => void lines.push(e)
    ),
    alsoMany: jest.fn(
      async (_t: unknown, _c: unknown, es: { description: string }[]) => void lines.push(...es)
    ),
    change: jest.fn(
      async (
        _c: unknown,
        write: (t: typeof tx) => Promise<unknown>,
        entry: { description: string } | ((r: unknown) => { description: string })
      ) => {
        const out = await write(tx)
        lines.push(typeof entry === 'function' ? entry(out) : entry)
        return out
      }
    ),
  }
  const checks = { refresh: jest.fn() }
  // Checked when Save asks, written only when Save's transaction runs what they answer.
  const reopened: string[] = []
  const reports = {
    reopen: jest.fn(async () => ({})),
    sendBack: jest.fn(async () => ({})),
    reopenWith: jest.fn(async (_c: unknown, id: string) => async (t: unknown) => {
      expect(t).toBe(tx)
      reopened.push(`reopened ${id}`)
    }),
    sendBackWith: jest.fn(async (_c: unknown, id: string) => async (t: unknown) => {
      expect(t).toBe(tx)
      reopened.push(`sent back ${id}`)
    }),
  }
  let staged = 0
  const documents = {
    stage: jest.fn(async (_c: unknown, f: { originalname: string }, to: { kind: string }) => ({
      data: {
        kind: to.kind,
        sensitivity: 'financial',
        fileName: f.originalname,
        contentType: 'application/pdf',
        size: 1,
        sha256: 'x',
        storageKey: `${W}/workspace/2026-09/s-${++staged}.pdf`,
      },
      commit: async (write: () => Promise<unknown>) => write(),
    })),
  }
  const storage = { read: jest.fn().mockResolvedValue(bytes), delete: jest.fn() }
  const highlights = { current: jest.fn().mockResolvedValue(DEFAULT_HIGHLIGHTS) }
  const match = { remove: jest.fn(), statOf: jest.fn().mockResolvedValue({}) }
  const service = new WorkspacePayrollService(
    prisma as never,
    log as never,
    checks as never,
    reports as never,
    documents as never,
    { kick: jest.fn() } as never,
    highlights as never,
    storage as never,
    new MatchStatsService(prisma as never),
    match as never,
    { current: jest.fn().mockResolvedValue(DEFAULT_PAYROLL_READING) } as never,
    { attach: async (_w: string, f: unknown[]) => f, read: jest.fn() } as never
  )
  const lineOf = (text: string) => read.lines.find((l) => l.text.startsWith(text))!
  return {
    service,
    tx,
    prisma,
    lines,
    checks,
    reports,
    payLines,
    read,
    lineOf,
    match,
    months,
    run,
    reopened,
    documents,
    linksNow,
    bytes,
    log,
    setDocs,
  }
}

/** A workspace payroll document of the month's set. */
const onFile = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  workspaceId: W,
  engagementId: null,
  period: '2026-09',
  kind: 'payroll-register',
  sensitivity: 'financial',
  fileName: `${id}.pdf`,
  contentType: 'application/pdf',
  size: 1,
  sha256: `sha-${id}`,
  storageKey: `${W}/workspace/2026-09/${id}.pdf`,
  uploadedAt: new Date('2026-10-01T00:00:00Z'),
  ...over,
})

const links = [
  { target: 'wex' as const, id: 'w-jordan', slot: 'register' as const, fileId: 'f-reg' },
  { target: 'wex' as const, id: 'w-casey', slot: 'register' as const, fileId: 'f-reg' },
]

describe('WorkspacePayrollService', () => {
  describe('who', () => {
    it('lets an owner alone run it, and a member of another workspace sees nothing', async () => {
      const s = await setup()
      await expect(s.service.start(bookkeeper, W, '2026-09')).rejects.toThrow(/Only an owner/)
      await expect(s.service.start(auditor, W, '2026-09')).rejects.toThrow(/Only an owner/)
      await expect(s.service.start(member('owner', 'ws-2'), W, '2026-09')).rejects.toThrow(
        /Not Found/
      )
      await expect(s.service.save(bookkeeper, 'run-ws', { links })).rejects.toThrow(
        /Not Found|Only an owner/
      )
      await expect(s.service.start(owner, W, '2026-9')).rejects.toThrow(/YYYY-MM/)
      expect(s.tx.payrollMatchRun.create).not.toHaveBeenCalled()
      // No unsaved run of the month open: a new one.
      s.prisma.payrollMatchRun.findFirst.mockResolvedValueOnce(null)
      await s.service.start(owner, W, '2026-09')
      expect(s.tx.payrollMatchRun.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          workspaceId: W,
          period: '2026-09',
          createdById: owner.userId,
          mode: 'add',
          setDocumentIds: [],
        }),
      })
      expect(s.lines.map((l) => l.description)).toContain(
        'Started adding payroll files for September 2026 for the whole workspace'
      )
    })

    it('lets owners and auditors read the reconciliation, never a bookkeeper', async () => {
      const s = await setup()
      // A bookkeeper finds nothing here: 404, so the screen shows the app's not-found page.
      await expect(s.service.reconciliation(bookkeeper, W, '2026-09')).rejects.toThrow(/Not Found/)
      await expect(s.service.periods(bookkeeper, W)).rejects.toThrow(/Not Found/)
      await expect(s.service.latest(bookkeeper, W, '2026-09')).rejects.toThrow(/Not Found/)
      // An auditor reads the page and never has an upload of their own.
      await expect(s.service.latest(auditor, W, '2026-09')).resolves.toBeNull()
      await expect(s.service.reconciliation(auditor, W, '2026-09')).resolves.toMatchObject({
        can: { change: false },
      })
      await expect(s.service.reconciliation(owner, W, '2026-09')).resolves.toMatchObject({
        can: { change: true },
      })
    })

    it("puts each run's payroll in the books beside the payroll files', and says which side lacks one", async () => {
      const s = await setup()
      const d = (iso: string) => new Date(`${iso}T00:00:00Z`)
      // The books: Riverbend's work-experience pay for the run of 09/25, and staff pay for the run of 09/11.
      s.prisma.expense.findMany.mockResolvedValueOnce([
        {
          monthlyReportId: 'r-a',
          date: d('2026-09-25'),
          allocatedAmount: 300,
          payrollKind: 'participant-pay',
          payrollKey: null,
        },
        {
          monthlyReportId: 'r-a',
          date: d('2026-09-11'),
          allocatedAmount: 1200,
          payrollKind: 'staff-pay',
          payrollKey: null,
        },
        // The match's own line for the run of 09/11, and one the books do not have.
        {
          monthlyReportId: 'r-a',
          date: d('2026-09-11'),
          allocatedAmount: 1200,
          payrollKind: null,
          payrollKey: 'staff:s-1:2026-09-06:pay',
        },
        {
          monthlyReportId: 'r-a',
          date: d('2026-09-11'),
          allocatedAmount: 91.8,
          payrollKind: null,
          payrollKey: 'staff:s-1:2026-09-06:taxes',
        },
      ])
      // Jordan's payment, of the pay period ending 09/20: on the books' run of 09/25. The one ending 09/06 has no
      // participant pay in the books: dated by its run's other payroll (09/11), never by its period's end.
      s.prisma.wexPayment.findMany.mockResolvedValueOnce([
        { monthlyReportId: 'r-a', payPeriodEnd: d('2026-09-20'), grossAmount: 280 },
        { monthlyReportId: 'r-a', payPeriodEnd: d('2026-09-06'), grossAmount: 140 },
      ])
      const out = await s.service.reconciliation(owner, W, '2026-09')
      expect(out.books.map((b) => [b.date, b.kind, b.books, b.files])).toEqual([
        ['2026-09-11', 'participant-pay', null, 140],
        ['2026-09-11', 'staff-pay', 1200, 1200],
        ['2026-09-11', 'staff-taxes', null, 91.8],
        ['2026-09-25', 'participant-pay', 300, 280],
      ])
    })

    it('lets an auditor change nothing in the reconciliation', async () => {
      const s = await setup()
      s.payLines.push({
        id: 'pl-1',
        documentId: 'd-reg',
        period: '2026-09',
        kind: 'payroll-register',
      })
      await expect(
        s.service.markNotFunded(auditor, W, 'pl-1', 'Paid from general funds')
      ).rejects.toThrow(/Only an owner/)
      await expect(
        s.service.linkLine(auditor, W, 'pl-1', { target: 'wex', id: 'w-casey' })
      ).rejects.toThrow(/Only an owner/)
      await expect(s.service.clearNotFunded(bookkeeper, W, 'pl-1')).rejects.toThrow(/Only an owner/)
      expect(s.tx.payrollPayLine.update).not.toHaveBeenCalled()
    })
  })

  describe('the months', () => {
    it('counts months and kept pays per month in the database, newest first', async () => {
      const s = await setup()
      s.prisma.monthlyReport.groupBy.mockResolvedValueOnce([
        { period: '2026-08', _count: { _all: 2 } },
        { period: '2026-09', _count: { _all: 3 } },
      ])
      s.prisma.payrollPayLine.groupBy.mockResolvedValueOnce([
        { period: '2026-09', _count: { _all: 40 } },
      ])
      expect(await s.service.periods(auditor, W)).toEqual([
        { period: '2026-09', months: 3, payLines: 40 },
        { period: '2026-08', months: 2, payLines: 0 },
      ])
      expect(s.prisma.payrollPayLine.findMany).not.toHaveBeenCalled()
      expect(s.prisma.monthlyReport.findMany).not.toHaveBeenCalled()
    })
  })

  describe('an upload that stopped halfway', () => {
    const upload = (name: string, buffer: Buffer) => ({
      originalname: name,
      mimetype: 'application/pdf',
      size: buffer.length,
      buffer,
    })

    it('answers the open run again rather than starting a second one', async () => {
      const s = await setup()
      // The caller's own unsaved run of the month, within the day.
      s.prisma.payrollMatchRun.findFirst.mockResolvedValueOnce(s.run)
      const dto = await s.service.start(owner, W, '2026-09')
      expect(dto.id).toBe('run-ws')
      expect(s.tx.payrollMatchRun.create).not.toHaveBeenCalled()
      expect(s.match.remove).not.toHaveBeenCalled()
      expect(s.lines.map((l) => l.description)).toEqual([
        'Opened the workspace payroll match for September 2026 (1 file)',
      ])
    })

    it('skips a file the run already has when the zip is sent again', async () => {
      const s = await setup()
      const { createHash } = await import('node:crypto')
      s.run.files[0]!.sha256 = createHash('sha256').update(s.bytes).digest('hex')
      const other = Buffer.from('%PDF-1.4 another file')
      await s.service.add(
        owner,
        'run-ws',
        [upload('register-september.pdf', s.bytes), upload('bank.pdf', other)],
        ['payroll-register', 'bank-statement']
      )
      expect(s.documents.stage).toHaveBeenCalledTimes(1)
      expect(s.documents.stage.mock.calls[0]![1].originalname).toBe('bank.pdf')
      // The batch's rows and its line, in one transaction.
      expect(s.tx.payrollMatchFile.createMany).toHaveBeenCalledTimes(1)
      expect(s.tx.payrollMatchFile.createMany.mock.calls[0][0].data).toHaveLength(1)
      expect(s.lines.map((l) => l.description)).toEqual([
        'Sent 1 payroll file for September 2026 to be read and matched for the whole workspace',
      ])
      // Everything already there: nothing staged, nothing logged.
      s.lines.length = 0
      await s.service.add(owner, 'run-ws', [upload('again.pdf', s.bytes)], ['payroll-register'])
      expect(s.documents.stage).toHaveBeenCalledTimes(1)
      expect(s.lines).toEqual([])
    })
  })

  describe('matching across engagements', () => {
    it("finds each engagement's participant on the one register, and accounts for every pay in it", async () => {
      const s = await setup()
      const dto = await s.service.get(owner, 'run-ws')
      expect(dto.items.map((i) => [i.engagementName, i.title])).toEqual([
        ['Riverbend Youth Works', "Jordan Sample's work-experience pay"],
        ['Harbor Tech Pathways', "Casey Demo's work-experience pay"],
      ])
      const register = dto.slots.filter((m) => m.slot === 'register')
      expect(register.map((m) => [m.id, m.pick])).toEqual([
        ['w-jordan', 'f-reg'],
        ['w-casey', 'f-reg'],
      ])
      // Three people paid on the register: two matched to an engagement, one on none. Headings and totals are no pay.
      expect(dto.pays.map((p) => [p.mark?.text, p.state, p.item?.engagementName ?? null])).toEqual([
        ['Jordan Sample 20.00 280.00', 'matched', 'Riverbend Youth Works'],
        ['Casey Demo 25.00 312.50', 'matched', 'Harbor Tech Pathways'],
        ['Riley Example 10.00 140.00', 'unassigned', null],
      ])
      // Opening it again is one read line, naming no person and no amount.
      expect(s.lines.map((l) => l.description)).toEqual([
        'Opened the workspace payroll match for September 2026 (1 file)',
      ])
    })
  })

  describe('Save', () => {
    it("files the register once, for the workspace, keeps its pays, and links it to both engagements' items", async () => {
      const s = await setup()
      // Auto-Match's sure picks are the match's own: Save makes them with nothing chosen by hand.
      await s.service.save(owner, 'run-ws', { links: [] })
      expect(s.tx.document.createMany).toHaveBeenCalledTimes(1)
      const [doc] = s.tx.document.createMany.mock.calls[0][0].data
      expect(doc).toMatchObject({
        workspaceId: W,
        engagementId: null,
        period: '2026-09',
        kind: 'payroll-register',
        storageKey: `${W}/workspace/2026-09/reg.pdf`,
      })
      const kept = s.tx.payrollPayLine.createMany.mock.calls[0][0].data
      expect(kept.map((r: { mark: StatementLine }) => r.mark.text)).toEqual([
        'Jordan Sample 20.00 280.00',
        'Casey Demo 25.00 312.50',
        'Riley Example 10.00 140.00',
      ])
      expect(kept.every((r: { documentId: string }) => r.documentId === doc.id)).toBe(true)
      // A file filed just now has no links: they go in one statement, not one upsert each.
      expect(s.tx.wexPaymentDocument.upsert).not.toHaveBeenCalled()
      expect(s.tx.wexPaymentDocument.createMany).toHaveBeenCalledTimes(1)
      const upserts = s.tx.wexPaymentDocument.createMany.mock.calls[0][0].data
      expect(
        upserts.map((u: Record<string, string>) => [
          u.wexPaymentId,
          u.documentId,
          u.purpose,
          u.byMatch,
        ])
      ).toEqual([
        ['w-jordan', doc.id, 'register', true],
        ['w-casey', doc.id, 'register', true],
      ])
      // Each item's own highlights: its amount on its own row, never the other person's.
      expect(upserts[0].marks.map((m: { text: string }) => m.text)).toContain('280.00')
      expect(upserts[1].marks.map((m: { text: string }) => m.text)).toContain('312.50')
      expect(s.tx.payrollMatchRun.delete).toHaveBeenCalledWith({ where: { id: 'run-ws' } })
      expect(s.lines.map((l) => l.description)).toEqual([
        "Uploaded a payroll register for September 2026 with the workspace's payroll",
        'Linked a payroll register for September 2026 to a work-experience payment of Riverbend Youth Works as its payroll register and marked the line',
        'Linked a payroll register for September 2026 to a work-experience payment of Harbor Tech Pathways as its payroll register and marked the line',
        'Saved the workspace payroll files for September 2026 (added payroll files): 1 file filed, 1 file in all, 3 pays found, 2 proofs linked or changed, across 2 engagements',
      ])
      for (const l of s.lines) expect(l.description).not.toMatch(/Jordan|Casey|Riley|280|312/)
      expect(s.checks.refresh.mock.calls).toEqual([['r-a'], ['r-b']])
      expect(s.reports.reopen).not.toHaveBeenCalled()
      expect(s.reports.reopenWith).not.toHaveBeenCalled()
    })

    it('refuses the whole save when the upload went, or the set changed, meanwhile', async () => {
      const s = await setup()
      // Another owner saved a change of the month's set after this one started.
      s.setDocs.push(onFile('d-other'))
      await expect(s.service.save(owner, 'run-ws', { links })).rejects.toThrow(
        "The month's payroll files changed since this was started"
      )
      s.setDocs.length = 0
      s.tx.payrollMatchRun.findFirst.mockResolvedValueOnce(null as never)
      await expect(s.service.save(owner, 'run-ws', { links })).rejects.toThrow(
        'A file in this upload was removed; start the upload again'
      )
      expect(s.tx.wexPaymentDocument.upsert).not.toHaveBeenCalled()
      expect(s.tx.payrollMatchRun.delete).not.toHaveBeenCalled()
      expect(s.checks.refresh).not.toHaveBeenCalled()
    })

    it("upserts the owner's own choice of a document already in the set, as theirs", async () => {
      const s = await setup()
      s.run.files[0]!.documentId = 'd-on-file'
      s.run.setDocumentIds = ['d-on-file']
      s.setDocs.push(onFile('d-on-file'))
      await s.service.save(owner, 'run-ws', { links })
      expect(s.tx.document.createMany).not.toHaveBeenCalled()
      expect(s.tx.document.deleteMany).not.toHaveBeenCalled()
      expect(s.tx.wexPaymentDocument.createMany).not.toHaveBeenCalled()
      expect(s.tx.wexPaymentDocument.upsert.mock.calls[0][0].update.byMatch).toBe(false)
      expect(
        s.tx.wexPaymentDocument.upsert.mock.calls.map((c) => c[0].where.wexPaymentId_documentId)
      ).toEqual([
        { wexPaymentId: 'w-jordan', documentId: 'd-on-file' },
        { wexPaymentId: 'w-casey', documentId: 'd-on-file' },
      ])
    })

    it('waits for the files to be read', async () => {
      const s = await setup()
      ;(await s.prisma.payrollMatchRun.findFirst()).files[0].status = 'reading'
      await expect(s.service.save(owner, 'run-ws', { links })).rejects.toThrow(/still being read/)
    })
  })

  describe('a month that is not a draft', () => {
    it('asks for a reason first, naming the months it will reopen, and changes nothing', async () => {
      const s = await setup({ statusB: 'submitted' })
      await expect(s.service.save(owner, 'run-ws', { links })).rejects.toThrow(
        'Say why September 2026 of Harbor Tech Pathways is reopened'
      )
      expect(s.reports.reopenWith).not.toHaveBeenCalled()
      expect(s.reopened).toEqual([])
      expect(s.tx.document.createMany).not.toHaveBeenCalled()
    })

    it('reopens a submitted month as its page does, inside the save, before anything is filed', async () => {
      const s = await setup({ statusB: 'submitted' })
      await s.service.save(owner, 'run-ws', { links, reopenReason: 'Payroll proof added' })
      expect(s.reports.reopenWith).toHaveBeenCalledWith(owner, 'r-b', 'Payroll proof added')
      expect(s.reports.reopen).not.toHaveBeenCalled()
      expect(s.reopened).toEqual(['reopened r-b'])
      // One transaction: the reopening is written on the save's own.
      expect(s.tx.payrollMatchRun.findFirst.mock.invocationCallOrder[0]).toBeLessThan(
        s.tx.document.createMany.mock.invocationCallOrder[0]!
      )
      expect(s.tx.wexPaymentDocument.upsert).toHaveBeenCalledTimes(2)
    })

    it('leaves every month as it was when the save fails after the reopening', async () => {
      const s = await setup({ statusB: 'submitted' })
      s.tx.wexPaymentDocument.upsert.mockRejectedValueOnce(new Error('db went away'))
      await expect(
        s.service.save(owner, 'run-ws', { links, reopenReason: 'Payroll proof added' })
      ).rejects.toThrow('db went away')
      // The reopening was only ever written on the save's transaction, which failed: rolled back with it. Nothing
      // reopened the month on a transaction of its own, and no check was rerun.
      expect(s.reopened).toEqual(['reopened r-b'])
      expect(s.reports.reopen).not.toHaveBeenCalled()
      expect(s.reports.sendBack).not.toHaveBeenCalled()
      expect(s.log.change).toHaveBeenCalledTimes(1)
      expect(s.checks.refresh).not.toHaveBeenCalled()
    })

    it('refuses before anything is written when a month cannot be reopened', async () => {
      const s = await setup({ statusB: 'submitted' })
      s.reports.reopenWith.mockRejectedValueOnce(
        new Error('Only an owner or bookkeeper reopens a month')
      )
      await expect(
        s.service.save(owner, 'run-ws', { links, reopenReason: 'Payroll proof added' })
      ).rejects.toThrow(/reopens a month/)
      expect(s.log.change).not.toHaveBeenCalled()
    })

    it('sends back a closed month with the reason, and leaves a month with no new proof alone', async () => {
      const s = await setup({ statusB: 'closed' })
      await s.service.save(owner, 'run-ws', {
        links: [links[1]!],
        reopenReason: 'Payroll proof added',
      })
      expect(s.reports.sendBackWith).toHaveBeenCalledWith(owner, 'r-b', 'Payroll proof added')
      expect(s.reopened).toEqual(['sent back r-b'])
      expect(s.reports.reopenWith).not.toHaveBeenCalled()
      // A month whose proof the save does not change is left alone: here, Harbor Tech's register is already its own.
      const probe = await setup()
      const s2 = await setup({
        statusB: 'closed',
        links: {
          'w-casey': [
            {
              documentId: 'd-reg-old',
              purpose: 'register',
              mark: probe.lineOf('Casey'),
              marks: [],
              document: { kind: 'payroll-register' },
            },
          ],
        },
      })
      await s2.service.save(owner, 'run-ws', { links: [links[0]!] })
      expect(s2.reports.sendBackWith).not.toHaveBeenCalled()
    })
  })

  describe('the reconciliation', () => {
    const jordanLink = (s: Awaited<ReturnType<typeof setup>>): Link => ({
      documentId: 'd-reg',
      purpose: 'register',
      mark: s.lineOf('Jordan'),
      marks: [],
      document: { kind: 'payroll-register' },
    })

    it('shows every pay as matched, guessed, unassigned or not grant-funded, and the items still missing proof', async () => {
      const probe = await setup()
      const s = await setup({ links: { 'w-jordan': [jordanLink(probe)] } })
      for (const [id, text, notFunded] of [
        ['pl-j', 'Jordan', null],
        ['pl-c', 'Casey', null],
        ['pl-r', 'Riley', null],
      ] as const)
        s.payLines.push({
          id,
          documentId: 'd-reg',
          period: '2026-09',
          kind: 'payroll-register',
          mark: s.lineOf(text),
          notFundedReason: notFunded,
          document: { fileName: 'register-september.pdf' },
        })
      // The same register row once more, as an owner marked it: not grant-funded, with the reason.
      s.payLines.push({
        id: 'pl-x',
        documentId: 'd-reg',
        period: '2026-09',
        kind: 'payroll-register',
        mark: s.lineOf('Riley'),
        notFundedReason: 'Paid from general funds',
        notFundedByEmail: owner.email,
        notFundedAt: new Date('2026-10-05T00:00:00Z'),
        document: { fileName: 'register-september.pdf' },
      })
      const out = await s.service.reconciliation(owner, W, '2026-09')
      expect(out.pays.map((p) => [p.id, p.state, p.item?.title ?? null])).toEqual([
        ['pl-j', 'matched', "Jordan Sample's work-experience pay"],
        ['pl-c', 'guessed', "Casey Demo's work-experience pay"],
        ['pl-r', 'unassigned', null],
        ['pl-x', 'not-funded', null],
      ])
      expect(out.pays[3]!.notFunded).toEqual({
        reason: 'Paid from general funds',
        by: owner.email,
        at: '2026-10-05T00:00:00.000Z',
      })
      expect(out.counts).toEqual({
        matched: 1,
        guessed: 1,
        unassigned: 1,
        'not-funded': 1,
        unproved: 2,
        flagged: 1,
      })
      // Riley's row names nobody on the staff or participant lists: flagged, not dropped.
      expect(out.pays[2]!.flags).toEqual(['not-on-a-list'])
      expect(out.unproved.map((u) => [u.item.id, u.missing])).toEqual([
        ['w-jordan', ['timesheet', 'stub']],
        ['w-casey', ['timesheet', 'register', 'stub']],
      ])
      // One read line, counts only.
      expect(s.lines.map((l) => l.description)).toEqual([
        'Opened the payroll reconciliation for September 2026: 4 pays, 1 unassigned, 2 payroll items missing proof',
      ])
      expect(out.dropped).toEqual([])
    })

    it('marks an unassigned pay not grant-funded with the reason, logged by field name alone', async () => {
      const s = await setup()
      s.payLines.push({
        id: 'pl-r',
        documentId: 'd-reg',
        period: '2026-09',
        kind: 'payroll-register',
        mark: s.lineOf('Riley'),
        notFundedReason: null,
        document: {
          kind: 'payroll-register',
          sensitivity: 'financial',
          period: '2026-09',
          workspaceId: W,
          engagementId: null,
          storageKey: `${W}/workspace/2026-09/reg.pdf`,
          fileName: 'r.pdf',
        },
      })
      await expect(s.service.markNotFunded(owner, W, 'pl-r', '  ')).rejects.toThrow(/Say why/)
      await s.service.markNotFunded(owner, W, 'pl-r', 'Paid from general funds')
      expect(s.tx.payrollPayLine.update).toHaveBeenCalledWith({
        where: { id: 'pl-r' },
        data: expect.objectContaining({
          notFundedReason: 'Paid from general funds',
          notFundedById: owner.userId,
          notFundedByEmail: owner.email,
        }),
      })
      expect(s.lines).toEqual([
        {
          workspaceId: W,
          resource: 'document',
          subjectId: 'd-reg',
          action: 'update',
          description: 'Marked a pay on a payroll register for September 2026 as not grant-funded',
          changes: [{ field: 'Why it is not grant-funded' }],
        },
      ])
      expect(JSON.stringify(s.lines)).not.toMatch(/general funds|Riley/)
    })

    it("refuses to mark a pay that is on an engagement's item", async () => {
      const probe = await setup()
      const s = await setup({ links: { 'w-jordan': [jordanLink(probe)] } })
      s.payLines.push({
        id: 'pl-j',
        documentId: 'd-reg',
        period: '2026-09',
        kind: 'payroll-register',
        mark: s.lineOf('Jordan'),
        document: {
          kind: 'payroll-register',
          sensitivity: 'financial',
          period: '2026-09',
          workspaceId: W,
          engagementId: null,
          storageKey: `${W}/workspace/2026-09/reg.pdf`,
        },
      })
      await expect(s.service.markNotFunded(owner, W, 'pl-j', 'Not ours')).rejects.toThrow(
        /on an engagement's payroll item/
      )
    })

    it('refuses, inside the write, a pay another tab linked after the page was read', async () => {
      const s = await setup()
      s.payLines.push({
        id: 'pl-r',
        documentId: 'd-reg',
        period: '2026-09',
        kind: 'payroll-register',
        mark: s.lineOf('Riley'),
        notFundedReason: null,
        document: {
          kind: 'payroll-register',
          sensitivity: 'financial',
          period: '2026-09',
          workspaceId: W,
          engagementId: null,
          storageKey: `${W}/workspace/2026-09/reg.pdf`,
        },
      })
      // Linked meanwhile, on Riley's own row: seen only by the transaction, after the line is locked.
      s.linksNow.push({ mark: s.lineOf('Riley'), marks: [] })
      await expect(
        s.service.markNotFunded(owner, W, 'pl-r', 'Paid from general funds')
      ).rejects.toThrow(/on an engagement's payroll item/)
      expect(s.tx.$queryRaw).toHaveBeenCalledTimes(1)
      expect(s.tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        s.tx.wexPaymentDocument.findMany.mock.invocationCallOrder[0]!
      )
      expect(s.tx.payrollPayLine.update).not.toHaveBeenCalled()
      expect(s.lines).toEqual([])
    })

    it('links a pay to an item by hand, on a draft month only, taking back "not grant-funded"', async () => {
      const s = await setup({ statusB: 'submitted' })
      const doc = {
        id: 'd-reg',
        kind: 'payroll-register',
        sensitivity: 'financial',
        period: '2026-09',
        workspaceId: W,
        engagementId: null,
        contentType: 'application/pdf',
        storageKey: `${W}/workspace/2026-09/reg.pdf`,
        fileName: 'register-september.pdf',
      }
      s.payLines.push(
        {
          id: 'pl-c',
          documentId: 'd-reg',
          period: '2026-09',
          kind: 'payroll-register',
          mark: s.lineOf('Casey'),
          notFundedReason: null,
          document: doc,
        },
        {
          id: 'pl-r',
          documentId: 'd-reg',
          period: '2026-09',
          kind: 'payroll-register',
          mark: s.lineOf('Riley'),
          notFundedReason: 'Not ours',
          document: doc,
        }
      )
      await expect(
        s.service.linkLine(owner, W, 'pl-c', { target: 'wex', id: 'w-casey' })
      ).rejects.toThrow(/submitted; only a draft can change/)
      await expect(
        s.service.linkLine(owner, W, 'pl-c', { target: 'wex', id: 'w-nobody' })
      ).rejects.toThrow(/Choose a payroll item/)
      await s.service.linkLine(owner, W, 'pl-r', { target: 'wex', id: 'w-jordan' })
      const made = s.tx.wexPaymentDocument.upsert.mock.calls[0][0].create
      expect(made).toMatchObject({
        wexPaymentId: 'w-jordan',
        documentId: 'd-reg',
        purpose: 'register',
      })
      expect(made.mark.text).toBe('Riley Example 10.00 140.00')
      expect(s.tx.payrollPayLine.update).toHaveBeenCalledWith({
        where: { id: 'pl-r' },
        data: expect.objectContaining({ notFundedReason: null }),
      })
      expect(s.lines.map((l) => l.description)).toEqual([
        'Linked a payroll register for September 2026 to a work-experience payment of Riverbend Youth Works as its payroll register from the payroll reconciliation and marked the line',
      ])
      expect(s.checks.refresh).toHaveBeenCalledWith('r-a')
    })
  })

  describe('"Bookkeepers see staff payroll"', () => {
    it('is set by an owner, logged with its value, and never by a bookkeeper or the platform admin', async () => {
      const s = await setup()
      await expect(s.service.setBookkeepersSeeStaffPayroll(bookkeeper, W, false)).rejects.toThrow(
        /Only an owner/
      )
      await expect(
        s.service.setBookkeepersSeeStaffPayroll({ ...owner, admin: true }, W, false)
      ).rejects.toThrow(/Only an owner/)
      await expect(s.service.setBookkeepersSeeStaffPayroll(owner, W, 'no')).rejects.toThrow(
        /true or false/
      )
      expect(await s.service.setBookkeepersSeeStaffPayroll(owner, W, false)).toEqual({
        bookkeepersSeeStaffPayroll: false,
      })
      expect(s.tx.workspace.update).toHaveBeenCalledWith({
        where: { id: W },
        data: { bookkeepersSeeStaffPayroll: false },
      })
      expect(s.lines).toEqual([
        expect.objectContaining({
          description: 'Turned off "Bookkeepers see staff payroll"',
          changes: [{ field: 'Bookkeepers see staff payroll', before: 'on', after: 'off' }],
        }),
      ])
      // The same value again changes nothing.
      s.lines.length = 0
      await s.service.setBookkeepersSeeStaffPayroll(owner, W, true)
      expect(s.lines).toEqual([])
    })
  })

  describe("the same file, and two different files, as one proof (owner's decision, 2026-10-19)", () => {
    const link = (documentId: string, sha256: string, byMatch: boolean, purpose = 'payment') => ({
      documentId,
      kind: 'paystub',
      sha256,
      purpose,
      mark: null,
      marks: [],
      byMatch,
    })
    const casey = (links: ReturnType<typeof link>[]) =>
      ({
        target: 'wex',
        id: 'w-casey',
        subject: 'a work-experience payment',
        proof: {
          target: 'wex',
          id: 'w-casey',
          kind: 'participant',
          name: 'Casey Demo',
          amount: 280,
          start: '2026-09-07',
          end: '2026-09-20',
        },
        month: {
          reportId: 'r-isy',
          engagementId: 'e-isy',
          engagementName: 'In-School Youth Coding Pathway',
          status: 'draft',
          period: '2026-09',
        },
        links,
        reportLine: null,
        wex: null,
        dto: { title: "Casey Demo's work-experience pay" },
      }) as unknown as WorkspaceItem

    it("flags a payment with the bookkeeper's pay stub and a different one from the match, never the same file twice", () => {
      expect(
        twoProofsOn([casey([link('d-bk', 'sha-bk', false), link('d-ws', 'sha-owner', true)])])
      ).toEqual([
        {
          target: 'wex',
          id: 'w-casey',
          title: "Casey Demo's work-experience pay",
          engagementName: 'In-School Youth Coding Pathway',
          reportId: 'r-isy',
          slot: 'stub',
          message: "Casey Demo's pay has two different pay stubs: check which is right",
        },
      ])
      expect(
        twoProofsOn([casey([link('d-bk', 'sha-1', false), link('d-ws', 'sha-1', true)])])
      ).toEqual([])
      // Two of the bookkeeper's own are theirs to sort out, not the match's.
      expect(
        twoProofsOn([casey([link('d-1', 'sha-1', false), link('d-2', 'sha-2', false)])])
      ).toEqual([])
    })

    it('flags a different timesheet or register only when it contradicts the other for the same person', () => {
      const words = (...texts: string[]) =>
        texts.map((text) => ({ page: 1, x: 1, y: 1, width: 1, height: 1, text }))
      const item = casey([]) as WorkspaceItem
      const theirs = [
        { sha: 'bk', marks: words('Casey Demo 09/07/2026 09/20/2026 $280.00 20.0 WEX') },
      ]
      const same = [{ sha: 'ws', marks: words('Casey Demo 09/07/2026 - 09/20/2026 20.0 $280.00') }]
      const otherPay = [
        { sha: 'ws', marks: words('Casey Demo 09/07/2026 - 09/20/2026 20.0 $300.00') },
      ]
      const otherHours = [
        { sha: 'ws', marks: words('Casey Demo 09/07/2026 - 09/20/2026 21.5 $280.00') },
      ]
      expect(twoDiffer(item, 'timesheet', theirs, same)).toBe(false)
      expect(twoDiffer(item, 'timesheet', theirs, otherPay)).toBe(true)
      expect(twoDiffer(item, 'timesheet', theirs, otherHours)).toBe(true)
      // A participant's register highlights its dates and pay alone: still theirs.
      expect(
        twoDiffer(
          item,
          'register',
          [{ sha: 'bk', marks: words('09/25/2026', '$280.00') }],
          [{ sha: 'ws', marks: words('09/25/2026', '$300.00') }]
        )
      ).toBe(true)
      // Two pay stubs: flagged only when they disagree on the pay, the hours or the dates (owner's decision, 2026-10-20).
      const stub = (text: string) => [{ sha: 'ws', marks: words(text) }]
      const bk = [{ sha: 'bk', marks: words('Casey Demo', '09/07/2026 - 09/20/2026', '$280.00') }]
      expect(twoDiffer(item, 'stub', bk, stub('Casey Demo 9/7/2026 - 9/20/2026 $280.00'))).toBe(
        false
      )
      expect(twoDiffer(item, 'stub', bk, stub('Casey Demo 09/07/2026 - 09/20/2026 $300.00'))).toBe(
        true
      )
      expect(twoDiffer(item, 'stub', bk, stub('Casey Demo 08/24/2026 - 09/06/2026 $280.00'))).toBe(
        true
      )
      // One whose words could not be read can't be compared: flagged. The same file never.
      expect(twoDiffer(item, 'stub', [{ sha: 'a', marks: [] }], [{ sha: 'b', marks: [] }])).toBe(
        true
      )
      expect(twoDiffer(item, 'stub', [{ sha: 'a', marks: [] }], [{ sha: 'a', marks: [] }])).toBe(
        false
      )
      // A staff line: only the staff both files name are compared, never a coordinator the sample does not name.
      const line = { target: 'expense', proof: { ...item.proof, name: null } } as WorkspaceItem
      const coordinator = [{ sha: 'bk', marks: words('Morgan Reyes RUN-1 $1,500.00 40.0 Staff') }]
      const ours = [{ sha: 'ws', marks: words('Morgan Lee $1,200.00 $264.00 $936.00') }]
      expect(twoDiffer(line, 'register', coordinator, ours, ['Morgan Lee', 'Priya Shah'])).toBe(
        false
      )
      const lee = [{ sha: 'bk', marks: words('Morgan Lee $1,250.00 $275.00 $975.00') }]
      expect(twoDiffer(line, 'register', lee, ours, ['Morgan Lee', 'Priya Shah'])).toBe(true)
    })

    it("counts a pay as covered by the same file (its contents) linked from the bookkeeper's month", () => {
      const items = [casey([link('d-bk', 'sha-1', true)])]
      expect(coveredBy(items, 'd-ws', 'paystub', null)).toBeUndefined()
      expect(coveredBy(items, 'd-ws', 'paystub', null, 'sha-1')?.id).toBe('w-casey')
      expect(coveredBy(items, 'd-ws', 'paystub', null, 'sha-2')).toBeUndefined()
    })
  })
})
