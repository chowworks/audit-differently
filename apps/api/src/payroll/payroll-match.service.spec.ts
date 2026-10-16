import { PDFDocument, StandardFonts } from 'pdf-lib'
import { DEFAULT_HIGHLIGHTS } from '@ad/types'
import { MatchStatsService } from '../core/match-stats.service'
import { PayrollMatchService } from './payroll-match.service'
import { readStatement } from './statement-lines'

/**
 * The payroll match on the server: Show (one item's own copy), Save (the staged files filed, each proof linked with
 * the highlights worked out here), and Replace (the month's earlier payroll files removed on Save). Fictional data:
 * the sample's September pay for Jordan Sample and Casey Demo.
 */
const W = 'ws-1'
const caller = {
  userId: 'u-book',
  email: 'book@example.test',
  displayName: 'The bookkeeper',
  memberships: [{ workspaceId: W, workspaceName: 'Riverbend', role: 'bookkeeper' }],
  workspaceIds: [W],
} as never

async function stubPdf(): Promise<Buffer> {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([612, 792])
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const lines = [
    'Paid to: Jordan Sample (employee no. 901)',
    'Pay period 09/07/2026 - 09/20/2026',
    'Base pay $14.00 x 20.00 hours = $280.00',
  ]
  lines.forEach((t, i) => page.drawText(t, { x: 50, y: 700 - i * 15, size: 10, font }))
  return Buffer.from(await pdf.save())
}

async function setup(opts: { replace?: boolean; status?: string } = {}) {
  const bytes = await stubPdf()
  const read = await readStatement(bytes)
  const file = {
    id: 'f-stub',
    runId: 'run-1',
    documentId: null,
    kind: 'paystub',
    sensitivity: 'personal',
    fileName: 'paystub-Jordan-Sample.pdf',
    contentType: 'application/pdf',
    size: bytes.length,
    sha256: 'sha',
    storageKey: `${W}/e-1/2026-09/stub.pdf`,
    pages: 1,
    scanned: false,
    status: opts.status ?? 'read',
    error: null,
    lines: read.lines,
    items: read.items,
  }
  const run = {
    id: 'run-1',
    workspaceId: W,
    monthlyReportId: 'r-1',
    createdById: 'u-book',
    createdAt: new Date(),
    replace: !!opts.replace,
    files: [file],
  }
  const tx = {
    document: { create: jest.fn(async ({ data }) => ({ id: 'd-new', ...data })) },
    expenseDocument: { upsert: jest.fn() },
    wexPaymentDocument: { upsert: jest.fn() },
    payrollMatchRun: { delete: jest.fn() },
  }
  const earlier = [{ id: 'd-old', kind: 'paystub', storageKey: `${W}/e-1/2026-09/old.pdf` }]
  const prisma = {
    payrollMatchRun: { findFirst: jest.fn().mockResolvedValue(run) },
    expense: { findMany: jest.fn().mockResolvedValue([]) },
    wexPayment: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'w-jordan',
          grossAmount: 280,
          payPeriodStart: new Date('2026-09-07T00:00:00Z'),
          payPeriodEnd: new Date('2026-09-20T00:00:00Z'),
          participant: { displayName: 'Jordan Sample' },
        },
      ]),
    },
    document: { findMany: jest.fn().mockResolvedValue(earlier) },
    monthlyReport: { findFirst: jest.fn().mockResolvedValue({ id: 'r-1', period: '2026-09' }) },
    matchRunStat: { createMany: jest.fn() },
  }
  const lines: string[] = []
  const log = {
    log: jest.fn(async (_c: unknown, e: { description: string }) => void lines.push(e.description)),
    also: jest.fn(
      async (_tx: unknown, _c: unknown, e: { description: string }) =>
        void lines.push(e.description)
    ),
    change: jest.fn(
      async (
        _c: unknown,
        write: (t: typeof tx) => Promise<unknown>,
        entry: { description: string }
      ) => {
        const out = await write(tx)
        lines.push(entry.description)
        return out
      }
    ),
  }
  const checks = { refresh: jest.fn() }
  const reports = {
    editable: jest.fn().mockResolvedValue({
      id: 'r-1',
      workspaceId: W,
      engagementId: 'e-1',
      period: '2026-09',
    }),
    fresh: jest.fn().mockResolvedValue({ id: 'r-1' }),
  }
  const documents = { removeReplaced: jest.fn() }
  const highlights = { current: jest.fn().mockResolvedValue(DEFAULT_HIGHLIGHTS) }
  const storage = {
    read: jest.fn().mockResolvedValue(bytes),
    delete: jest.fn().mockResolvedValue(undefined),
  }
  const service = new PayrollMatchService(
    prisma as never,
    log as never,
    checks as never,
    reports as never,
    documents as never,
    {} as never,
    highlights as never,
    storage as never,
    new MatchStatsService(prisma as never)
  )
  /** The Matching statistics rows written, as createMany got them. */
  const stats = () =>
    prisma.matchRunStat.createMany.mock.calls.map((c) => (c[0] as { data: object[] }).data[0])
  return { service, tx, prisma, lines, documents, checks, storage, bytes, earlier, stats }
}

const link = { target: 'wex' as const, id: 'w-jordan', slot: 'stub' as const, fileId: 'f-stub' }

describe('PayrollMatchService', () => {
  describe("Show: one item's own copy", () => {
    it("draws that item's highlights on a copy, leaves the original alone, and logs the open", async () => {
      const s = await setup()
      const out = await s.service.copy(caller, 'run-1', 'f-stub', 'wex', 'w-jordan', 'stub')
      expect(out.contentType).toBe('application/pdf')
      expect(Buffer.from(out.bytes).equals(s.bytes)).toBe(false)
      expect((await PDFDocument.load(out.bytes)).getPageCount()).toBe(1)
      expect(s.lines).toEqual([
        'Opened a pay stub for September 2026 (personal) highlighted for a work-experience payment while matching payroll',
      ])
    })

    it('refuses a run of another person, and an item or proof the month does not have', async () => {
      const s = await setup()
      s.prisma.payrollMatchRun.findFirst.mockResolvedValueOnce(null)
      await expect(
        s.service.copy(caller, 'run-x', 'f-stub', 'wex', 'w-jordan', 'stub')
      ).rejects.toThrow(/Not Found/)
      await expect(
        s.service.copy(caller, 'run-1', 'f-stub', 'wex', 'w-other', 'stub')
      ).rejects.toThrow(/Not Found/)
      await expect(
        s.service.copy(caller, 'run-1', 'f-stub', 'wex', 'w-jordan', 'bank')
      ).rejects.toThrow(/Not Found/)
      expect(s.storage.read).not.toHaveBeenCalled()
    })
  })

  describe('Save', () => {
    it('files each staged file and links its proof with the highlights worked out on the server', async () => {
      const s = await setup()
      await s.service.save(caller, 'run-1', { links: [link] })
      expect(s.tx.document.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          kind: 'paystub',
          sensitivity: 'personal',
          storageKey: `${W}/e-1/2026-09/stub.pdf`,
          uploadedById: 'u-book',
        }),
      })
      const saved = s.tx.wexPaymentDocument.upsert.mock.calls[0][0].create
      expect(saved).toMatchObject({
        wexPaymentId: 'w-jordan',
        documentId: 'd-new',
        purpose: 'payment',
      })
      // The name, the pay period and the amount (DEFAULT_HIGHLIGHTS for a pay stub), each on its own words.
      expect(saved.marks.map((m: { text: string }) => m.text)).toEqual([
        'Jordan',
        'Sample',
        '09/07/2026',
        '09/20/2026',
        '$280.00',
      ])
      expect(s.tx.payrollMatchRun.delete).toHaveBeenCalledWith({ where: { id: 'run-1' } })
      expect(s.lines).toEqual([
        "Uploaded a pay stub for September 2026 (personal) with the month's payroll",
        'Linked a pay stub for September 2026 (personal) to a work-experience payment as its evidence of payment and marked the line',
        'Saved the payroll match for September 2026: 1 file filed, 1 proof linked',
      ])
      expect(s.documents.removeReplaced).not.toHaveBeenCalled()
      expect(s.checks.refresh).toHaveBeenCalledWith('r-1')
    })

    it('waits for the files to be read', async () => {
      const s = await setup({ status: 'reading' })
      await expect(s.service.save(caller, 'run-1', { links: [link] })).rejects.toThrow(
        /still being read/
      )
      expect(s.tx.document.create).not.toHaveBeenCalled()
    })

    it('refuses a proof of the wrong kind for its slot, and an item that is not of the month', async () => {
      const s = await setup()
      await expect(
        s.service.save(caller, 'run-1', { links: [{ ...link, slot: 'timesheet' }] })
      ).rejects.toThrow(/Choose a timesheet of this zip/)
      await expect(
        s.service.save(caller, 'run-1', { links: [{ ...link, id: 'w-other' }] })
      ).rejects.toThrow(/not of this month/)
      expect(s.tx.document.create).not.toHaveBeenCalled()
    })
  })

  describe('Matching statistics', () => {
    it('counts a saved run: files, size, what was found, and nothing that names a file, a person or an amount', async () => {
      const s = await setup()
      await s.service.save(caller, 'run-1', { links: [link] })
      expect(s.stats()).toEqual([
        expect.objectContaining({
          workspaceId: W,
          feature: 'payroll',
          startedById: 'u-book',
          startedByEmail: 'book@example.test',
          outcome: 'saved',
          fileCount: 1,
          totalBytes: BigInt(s.bytes.length),
          items: 1,
          matched: 1,
          guessed: 0,
          // Its timesheet and its payroll register: no file of either kind in this run.
          missing: 2,
          failed: 0,
          bankLines: 0,
        }),
      ])
      const text = JSON.stringify(s.stats()[0], (_k, v) => (typeof v === 'bigint' ? Number(v) : v))
      for (const secret of [
        'Jordan',
        'Sample',
        'paystub-',
        '280',
        'w-jordan',
        'r-1',
        'f-stub',
        'run-1',
      ])
        expect(text).not.toContain(secret)
    })

    it("counts only the files uploaded, not the month's files already on file", async () => {
      const s = await setup()
      const run = await s.prisma.payrollMatchRun.findFirst()
      run.files.push({ ...run.files[0], id: 'f-on-file', documentId: 'd-old', size: 999_999 })
      await s.service.discard(caller, 'run-1')
      expect(s.stats()).toEqual([
        expect.objectContaining({ fileCount: 1, totalBytes: BigInt(s.bytes.length) }),
      ])
    })

    it('counts a discarded run', async () => {
      const s = await setup()
      await s.service.discard(caller, 'run-1')
      expect(s.stats()).toEqual([expect.objectContaining({ outcome: 'discarded', fileCount: 1 })])
    })

    it('never fails Save when the statistic cannot be written', async () => {
      const s = await setup()
      s.prisma.matchRunStat.createMany.mockRejectedValue(new Error('down'))
      await expect(s.service.save(caller, 'run-1', { links: [link] })).resolves.toEqual({
        id: 'r-1',
      })
    })
  })

  describe('Replace', () => {
    it("removes the month's earlier payroll files once Save has filed the new ones", async () => {
      const s = await setup({ replace: true })
      await s.service.save(caller, 'run-1', { links: [link] })
      expect(s.documents.removeReplaced).toHaveBeenCalledWith(caller, s.earlier[0])
      expect(s.tx.document.create.mock.invocationCallOrder[0]).toBeLessThan(
        s.documents.removeReplaced.mock.invocationCallOrder[0]!
      )
    })

    it('removes nothing when Save is refused', async () => {
      const s = await setup({ replace: true, status: 'waiting' })
      await expect(s.service.save(caller, 'run-1', { links: [link] })).rejects.toThrow()
      expect(s.documents.removeReplaced).not.toHaveBeenCalled()
    })
  })
})
