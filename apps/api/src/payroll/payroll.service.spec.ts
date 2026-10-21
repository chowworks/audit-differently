import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Caller } from '../core/caller'
import { member, stranger, W } from '../core/testing/callers'
import { expectNoneOf, fakeLog } from '../core/testing/log'
import { DocumentsService } from '../documents/documents.service'
import { ReportsService } from '../reports/reports.service'
import { PayrollService } from './payroll.service'

/**
 * Payroll proof: many documents uploaded to a month at once, each with its kind; a payroll item's line found on the
 * month's bank statement and linked with its mark, each change logged; marks checked; auditors change nothing,
 * another workspace's row is a 404, a locked month refuses, and a personal document is never read.
 */
const fixture = (name: string) =>
  readFileSync(join(__dirname, '../../test/fixtures/statements', name))
const STATEMENT = fixture('riverbend-2026-09-statement.pdf')
const SCANNED = fixture('scanned-statement.pdf')
const file = (name: string, buffer: Buffer, mimetype = 'application/pdf') => ({
  originalname: name,
  mimetype,
  size: buffer.length,
  buffer,
})

type Row = Record<string, unknown> & { id: string; workspaceId: string }

const doc = (id: string, extra: Record<string, unknown> = {}): Row => ({
  id,
  workspaceId: W,
  engagementId: 'e-1',
  kind: 'bank-statement',
  sensitivity: 'financial',
  fileName: `${id}.pdf`,
  contentType: 'application/pdf',
  size: 10,
  sha256: 'a'.repeat(64),
  storageKey: `${W}/e-1/2026-09/${id}.pdf`,
  period: '2026-09',
  uploadedById: 'u-1',
  uploadedAt: new Date('2026-10-01T00:00:00Z'),
  ...extra,
})

const expense = (id: string, itemNumber: string, reportLine: string, totalCost: string) => ({
  id,
  workspaceId: W,
  engagementId: 'e-1',
  monthlyReportId: 'r-sep',
  itemNumber,
  date: new Date('2026-09-25T00:00:00Z'),
  vendor: 'PayPeople Payroll',
  memo: null,
  account: null,
  totalCost,
  allocatedAmount: totalCost,
  allocationType: 'direct',
  allocationNote: null,
  reportLine,
  tags: [],
})
const EXPENSES = [
  expense('x-13', 'RYS-13', 'wex', '2240.00'),
  expense('x-15', 'RYS-15', 'program-costs', '84.00'),
]
const PARTICIPANT = { id: 'p-1', displayName: 'Riley Example', participantId: 'P-0002' }
const WEX = {
  id: 'w-1',
  workspaceId: W,
  monthlyReportId: 'r-sep',
  participantId: 'p-1',
  payPeriodStart: new Date('2026-09-07T00:00:00Z'),
  payPeriodEnd: new Date('2026-09-20T00:00:00Z'),
  hours: '16.00',
  grossAmount: '224.00',
  tags: [],
}

const pick = <T extends Record<string, unknown>>(rows: T[], where: Record<string, unknown> = {}) =>
  rows.filter((r): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === 'object' && 'in' in v)
        return (v.in as string[]).includes(r[k] as string)
      if (k === 'AND') return true
      if (k === 'OR') return (v as Record<string, unknown>[]).some((w) => pick([r], w).length > 0)
      return r[k] === v
    })
  )

type Link = Record<string, unknown> & { documentId: string; purpose: string }

/** An in-memory workspace: one engagement, a September of `status` with a payroll line, a program cost and a WEX payment. */
function setup(status = 'draft', docs: Row[] = []) {
  const stored: Row[] = [...docs]
  const expenseLinks: Link[] = []
  const wexLinks: Link[] = []
  const withDocs = (links: Link[], key: string, id: string) =>
    links
      .filter((l) => l[key] === id)
      .map((l) => ({ ...l, document: stored.find((d) => d.id === l.documentId)! }))
  const month = () => ({
    id: 'r-sep',
    workspaceId: W,
    engagementId: 'e-1',
    period: '2026-09',
    status,
    dueDate: new Date('2026-10-12T00:00:00Z'),
    submittedAt: null,
    preparedByName: null,
    authorizedByName: null,
    authorizedAt: null,
    comments: null,
    closingNote: null,
    sentBackReason: null,
    isFinal: false,
    engagement: {
      id: 'e-1',
      workspaceId: W,
      kind: 'grant',
      name: 'Coding Pathway',
      number: 'DEMO-1',
      funder: 'Demo Workforce Board',
      periodStart: null,
      periodEnd: null,
      tags: [],
      reportDueDay: 12,
      awardAmount: null,
      workspace: { id: W, name: 'Riverbend Youth Services', tagTypes: [] },
      eligibilityItems: [],
      reportTo: null,
      preparerName: null,
      preparerOrganization: null,
      authorizerName: null,
      authorizerOrganization: null,
      budgetLines: [],
      participants: [],
    },
    expenses: EXPENSES.map((e) => ({ ...e, documents: withDocs(expenseLinks, 'expenseId', e.id) })),
    wexPayments: [
      { ...WEX, participant: PARTICIPANT, documents: withDocs(wexLinks, 'wexPaymentId', WEX.id) },
    ],
    checks: [],
    reopenings: [],
  })
  const linkDelegate = (links: Link[]) => ({
    findFirst: jest.fn(
      async ({ where }: { where: Record<string, unknown> }) => pick(links, where)[0] ?? null
    ),
    create: jest.fn(async ({ data }: { data: Link }) => {
      const l = { ...data, workspaceId: W }
      links.push(l)
      return l
    }),
    update: jest.fn(
      async ({ where, data }: { where: Record<string, Record<string, unknown>>; data: object }) => {
        const l = pick(links, Object.values(where)[0])[0]!
        Object.assign(l, data)
        return l
      }
    ),
    deleteMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const gone = pick(links, where)
      for (const l of gone) links.splice(links.indexOf(l), 1)
      return { count: gone.length }
    }),
  })
  const prisma = {
    engagement: { findFirst: jest.fn(async () => ({ id: 'e-1', workspaceId: W })) },
    monthlyReport: {
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        pick([month() as unknown as Record<string, unknown>], where).length ? month() : null
      ),
    },
    expense: {
      findFirst: jest.fn(
        async ({ where }: { where: Record<string, unknown> }) => pick(EXPENSES, where)[0] ?? null
      ),
      findMany: jest.fn().mockResolvedValue([]),
    },
    wexPayment: {
      // The participants' pay before this month, counted on its budget line.
      groupBy: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(
        async ({ where }: { where: Record<string, unknown> }) => pick([WEX], where)[0] ?? null
      ),
    },
    check: { findMany: jest.fn().mockResolvedValue([]) },
    document: {
      findFirst: jest.fn(
        async ({ where }: { where: Record<string, unknown> }) => pick(stored, where)[0] ?? null
      ),
      findMany: jest.fn(
        async ({
          where,
          orderBy,
          take,
        }: {
          where: Record<string, unknown>
          orderBy?: { uploadedAt?: 'asc' | 'desc' }
          take?: number
        }) => {
          const rows = pick(stored, where)
          if (orderBy?.uploadedAt === 'desc')
            rows.sort((a, b) => +(b.uploadedAt as Date) - +(a.uploadedAt as Date))
          return take ? rows.slice(0, take) : rows
        }
      ),
      count: jest.fn(
        async ({ where }: { where: Record<string, unknown> }) => pick(stored, where).length
      ),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const d = doc(`d-${stored.length + 1}`, { ...data, uploadedAt: new Date() })
        stored.push(d)
        return d
      }),
      delete: jest.fn(async ({ where }: { where: { id: string } }) => {
        const d = stored.find((x) => x.id === where.id)!
        stored.splice(stored.indexOf(d), 1)
        return d
      }),
    },
    expenseDocument: linkDelegate(expenseLinks),
    wexPaymentDocument: linkDelegate(wexLinks),
  }
  const bytes = new Map<string, Buffer>()
  const storage = {
    upload: jest.fn(async (key: string, buffer: Buffer) => void bytes.set(key, buffer)),
    delete: jest.fn(),
    getSignedUrl: jest.fn(),
    deleteByPrefix: jest.fn(),
    putFile: jest.fn(),
    read: jest.fn(async (key: string) => {
      const b = bytes.get(key)
      if (!b) throw new Error(`no object ${key}`)
      return b
    }),
  }
  for (const d of docs) bytes.set(d.storageKey as string, STATEMENT)
  const checks = { refresh: jest.fn().mockResolvedValue([]) }
  const log = fakeLog(prisma)
  const reports = new ReportsService(prisma as never, checks as never, log as never)
  const documents = new DocumentsService(
    prisma as never,
    log as never,
    storage as never,
    reports,
    {} as never,
    {} as never,
    { record: jest.fn() } as never
  )
  const s = new PayrollService(
    prisma as never,
    log as never,
    checks as never,
    reports,
    documents,
    storage as never
  )
  const writes = [
    prisma.document.create,
    prisma.expenseDocument.create,
    prisma.expenseDocument.update,
    prisma.wexPaymentDocument.create,
    prisma.wexPaymentDocument.update,
    storage.upload,
  ]
  return { s, log, stored, storage, bytes, expenseLinks, wexLinks, writes, checks }
}

const bookkeeper = member('bookkeeper')
const LINE = { page: 2, x: 48, y: 677, width: 520, height: 14.4, text: 'PAYPEOPLE PAYROLL' }

describe('PayrollService', () => {
  it('uploads many payroll documents to the month, each with its kind, unlinked and unread', async () => {
    const { s, stored, storage, log } = setup()
    const out = await s.upload(
      bookkeeper,
      'r-sep',
      [
        file('statement.pdf', STATEMENT),
        file('register.pdf', STATEMENT),
        file('stub.pdf', STATEMENT),
      ],
      ['bank-statement', 'payroll-register', 'paystub']
    )
    expect(out.uploaded).toBe(3)
    expect(out.documentIds).toEqual(stored.map((d) => d.id))
    expect(storage.upload).toHaveBeenCalledTimes(3)
    expect(storage.read).not.toHaveBeenCalled()
    expect(stored.map((d) => [d.kind, d.sensitivity, d.period, d.engagementId])).toEqual([
      ['bank-statement', 'financial', '2026-09', 'e-1'],
      ['payroll-register', 'financial', '2026-09', 'e-1'],
      ['paystub', 'personal', '2026-09', 'e-1'],
    ])
    expect(stored[0]!.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(stored[0]!.size).toBe(STATEMENT.length)
    expect(log.entries.map((e) => e.description)).toEqual([
      "Uploaded a bank statement for September 2026 with the month's payroll",
      "Uploaded a payroll register for September 2026 with the month's payroll",
      "Uploaded a pay stub for September 2026 (personal) with the month's payroll",
    ])
    expect(out.report.payrollDocuments.map((d) => d.kind)).toEqual([
      'bank-statement',
      'payroll-register',
      'paystub',
    ])
  })

  it('replaces the month’s earlier payroll files: detached from their items, removed, each logged', async () => {
    const { s, stored, expenseLinks, storage, log, checks } = setup('draft', [doc('d-stmt')])
    await s.link(bookkeeper, 'expense', 'x-13', { documentId: 'd-stmt', mark: LINE })
    log.entries.length = 0
    const page = await s.replace(bookkeeper, 'r-sep', ['d-stmt'])
    expect(stored.map((d) => d.id)).toEqual([])
    expect(expenseLinks).toEqual([])
    expect(storage.delete).toHaveBeenCalledTimes(1)
    expect(log.entries.map((e) => e.description)).toEqual([
      "Removed a bank statement for September 2026 when replacing the month's payroll files",
    ])
    expect(checks.refresh).toHaveBeenCalledWith('r-sep')
    expect(page.payrollDocuments).toEqual([])
  })

  it('replaces only this month’s payroll files, and nothing in a month that is not a draft', async () => {
    const other = setup('draft', [
      doc('d-aug', { period: '2026-08' }),
      doc('d-inv', { kind: 'invoice' }),
    ])
    await expect(other.s.replace(bookkeeper, 'r-sep', ['d-aug'])).rejects.toThrow(
      BadRequestException
    )
    await expect(other.s.replace(bookkeeper, 'r-sep', ['d-inv'])).rejects.toThrow(
      BadRequestException
    )
    await expect(other.s.replace(bookkeeper, 'r-sep', [])).rejects.toThrow(BadRequestException)
    expect(other.stored).toHaveLength(2)
    const closed = setup('closed', [doc('d-stmt')])
    await expect(closed.s.replace(bookkeeper, 'r-sep', ['d-stmt'])).rejects.toThrow()
    expect(closed.stored).toHaveLength(1)
  })

  it('stores nothing when a kind is missing or not a payroll kind, or a file is refused', async () => {
    const { s, writes, log } = setup()
    const one = [file('a.pdf', STATEMENT)]
    await expect(s.upload(bookkeeper, 'r-sep', one, undefined)).rejects.toThrow(BadRequestException)
    await expect(s.upload(bookkeeper, 'r-sep', one, ['invoice'])).rejects.toThrow(
      BadRequestException
    )
    await expect(
      s.upload(bookkeeper, 'r-sep', [...one, ...one], ['bank-statement'])
    ).rejects.toThrow(BadRequestException)
    await expect(
      s.upload(
        bookkeeper,
        'r-sep',
        [...one, file('b.png', STATEMENT, 'image/png')],
        ['bank-statement', 'paystub']
      )
    ).rejects.toThrow('does not look like a png')
    // One file, one kind: multipart sends a single field as a string.
    await s.upload(bookkeeper, 'r-sep', one, 'bank-statement')
    expect(writes[0]).toHaveBeenCalledTimes(1)
    expect(log.entries).toHaveLength(1)
  })

  it("finds a payroll line's amount on the month's bank statement, page and box, and logs the search", async () => {
    const { s, log, storage, bytes } = setup('draft', [
      doc('d-stmt'),
      doc('d-scan'),
      doc('d-stub', { kind: 'paystub', sensitivity: 'personal' }),
    ])
    bytes.set(`${W}/e-1/2026-09/d-scan.pdf`, SCANNED)
    const out = await s.findLines(bookkeeper, 'expense', 'x-13')
    expect(out.amount).toBe(2240)
    expect(out.statements.map((x) => [x.document.id, x.pages, x.scanned])).toEqual([
      ['d-stmt', 2, false],
      ['d-scan', 1, true],
    ])
    expect(out.statements[0]!.lines).toEqual([
      expect.objectContaining({ page: 2, text: expect.stringContaining('PAYPEOPLE PAYROLL') }),
    ])
    expect(out.statements[1]!.lines).toEqual([])
    // The pay stub is never read.
    expect(storage.read.mock.calls.map((c) => c[0])).toEqual([
      `${W}/e-1/2026-09/d-stmt.pdf`,
      `${W}/e-1/2026-09/d-scan.pdf`,
    ])
    expect(log.entries).toEqual([
      expect.objectContaining({
        resource: 'document',
        action: 'read',
        description:
          'Searched 2 bank statements for September 2026 for the line that pays expense RYS-13',
      }),
    ])
  })

  it('searches the newest statements first and says how many were not searched', async () => {
    const statements = Array.from({ length: 12 }, (_, i) =>
      doc(`d-${String(i + 1).padStart(2, '0')}`, {
        uploadedAt: new Date(Date.UTC(2026, 9, i + 1)),
      })
    )
    const { s } = setup('draft', statements)
    const out = await s.findLines(bookkeeper, 'expense', 'x-13')
    expect(out.statements.map((x) => x.document.id)).toEqual(
      ['12', '11', '10', '09', '08', '07', '06', '05', '04', '03'].map((n) => `d-${n}`)
    )
    expect(out.notSearched).toBe(2)
    const one = await setup('draft', [doc('d-stmt')]).s.findLines(bookkeeper, 'expense', 'x-13')
    expect(one.notSearched).toBe(0)
  })

  it('refuses to mark a line on a statement filed under another month, and changes nothing', async () => {
    const { s, writes } = setup('draft', [
      doc('d-aug', { period: '2026-08', storageKey: `${W}/e-1/2026-08/d-aug.pdf` }),
      doc('d-none', { period: null, storageKey: `${W}/e-1/general/d-none.pdf` }),
    ])
    await expect(
      s.link(bookkeeper, 'expense', 'x-13', { documentId: 'd-aug', mark: LINE })
    ).rejects.toThrow(
      'This statement is filed under August 2026. Mark the line on a statement of September 2026'
    )
    await expect(
      s.link(bookkeeper, 'wex', 'w-1', { documentId: 'd-none', mark: LINE })
    ).rejects.toThrow(BadRequestException)
    for (const w of writes) expect(w).not.toHaveBeenCalled()
  })

  it('finds a work-experience payment by its gross pay, and only links payroll lines', async () => {
    const { s, log } = setup('draft', [doc('d-stmt')])
    const out = await s.findLines(bookkeeper, 'wex', 'w-1')
    expect(out.statements[0]!.lines.map((l) => l.text)).toEqual([
      expect.stringContaining('-224.00'),
    ])
    expectNoneOf(log.entries, ['Riley Example', 'P-0002', '224'])
    await expect(s.findLines(bookkeeper, 'expense', 'x-15')).rejects.toThrow(BadRequestException)
  })

  it('links the line as evidence of payment with its mark, logs page by value and text by name, and changes it', async () => {
    const { s, log, expenseLinks } = setup('draft', [doc('d-stmt')])
    let page = await s.link(bookkeeper, 'expense', 'x-13', { documentId: 'd-stmt', mark: LINE })
    expect(expenseLinks).toEqual([
      expect.objectContaining({
        expenseId: 'x-13',
        documentId: 'd-stmt',
        purpose: 'payment',
        mark: LINE,
      }),
    ])
    expect(page.expenses[0]!.documents).toEqual([
      expect.objectContaining({ purpose: 'payment', mark: LINE }),
    ])
    // The same mark again changes nothing and logs nothing.
    await s.link(bookkeeper, 'expense', 'x-13', { documentId: 'd-stmt', mark: LINE })
    page = await s.link(bookkeeper, 'expense', 'x-13', {
      documentId: 'd-stmt',
      mark: { page: 1, x: 100, y: 600, width: 200, height: 12 },
    })
    expect(expenseLinks).toHaveLength(1)
    expect(log.entries.map((e) => [e.resource, e.description, e.changes])).toEqual([
      [
        'expense',
        'Linked a bank statement for September 2026 to expense RYS-13 as evidence of payment and marked the line',
        [
          { field: 'Marked line: page', after: '2' },
          { field: 'Marked line: position', after: '48, 677, 520 by 14.4 points' },
          { field: 'Marked line: text' },
        ],
      ],
      [
        'expense',
        'Changed the marked line on the bank statement for September 2026 for expense RYS-13',
        [
          { field: 'Marked line: page', before: '2', after: '1' },
          {
            field: 'Marked line: position',
            before: '48, 677, 520 by 14.4 points',
            after: '100, 600, 200 by 12 points',
          },
          { field: 'Marked line: text' },
        ],
      ],
    ])
    expectNoneOf(log.entries, ['PAYPEOPLE'])
  })

  it("links a work-experience payment's line without naming the participant", async () => {
    const { s, log, wexLinks } = setup('draft', [doc('d-stmt')])
    const page = await s.link(bookkeeper, 'wex', 'w-1', { documentId: 'd-stmt', mark: LINE })
    expect(wexLinks).toEqual([
      expect.objectContaining({ wexPaymentId: 'w-1', purpose: 'payment', mark: LINE }),
    ])
    expect(page.wexPayments[0]!.documents[0]!.mark).toEqual(LINE)
    expect(log.entries[0]).toMatchObject({
      resource: 'report',
      description:
        'Linked a bank statement for September 2026 to a work-experience payment in September 2026 as evidence of payment and marked the line',
    })
    expectNoneOf(log.entries, ['Riley Example', 'P-0002'])
  })

  it.each([
    [{ ...LINE, page: 3 }, 'The statement has 2 pages'],
    [{ ...LINE, page: 0 }, 'whole number'],
    [{ ...LINE, page: 1.5 }, 'whole number'],
    [{ ...LINE, width: 0 }, 'width and height'],
    [{ ...LINE, height: -4 }, 'width and height'],
    [{ ...LINE, x: 500 }, 'on the page'],
    [{ ...LINE, y: Number.NaN }, 'must be a number'],
    [{ ...LINE, text: 'x'.repeat(301) }, 'at most 300'],
  ])('refuses a mark that is not on the statement: %j', async (mark, message) => {
    const { s, writes, log } = setup('draft', [doc('d-stmt')])
    await expect(
      s.link(bookkeeper, 'expense', 'x-13', { documentId: 'd-stmt', mark })
    ).rejects.toThrow(message)
    for (const w of writes) expect(w).not.toHaveBeenCalled()
    expect(log.entries).toEqual([])
  })

  it('never reads or marks a pay stub or any document that is not a bank statement', async () => {
    const { s, storage, writes } = setup('draft', [
      doc('d-stub', { kind: 'paystub', sensitivity: 'personal' }),
      doc('d-reg', { kind: 'payroll-register' }),
      doc('d-other', { workspaceId: 'ws-2', storageKey: 'ws-2/e-9/2026-09/d-other.pdf' }),
    ])
    for (const documentId of ['d-stub', 'd-reg'])
      await expect(
        s.link(bookkeeper, 'expense', 'x-13', { documentId, mark: LINE })
      ).rejects.toThrow(BadRequestException)
    await expect(
      s.link(bookkeeper, 'expense', 'x-13', { documentId: 'd-other', mark: LINE })
    ).rejects.toThrow(NotFoundException)
    const out = await s.findLines(bookkeeper, 'expense', 'x-13')
    expect(out.statements).toEqual([])
    expect(storage.read).not.toHaveBeenCalled()
    for (const w of writes) expect(w).not.toHaveBeenCalled()
  })

  it("serves a bank statement's bytes to any member for the viewer, with one read line per open", async () => {
    const { s, log } = setup('submitted', [doc('d-stmt')])
    for (const who of [bookkeeper, member('auditor'), member('owner')])
      expect((await s.statementFile(who, 'd-stmt')).equals(STATEMENT)).toBe(true)
    expect(log.entries).toHaveLength(3)
    expect(log.entries[0]).toMatchObject({
      resource: 'document',
      subjectId: 'd-stmt',
      action: 'read',
      description: 'Opened a bank statement for September 2026',
    })
  })

  it('never serves a personal document or anything but a PDF bank statement, and 404s another workspace', async () => {
    const { s, log, storage } = setup('draft', [
      doc('d-stub', { kind: 'paystub', sensitivity: 'personal' }),
      doc('d-reg', { kind: 'payroll-register' }),
      doc('d-png', { contentType: 'image/png' }),
      doc('d-stmt'),
    ])
    for (const id of ['d-stub', 'd-reg', 'd-png'])
      await expect(s.statementFile(member('owner'), id)).rejects.toThrow(BadRequestException)
    await expect(s.statementFile(stranger(), 'd-stmt')).rejects.toThrow(NotFoundException)
    await expect(s.statementFile(bookkeeper, 'nope')).rejects.toThrow(NotFoundException)
    expect(storage.read).not.toHaveBeenCalled()
    expect(log.entries).toEqual([])
  })

  it('lets an auditor change nothing, and answers another workspace with 404', async () => {
    const { s, writes, log } = setup('draft', [doc('d-stmt')])
    const tries = (who: Caller) => [
      () => s.upload(who, 'r-sep', [file('a.pdf', STATEMENT)], ['bank-statement']),
      () => s.findLines(who, 'expense', 'x-13'),
      () => s.findLines(who, 'wex', 'w-1'),
      () => s.link(who, 'expense', 'x-13', { documentId: 'd-stmt', mark: LINE }),
      () => s.link(who, 'wex', 'w-1', { documentId: 'd-stmt', mark: LINE }),
    ]
    for (const t of tries(member('auditor'))) await expect(t()).rejects.toThrow(ForbiddenException)
    for (const t of tries(stranger())) await expect(t()).rejects.toThrow(NotFoundException)
    for (const w of writes) expect(w).not.toHaveBeenCalled()
    expect(log.entries).toEqual([])
  })

  it.each(['closed', 'submitted'])(
    'refuses uploads, links and marks in a %s month',
    async (status) => {
      const { s, writes, log } = setup(status, [doc('d-stmt')])
      for (const t of [
        () => s.upload(bookkeeper, 'r-sep', [file('a.pdf', STATEMENT)], ['bank-statement']),
        () => s.findLines(bookkeeper, 'expense', 'x-13'),
        () => s.link(bookkeeper, 'expense', 'x-13', { documentId: 'd-stmt', mark: LINE }),
        () => s.link(bookkeeper, 'wex', 'w-1', { documentId: 'd-stmt', mark: LINE }),
      ])
        await expect(t()).rejects.toThrow(ConflictException)
      for (const w of writes) expect(w).not.toHaveBeenCalled()
      expect(log.entries).toEqual([])
    }
  )
})
