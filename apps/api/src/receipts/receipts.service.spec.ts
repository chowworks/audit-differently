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
import { fakeLog } from '../core/testing/log'
import { DocumentsService } from '../documents/documents.service'
import { ReportsService } from '../reports/reports.service'
import { ReceiptsService } from './receipts.service'

/** The SDK's client, with its messages.create replaced: no request ever leaves a test. */
const mockCreate = jest.fn()
jest.mock('@anthropic-ai/sdk', () => {
  const actual = jest.requireActual('@anthropic-ai/sdk')
  class Mocked extends actual.default {
    constructor(options: object) {
      super(options)
      ;(this as unknown as { messages: unknown }).messages = {
        create: (...a: unknown[]) => mockCreate(...a),
      }
    }
  }
  return { ...actual, __esModule: true, default: Mocked }
})

/**
 * A month's receipts: uploaded many at once, read, matched automatically only on one strong candidate, matched,
 * unmatched and dismissed by a person, each change logged; locked months refuse, auditors change nothing, another
 * workspace's receipt is a 404, and personal documents are never listed or matched.
 */
const fixture = (name: string) =>
  readFileSync(join(__dirname, '../../test/fixtures/receipts', name))
const pdf = (name: string) => {
  const buffer = fixture(name)
  return { originalname: name, mimetype: 'application/pdf', size: buffer.length, buffer }
}
const RECEIPTS = [
  pdf('bright-path-office-supply.pdf'),
  pdf('summit-laptop-rentals.pdf'),
  pdf('fern-hollow-mileage.pdf'),
]

type Doc = Record<string, unknown> & { id: string; workspaceId: string }
type Link = { expenseId: string; documentId: string; purpose: string; workspaceId: string }

const exp = (id: string, itemNumber: string, date: string, vendor: string, totalCost: string) => ({
  id,
  workspaceId: W,
  engagementId: 'e-1',
  monthlyReportId: 'r-sep',
  itemNumber,
  date: new Date(`${date}T00:00:00Z`),
  vendor,
  memo: null,
  account: null,
  totalCost,
  allocatedAmount: totalCost,
  allocationType: 'direct',
  allocationNote: null,
  reportLine: 'program-costs',
  tags: [],
})
const SEPTEMBER = [
  exp('x-2105', '2105', '2026-09-02', 'Bright Path Office Supply', '212.18'),
  exp('x-2107', '2107', '2026-09-10', 'Summit Laptop Rentals', '1480.00'),
  exp('x-2108', '2108', '2026-09-14', 'Lakeside Transit Co.', '320.00'),
  exp('x-2116', '2116', '2026-09-16', 'Fern Hollow Mileage Service', '86.25'),
]

const doc = (id: string, extra: Record<string, unknown> = {}): Doc => ({
  id,
  workspaceId: W,
  engagementId: 'e-1',
  kind: 'receipt',
  sensitivity: 'financial',
  fileName: `${id}.pdf`,
  contentType: 'application/pdf',
  size: 10,
  sha256: 'a'.repeat(64),
  storageKey: `${W}/e-1/2026-09/${id}.pdf`,
  period: '2026-09',
  uploadedById: 'u-1',
  uploadedAt: new Date('2026-10-01T00:00:00Z'),
  receiptAmount: null,
  receiptDate: null,
  receiptVendor: null,
  receiptReadBy: null,
  receiptDismissed: false,
  ...extra,
})

const pick = <T extends Record<string, unknown>>(rows: T[], where: Record<string, unknown> = {}) =>
  rows.filter((r) =>
    Object.entries(where).every(([k, v]) => {
      if (k === 'workspaceId' && v && typeof v === 'object' && 'in' in v)
        return (v.in as string[]).includes(r.workspaceId as string)
      if (k === 'kind' && v && typeof v === 'object' && 'in' in v)
        return (v.in as string[]).includes(r.kind as string)
      if (k === 'AND') return true
      return r[k] === v
    })
  )

/** An in-memory workspace: one engagement, a September of `status` with four expenses, and `docs`. */
function setup(status = 'draft', docs: Doc[] = [], expenses = SEPTEMBER) {
  const links: Link[] = []
  const stored: Doc[] = [...docs]
  const withLinks = (d: Doc) => ({
    ...d,
    expenses: links
      .filter((l) => l.documentId === d.id)
      .map((l) => ({ purpose: l.purpose, expense: expenses.find((e) => e.id === l.expenseId)! })),
    _count: { expenses: links.filter((l) => l.documentId === d.id).length },
  })
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
    expenses: expenses.map((e) => ({
      ...e,
      documents: links
        .filter((l) => l.expenseId === e.id)
        .map((l) => ({ ...l, document: stored.find((d) => d.id === l.documentId)! })),
    })),
    wexPayments: [],
    checks: [],
    reopenings: [],
  })
  /** Every row locked with SELECT ... FOR UPDATE, as [sql, ...values]. */
  const locks: unknown[][] = []
  const prisma = {
    $queryRaw: jest.fn(async (sql: TemplateStringsArray, ...values: unknown[]) => {
      locks.push([sql.join('?'), ...values])
      return []
    }),
    engagement: { findFirst: jest.fn(async () => ({ id: 'e-1', workspaceId: W })) },
    monthlyReport: {
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const m = month()
        const ok = pick([m as unknown as Record<string, unknown>], where).length > 0
        return ok ? m : null
      }),
    },
    expense: { findMany: jest.fn().mockResolvedValue([]) },
    // The participants' pay before this month, counted on its budget line.
    wexPayment: { groupBy: jest.fn().mockResolvedValue([]) },
    check: { findMany: jest.fn().mockResolvedValue([]) },
    document: {
      // The month's files, for the report's "delete an empty month": never empty here.
      count: jest.fn().mockResolvedValue(1),
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const d = pick(stored, where)[0]
        return d ? withLinks(d) : null
      }),
      findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        pick(stored, where).map(withLinks)
      ),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const d = doc(`d-${stored.length + 1}`, { ...data, uploadedAt: new Date() })
        stored.push(d)
        return d
      }),
      update: jest.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const d = stored.find((x) => x.id === where.id)!
          Object.assign(d, data)
          return d
        }
      ),
    },
    expenseDocument: {
      findFirst: jest.fn(
        async ({ where }: { where: Record<string, unknown> }) => pick(links, where)[0] ?? null
      ),
      create: jest.fn(async ({ data }: { data: Omit<Link, 'workspaceId'> }) => {
        const l = { ...data, workspaceId: W }
        links.push(l)
        return l
      }),
      update: jest.fn(),
      deleteMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const gone = pick(links, where)
        for (const g of gone) links.splice(links.indexOf(g), 1)
        return { count: gone.length }
      }),
    },
  }
  const storage = {
    upload: jest.fn(),
    delete: jest.fn(),
    getSignedUrl: jest.fn(),
    deleteByPrefix: jest.fn(),
    putFile: jest.fn(),
    read: jest.fn(),
  }
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
  const stats = { record: jest.fn() }
  const s = new ReceiptsService(
    prisma as never,
    log as never,
    checks as never,
    reports,
    documents,
    stats as never
  )
  const writes = [
    prisma.document.create,
    prisma.document.update,
    prisma.expenseDocument.create,
    prisma.expenseDocument.update,
    prisma.expenseDocument.deleteMany,
    storage.upload,
  ]
  return { s, prisma, log, links, stored, storage, writes, locks, stats }
}

const bookkeeper = member('bookkeeper')

beforeAll(() => {
  delete process.env.ANTHROPIC_API_KEY
})

describe('ReceiptsService', () => {
  it('uploads many receipts to the month, reads each, and matches each to its one strong candidate', async () => {
    const { s, stored, links, log, storage } = setup()
    const out = await s.upload(bookkeeper, 'r-sep', RECEIPTS)
    expect(out.uploaded).toBe(3)
    expect(out.matched).toBe(3)
    expect(storage.upload).toHaveBeenCalledTimes(3)
    expect(stored[0]).toMatchObject({
      kind: 'receipt',
      sensitivity: 'financial',
      period: '2026-09',
      engagementId: 'e-1',
      size: RECEIPTS[0]!.size,
      receiptAmount: '212.18',
      receiptVendor: 'Bright Path Office Supply',
      receiptReadBy: 'text',
    })
    expect(stored[0]!.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(links.map((l) => [l.expenseId, l.purpose])).toEqual([
      ['x-2105', 'invoice'],
      ['x-2107', 'invoice'],
      ['x-2116', 'invoice'],
    ])
    expect(log.entries.map((e) => e.description)).toEqual([
      'Uploaded a receipt for September 2026 to match',
      'Matched a receipt for September 2026 to expense 2105 automatically',
      'Uploaded a receipt for September 2026 to match',
      'Matched a receipt for September 2026 to expense 2107 automatically',
      'Uploaded a receipt for September 2026 to match',
      'Matched a receipt for September 2026 to expense 2116 automatically',
    ])
    expect(log.entries[0]!.changes).toEqual([
      { field: 'Amount', after: '212.18' },
      { field: 'Date', after: '2026-09-02' },
      { field: 'Vendor', after: 'Bright Path Office Supply' },
      { field: 'Read', after: 'read from the PDF' },
    ])
    // The month's page as it now stands: every receipt matched, nothing left to suggest.
    expect(out.report.matching.receipts.every((r) => r.matchedTo.length === 1)).toBe(true)
    expect(out.report.matching.suggestions).toEqual([])
  })

  it('counts the upload for Matching statistics: counts and sizes only, never a name or an amount', async () => {
    const { s, stats } = setup()
    await s.upload(bookkeeper, 'r-sep', RECEIPTS)
    expect(stats.record).toHaveBeenCalledTimes(1)
    const [row] = stats.record.mock.calls[0]!
    expect(row).toMatchObject({
      workspaceId: W,
      feature: 'receipts',
      startedById: bookkeeper.userId,
      outcome: 'done',
      fileCount: 3,
      totalBytes: RECEIPTS.reduce((n, f) => n + f.size, 0),
      items: 3,
      matched: 3,
      missing: 0,
      failed: 0,
    })
    expect(row.readMs).toEqual(expect.any(Number))
    const text = JSON.stringify(row)
    for (const secret of ['.pdf', 'Bright Path', '212.18', 'Summit', 'd-1', 'r-sep', 'e-1'])
      expect(text).not.toContain(secret)
  })

  it('counts a refused upload as failed, and still refuses it', async () => {
    const { s, stats } = setup()
    const fake = { ...RECEIPTS[0]!, buffer: Buffer.from('not a pdf at all'), size: 16 }
    await expect(s.upload(bookkeeper, 'r-sep', [fake])).rejects.toThrow(BadRequestException)
    expect(stats.record).toHaveBeenCalledWith(
      expect.objectContaining({ feature: 'receipts', outcome: 'failed', fileCount: 1, items: 0 })
    )
  })

  it('reads with AI only when the box is ticked, every time, and says so in the line', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    try {
      const bytes = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(64),
      ])
      const photo = { originalname: 'photo.png', mimetype: 'image/png', size: 72, buffer: bytes }
      mockCreate.mockReset()
      mockCreate.mockResolvedValue({
        stop_reason: 'end_turn',
        content: [
          {
            type: 'text',
            text: '{"amount": 320, "date": "2026-09-14", "vendor": "Lakeside Transit Co."}',
          },
        ],
      })
      const { s, log, stored } = setup()
      // Unticked: never the model, even with the key.
      await s.upload(bookkeeper, 'r-sep', [photo])
      expect(mockCreate).not.toHaveBeenCalled()
      expect(stored[0]).toMatchObject({ receiptReadBy: null, receiptAmount: null })
      // Ticked: the model reads it, and the line says so.
      await s.upload(bookkeeper, 'r-sep', [photo], 'receipt', true)
      expect(mockCreate).toHaveBeenCalledTimes(1)
      expect(stored[1]).toMatchObject({ receiptReadBy: 'ai', receiptAmount: '320.00' })
      // The next upload asks again: unticked, the model is not called, whatever was said before.
      await s.upload(bookkeeper, 'r-sep', [photo])
      expect(mockCreate).toHaveBeenCalledTimes(1)
      expect(log.entries.map((e) => e.description).filter((d) => d.startsWith('Uploaded'))).toEqual(
        [
          'Uploaded a receipt for September 2026 to match',
          'Uploaded a receipt for September 2026 to match, read with AI',
          'Uploaded a receipt for September 2026 to match',
        ]
      )
    } finally {
      delete process.env.ANTHROPIC_API_KEY
    }
  })

  it('takes PDF, PNG and JPG only, sniffs the bytes, and stores nothing when any file is refused', async () => {
    const { s, writes, log } = setup()
    const xlsx = {
      originalname: 'a.xlsx',
      mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      size: 4,
      buffer: Buffer.from('PK\x03\x04'),
    }
    const fake = {
      originalname: 'b.png',
      mimetype: 'image/png',
      size: 4,
      buffer: Buffer.from('%PDF'),
    }
    await expect(s.upload(bookkeeper, 'r-sep', [RECEIPTS[0]!, xlsx])).rejects.toThrow(
      BadRequestException
    )
    await expect(s.upload(bookkeeper, 'r-sep', [RECEIPTS[0]!, fake])).rejects.toThrow(
      'does not look like a png'
    )
    await expect(s.upload(bookkeeper, 'r-sep', RECEIPTS, 'paystub')).rejects.toThrow(
      BadRequestException
    )
    for (const w of writes) expect(w).not.toHaveBeenCalled()
    expect(log.entries).toEqual([])
  })

  it("locks the expense's row before it checks and links, so two receipts matched at once cannot both prove it", async () => {
    const { s, locks, prisma } = setup()
    await s.upload(bookkeeper, 'r-sep', [RECEIPTS[0]!])
    expect(locks).toEqual([['SELECT "id" FROM "Expense" WHERE "id" = ? FOR UPDATE', 'x-2105']])
    expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.expenseDocument.create.mock.invocationCallOrder[0]!
    )
  })

  it('reads at most four receipts at a time, and keeps each read with its own file', async () => {
    const reader = jest.requireActual<typeof import('./read-receipt')>('./read-receipt')
    let running = 0
    let most = 0
    const spy = jest.spyOn(reader, 'readReceipt').mockImplementation(async () => {
      running++
      most = Math.max(most, running)
      await new Promise((r) => setTimeout(r, 5))
      running--
      return { amount: null, date: null, vendor: null, readBy: null }
    })
    const { s, stored } = setup()
    const files = Array.from({ length: 10 }, () => RECEIPTS[0]!)
    const out = await s.upload(bookkeeper, 'r-sep', files)
    expect(out.uploaded).toBe(10)
    expect(most).toBe(4)
    expect(stored).toHaveLength(10)
    spy.mockRestore()
  })

  it('unmatches only the match: the same file kept as another proof of the expense stays', async () => {
    const { s, links, log } = setup('draft', [doc('d-1')])
    links.push({ expenseId: 'x-2108', documentId: 'd-1', purpose: 'payment', workspaceId: W })
    const page = await s.unmatch(bookkeeper, 'd-1', 'x-2108')
    expect(links).toHaveLength(1)
    expect(log.entries).toEqual([])
    // Not a match either: the receipt is still among the unmatched.
    expect(page.matching.receipts[0]!.matchedTo).toEqual([])
  })

  it('does not match automatically when two expenses are strong candidates', async () => {
    const twins = [
      ...SEPTEMBER,
      exp('x-2120', '2120', '2026-09-03', 'Bright Path Office Supply', '212.18'),
    ]
    const { s, links, log } = setup('draft', [], twins)
    const out = await s.upload(bookkeeper, 'r-sep', [RECEIPTS[0]!])
    expect(out.matched).toBe(0)
    expect(links).toEqual([])
    expect(log.entries.map((e) => e.description)).toEqual([
      'Uploaded a receipt for September 2026 to match',
    ])
    expect(out.report.matching.suggestions.map((m) => m.expenseId)).toEqual(['x-2105', 'x-2120'])
  })

  it('does not match automatically to an expense that already has its invoice proof', async () => {
    const { s, links } = setup('draft', [doc('d-old')])
    links.push({ expenseId: 'x-2105', documentId: 'd-old', purpose: 'invoice', workspaceId: W })
    const out = await s.upload(bookkeeper, 'r-sep', [RECEIPTS[0]!])
    expect(out.matched).toBe(0)
    expect(links).toHaveLength(1)
  })

  it('matches, unmatches and dismisses by hand, each with its line', async () => {
    const { s, links, log, stored } = setup('draft', [
      doc('d-1', { receiptAmount: '320.00', receiptDate: new Date('2026-09-20T00:00:00Z') }),
    ])
    let page = await s.match(bookkeeper, 'd-1', 'x-2108')
    expect(links).toEqual([
      { expenseId: 'x-2108', documentId: 'd-1', purpose: 'invoice', workspaceId: W },
    ])
    expect(page.matching.receipts[0]!.matchedTo).toEqual([
      { expenseId: 'x-2108', itemNumber: '2108' },
    ])
    await expect(s.dismiss(bookkeeper, 'd-1', true)).rejects.toThrow(ConflictException)
    page = await s.unmatch(bookkeeper, 'd-1', 'x-2108')
    expect(links).toEqual([])
    page = await s.dismiss(bookkeeper, 'd-1', true)
    expect(stored[0]!.receiptDismissed).toBe(true)
    expect(page.matching.receipts[0]!.dismissed).toBe(true)
    expect(page.matching.suggestions).toEqual([])
    await expect(s.match(bookkeeper, 'd-1', 'x-2108')).rejects.toThrow(ConflictException)
    await s.dismiss(bookkeeper, 'd-1', false)
    expect(log.entries.map((e) => [e.resource, e.description])).toEqual([
      ['expense', 'Matched a receipt for September 2026 to expense 2108'],
      ['expense', 'Unmatched a receipt for September 2026 from expense 2108'],
      ['document', 'Marked a receipt for September 2026 as not for this grant'],
      ['document', 'Brought back a receipt for September 2026 to match'],
    ])
    expect(log.entries[2]!.changes).toEqual([
      { field: 'Not for this grant', before: 'no', after: 'yes' },
    ])
  })

  it('logs nothing for a match already made, or an unmatch of nothing', async () => {
    const { s, links, log } = setup('draft', [doc('d-1')])
    links.push({ expenseId: 'x-2108', documentId: 'd-1', purpose: 'invoice', workspaceId: W })
    await s.match(bookkeeper, 'd-1', 'x-2108')
    await s.unmatch(bookkeeper, 'd-1', 'x-2105')
    expect(log.entries).toEqual([])
  })

  it('keeps what the person types, as theirs, and logs the values', async () => {
    const { s, stored, log } = setup('draft', [
      doc('d-1', { receiptReadBy: 'text', receiptAmount: '1.00' }),
    ])
    const page = await s.edit(bookkeeper, 'd-1', {
      amount: 320,
      date: '2026-09-14',
      vendor: ' Lakeside Transit Co. ',
    })
    expect(stored[0]).toMatchObject({
      receiptAmount: '320.00',
      receiptVendor: 'Lakeside Transit Co.',
      receiptReadBy: 'person',
    })
    expect(log.entries[0]).toMatchObject({
      description: 'Changed the amount, date or vendor of a receipt for September 2026',
      changes: [
        { field: 'Amount', before: '1.00', after: '320.00' },
        { field: 'Date', before: null, after: '2026-09-14' },
        { field: 'Vendor', before: null, after: 'Lakeside Transit Co.' },
      ],
    })
    expect(page.matching.suggestions[0]).toMatchObject({ expenseId: 'x-2108', strong: true })
    await expect(
      s.edit(bookkeeper, 'd-1', { amount: -1, date: null, vendor: null })
    ).rejects.toThrow(BadRequestException)
    await expect(
      s.edit(bookkeeper, 'd-1', { amount: null, date: '2026-02-30', vendor: null })
    ).rejects.toThrow(BadRequestException)
  })

  it('lets an auditor change nothing, and answers another workspace with 404', async () => {
    const { s, writes, log } = setup('draft', [doc('d-1')])
    const tries = (who: Caller) => [
      () => s.upload(who, 'r-sep', RECEIPTS),
      () => s.match(who, 'd-1', 'x-2108'),
      () => s.unmatch(who, 'd-1', 'x-2108'),
      () => s.dismiss(who, 'd-1', true),
      () => s.edit(who, 'd-1', { amount: 1, date: null, vendor: null }),
      () => s.autoMatch(who, 'd-1'),
    ]
    for (const t of tries(member('auditor'))) await expect(t()).rejects.toThrow(ForbiddenException)
    for (const t of tries(stranger())) await expect(t()).rejects.toThrow(NotFoundException)
    for (const w of writes) expect(w).not.toHaveBeenCalled()
    expect(log.entries).toEqual([])
  })

  it.each(['closed', 'submitted'])(
    'refuses uploads, matches, unmatches and changes in a %s month',
    async (status) => {
      const { s, writes, log, links } = setup(status, [doc('d-1')])
      links.push({ expenseId: 'x-2108', documentId: 'd-1', purpose: 'invoice', workspaceId: W })
      for (const t of [
        () => s.upload(bookkeeper, 'r-sep', RECEIPTS),
        () => s.match(bookkeeper, 'd-1', 'x-2105'),
        () => s.unmatch(bookkeeper, 'd-1', 'x-2108'),
        () => s.dismiss(bookkeeper, 'd-1', true),
        () => s.edit(bookkeeper, 'd-1', { amount: 1, date: null, vendor: null }),
      ])
        await expect(t()).rejects.toThrow(ConflictException)
      expect(await s.autoMatch(bookkeeper, 'd-1')).toBeNull()
      for (const w of writes) expect(w).not.toHaveBeenCalled()
      expect(log.entries).toEqual([])
    }
  )

  it('never lists, reads or matches a personal document', async () => {
    const stub = doc('d-stub', {
      kind: 'paystub',
      sensitivity: 'personal',
      receiptAmount: null,
    })
    const { s, writes } = setup('draft', [stub, doc('d-1', { receiptAmount: '86.25' })])
    const page = await s.edit(bookkeeper, 'd-1', { amount: 86.25, date: null, vendor: null })
    expect(page.matching.receipts.map((r) => r.document.id)).toEqual(['d-1'])
    expect(page.matching.suggestions.every((m) => m.documentId !== 'd-stub')).toBe(true)
    await expect(s.match(bookkeeper, 'd-stub', 'x-2116')).rejects.toThrow(BadRequestException)
    await expect(s.dismiss(bookkeeper, 'd-stub', true)).rejects.toThrow(BadRequestException)
    expect(await s.autoMatch(bookkeeper, 'd-stub')).toBeNull()
    for (const w of writes) expect(w).not.toHaveBeenCalled()
  })
})
