import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import type { BooksBillDto, BooksLineDto } from '@ad/types'
import { member, W } from '../core/testing/callers'
import { fakeLog } from '../core/testing/log'
import { BOOKS } from './books.testing'
import { setFileDtos } from '../payroll/workspace-set'
import { ExpensesService, saveRefusal } from './expenses.service'

/**
 * Save of the month's expenses from the books, against a Prisma fake: the plan (`planOf`, read from the month's files
 * and tested in books-plan.spec.ts) is given, and the spec checks what Save writes, in what order, and what it refuses.
 * A fictional workspace: two programs, each its own engagement.
 */

const owner = member('owner')

const engagements = [
  {
    id: 'e-a',
    name: 'Youth Coding Program',
    reportDueDay: 12,
    budgetLines: [
      { id: 'bl-a', name: 'Software', reportLine: 'program-costs', amount: 1000 },
      { id: 'bl-a2', name: 'Supplies', reportLine: 'supplies', amount: 1000 },
    ],
    monthlyReports: [{ id: 'r-a-sep', period: '2026-09', status: 'draft' }],
  },
  {
    id: 'e-b',
    name: 'Adult Bootcamp',
    reportDueDay: 12,
    budgetLines: [{ id: 'bl-b', name: 'Software', reportLine: 'program-costs', amount: 1000 }],
    monthlyReports: [{ id: 'r-b-sep', period: '2026-09', status: 'draft' }],
  },
]

const KEY = '2026-09:9003:60301:Youth Coding Program:1'

const bill = (over: Partial<BooksBillDto> = {}): BooksBillDto =>
  ({
    transactionId: '9003',
    date: '2026-09-05',
    vendor: 'Pixel Tools',
    amount: 80,
    receipt: null,
    receiptChoices: [],
    payment: null,
    paymentChoices: [],
    dropped: false,
    ...over,
  }) as unknown as BooksBillDto

const line = (over: Partial<BooksLineDto> = {}): BooksLineDto => ({
  key: KEY,
  transactionId: '9003',
  date: '2026-09-05',
  type: 'Expense',
  vendor: 'Pixel Tools',
  description: 'PIXEL TOOLS',
  account: '60301 Software and Subscription',
  accountNo: '60301',
  className: 'Youth Coding Program',
  amount: 80,
  paidFrom: null,
  status: 'billed',
  engagementId: 'e-a',
  engagementName: 'Youth Coding Program',
  category: 'Software',
  budgetLineId: 'bl-a',
  budgetLineName: 'Software',
  allocation: null,
  split: null,
  bills: [bill()],
  saved: 'changed',
  ...over,
})

/** The line as Save wrote it before: on Youth Coding Program's September. */
const row = (over: Record<string, unknown> = {}) => ({
  id: 'x-1',
  engagementId: 'e-a',
  monthlyReportId: 'r-a-sep',
  itemNumber: 'QB-9003',
  vendor: 'Pixel Tools',
  date: new Date('2026-09-05T00:00:00Z'),
  allocatedAmount: '80.00',
  totalCost: '80.00',
  reportLine: 'program-costs',
  budgetLineId: 'bl-a',
  allocationNote: null,
  booksKey: KEY,
  booksBills: [],
  booksSplit: null,
  monthlyReport: { period: '2026-09', status: 'draft' },
  ...over,
})

function setup(
  plan: { lines: BooksLineDto[]; existing: ReturnType<typeof row>[] },
  db: { months?: object[]; taken?: object[]; persons?: object[] } = {}
) {
  const order: string[] = []
  const track =
    <T>(name: string, value?: T) =>
    async (args: unknown) => {
      order.push(name)
      void args
      return value
    }
  const prisma = {
    monthlyReport: {
      findMany: jest.fn(
        async () =>
          db.months ?? [
            { id: 'r-a-sep', engagementId: 'e-a', period: '2026-09', status: 'draft' },
            { id: 'r-b-sep', engagementId: 'e-b', period: '2026-09', status: 'draft' },
          ]
      ),
      create: jest.fn(async ({ data }: { data: { engagementId: string; period: string } }) => {
        order.push('monthlyReport.create')
        return { id: `r-${data.engagementId}-${data.period}`, ...data }
      }),
    },
    expense: {
      findMany: jest.fn(async () => db.taken ?? plan.existing),
      delete: jest.fn(track('expense.delete')),
      update: jest.fn(track('expense.update')),
      create: jest.fn(async ({ data }: { data: object }) => {
        order.push('expense.create')
        return { id: 'x-new', ...data }
      }),
    },
    expenseDocument: {
      findMany: jest.fn(async (args: { where: { byMatch?: boolean } }) =>
        args.where.byMatch === false ? (db.persons ?? []) : []
      ),
      deleteMany: jest.fn(track('expenseDocument.deleteMany', { count: 0 })),
      createMany: jest.fn(track('expenseDocument.createMany', { count: 0 })),
      upsert: jest.fn(track('expenseDocument.upsert')),
    },
    booksBill: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn(async ({ create }: { create: object }) => ({ id: 'bb-1', ...create })),
      deleteMany: jest.fn(),
    },
  }
  const log = fakeLog(prisma)
  const checks = { refresh: jest.fn() }
  const s = new ExpensesService(
    prisma as never,
    log as never,
    checks as never,
    {} as never,
    {} as never,
    {} as never
  )
  const full = {
    files: [],
    unread: [],
    engagements,
    aliases: [],
    receipts: [{ id: 'd-receipt', fileName: 'pixel.pdf', receiptAmount: null }],
    receiptBlocks: new Map(),
    statements: [],
    ...plan,
  }
  jest.spyOn(s as unknown as { planOf: () => Promise<unknown> }, 'planOf').mockResolvedValue(full)
  return { s, prisma, log, order, checks }
}

describe('ExpensesService.save', () => {
  it('removes a line the books moved to another engagement before writing it afresh there, never in place', async () => {
    const { s, prisma, order } = setup(
      {
        lines: [
          line({ engagementId: 'e-b', engagementName: 'Adult Bootcamp', budgetLineId: 'bl-b' }),
        ],
        existing: [row()],
      },
      // A person's own bank statement on the old line.
      {
        persons: [
          { documentId: 'd-own', purpose: 'payment', mark: null, marks: [], payRun: false },
        ],
      }
    )
    const saved = await s.save(owner, W, '2026-09')
    expect(prisma.expense.update).not.toHaveBeenCalled()
    expect(prisma.expense.delete).toHaveBeenCalledWith({ where: { id: 'x-1' } })
    expect(order.indexOf('expense.delete')).toBeLessThan(order.indexOf('expense.create'))
    expect(prisma.expense.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        engagementId: 'e-b',
        monthlyReportId: 'r-b-sep',
        budgetLineId: 'bl-b',
        itemNumber: 'QB-9003',
        booksKey: KEY,
      }),
    })
    // The person's proof is kept on the line written afresh.
    expect(prisma.expenseDocument.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ expenseId: 'x-new', documentId: 'd-own', byMatch: false })],
      skipDuplicates: true,
    })
    expect(saved).toMatchObject({ created: 0, updated: 1, removed: 0 })
  })

  it('moves a line the books now date in another month to that month, starting it when it has none', async () => {
    const { s, prisma } = setup({
      lines: [line({ date: '2026-10-02' })],
      existing: [row()],
    })
    await s.save(owner, W, '2026-09')
    expect(prisma.expense.delete).toHaveBeenCalledWith({ where: { id: 'x-1' } })
    expect(prisma.monthlyReport.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ engagementId: 'e-a', period: '2026-10' }),
    })
    expect(prisma.expense.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ monthlyReportId: 'r-e-a-2026-10' }),
    })
  })

  it('refuses to move a line out of a month no longer a draft, naming the month, and writes nothing', async () => {
    const { s, prisma, log } = setup({
      lines: [line({ engagementId: 'e-b', budgetLineId: 'bl-b' })],
      existing: [row({ monthlyReport: { period: '2026-09', status: 'submitted' } })],
    })
    const refused = s.save(owner, W, '2026-09')
    await expect(refused).rejects.toThrow(ConflictException)
    await expect(refused).rejects.toThrow(/September 2026 of Youth Coding Program/)
    expect(prisma.expense.delete).not.toHaveBeenCalled()
    expect(prisma.expense.create).not.toHaveBeenCalled()
    expect(log.entries).toEqual([])
  })

  it('refuses a save when a month it removes from was submitted meanwhile, and removes nothing', async () => {
    const { s, prisma } = setup(
      {
        lines: [],
        existing: [row()],
      },
      { months: [{ id: 'r-a-sep', engagementId: 'e-a', period: '2026-09', status: 'submitted' }] }
    )
    await expect(s.save(owner, W, '2026-09')).rejects.toThrow(
      new ConflictException('September 2026 changed meanwhile. Open the expenses again')
    )
    expect(prisma.monthlyReport.findMany).toHaveBeenCalledWith({
      where: { OR: [{ id: { in: ['r-a-sep'] } }] },
      select: { id: true, engagementId: true, period: true, status: true },
    })
    expect(prisma.expense.delete).not.toHaveBeenCalled()
  })

  it('chooses another item number when a remapped category puts a line on a report line where its number is taken', async () => {
    const other = row({
      id: 'x-typed',
      itemNumber: 'QB-9003',
      reportLine: 'supplies',
      booksKey: null,
      budgetLineId: 'bl-a2',
    })
    const { s, prisma } = setup(
      {
        lines: [line({ budgetLineId: 'bl-a2', budgetLineName: 'Supplies' })],
        existing: [row()],
      },
      { taken: [row(), other] }
    )
    await s.save(owner, W, '2026-09')
    expect(prisma.expense.update).toHaveBeenCalledWith({
      where: { id: 'x-1' },
      data: expect.objectContaining({
        budgetLineId: 'bl-a2',
        reportLine: 'supplies',
        itemNumber: 'QB-9003-2',
      }),
    })
  })

  it("links the bills' proofs as Save's own, and never changes or removes a person's", async () => {
    const pays = (documentId: string) =>
      ({
        documentId,
        line: { page: 1, x: 1, y: 2, width: 3, height: 4, text: 'PIXEL TOOLS 80.00' },
      }) as never
    const { s, prisma } = setup(
      {
        lines: [
          line({
            amount: 90,
            bills: [
              bill({ receipt: { documentId: 'd-receipt' } as never, payment: pays('d-own') }),
              bill({ transactionId: '9010', payment: pays('d-bank') }),
            ],
          }),
        ],
        existing: [
          row({
            booksBills: [
              {
                transactionId: '9003',
                documentId: 'd-old-receipt',
                payment: { documentId: 'd-old-bank' },
              },
            ],
          }),
        ],
      },
      { persons: [{ documentId: 'd-own' }] }
    )
    await s.save(owner, W, '2026-09')
    expect(prisma.expenseDocument.deleteMany).toHaveBeenCalledWith({
      where: {
        expenseId: 'x-1',
        purpose: 'invoice',
        byMatch: true,
        documentId: { in: ['d-old-receipt'] },
      },
    })
    expect(prisma.expenseDocument.deleteMany).toHaveBeenCalledWith({
      where: {
        expenseId: 'x-1',
        purpose: 'payment',
        byMatch: true,
        documentId: { in: ['d-old-bank'] },
      },
    })
    expect(prisma.expenseDocument.createMany).toHaveBeenCalledWith({
      data: [{ expenseId: 'x-1', documentId: 'd-receipt', purpose: 'invoice', byMatch: true }],
      skipDuplicates: true,
    })
    // The person's statement link stays as it is; the matched one is Save's.
    expect(prisma.expenseDocument.upsert).toHaveBeenCalledTimes(1)
    expect(prisma.expenseDocument.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { expenseId_documentId: { expenseId: 'x-1', documentId: 'd-bank' } },
      })
    )
    for (const [args] of prisma.expenseDocument.deleteMany.mock.calls)
      expect((args as { where: { byMatch?: boolean } }).where.byMatch).toBe(true)
  })
})

describe('saveRefusal', () => {
  const known = (code: string, meta: Record<string, unknown>) =>
    new Prisma.PrismaClientKnownRequestError('refused', { code, clientVersion: '5', meta })

  it('says the expenses were saved a moment ago only for the books key', () => {
    expect(saveRefusal(known('P2002', { target: ['engagementId', 'booksKey'] }))).toEqual(
      new ConflictException('These expenses were saved a moment ago. Open them again')
    )
    expect(
      saveRefusal(known('P2002', { target: ['engagementId', 'itemNumber', 'reportLine'] }))
    ).toEqual(new ConflictException('An item number Save chose was taken meanwhile. Save again'))
  })

  it("answers a trigger's check (23514) with a 409 in plain words, and passes anything else on", () => {
    const trigger = new Prisma.PrismaClientUnknownRequestError(
      'Error occurred during query execution: ConnectorError(... PostgresError { code: "23514", message: "An expense\'s budget line is one of its own engagement\'s" ...',
      { clientVersion: '5' }
    )
    expect(saveRefusal(trigger)).toBeInstanceOf(ConflictException)
    expect(saveRefusal(known('P2010', { code: '23514' }))).toBeInstanceOf(ConflictException)
    const other = new Error('boom')
    expect(saveRefusal(other)).toBe(other)
  })
})

describe("ExpensesService: the month's page", () => {
  it('lists the lines Save would remove, and names a sheet that could not be read', async () => {
    const { s } = setup({ lines: [], existing: [row()] })
    ;(s as unknown as { planOf: jest.Mock }).planOf.mockResolvedValue({
      files: [],
      unread: ['broken.xlsx'],
      engagements,
      aliases: [],
      receipts: [],
      receiptBlocks: new Map(),
      statements: [],
      lines: [],
      existing: [
        row(),
        row({ id: 'x-closed', monthlyReport: { period: '2026-09', status: 'submitted' } }),
      ],
    })
    const page = await s.expenses(owner, W, '2026-09')
    expect(page.toRemove).toEqual([
      { id: 'x-1', itemNumber: 'QB-9003', vendor: 'Pixel Tools', amount: 80 },
    ])
    expect(page.unread).toEqual(['broken.xlsx'])
  })

  it('reads only the sheets among the payroll details, and leaves out one that cannot be read', async () => {
    const csv = BOOKS.map((r) =>
      r.text
        .split(' | ')
        .map((c) => `"${c.replace(/"/g, '""')}"`)
        .join(',')
    ).join('\n')
    const docs = [
      {
        id: 'd-bad',
        fileName: 'broken.xlsx',
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        storageKey: `${W}/workspace/2026-09/bad.xlsx`,
        workspaceId: W,
      },
      {
        id: 'd-csv',
        fileName: 'transactions.csv',
        contentType: 'text/csv',
        storageKey: `${W}/workspace/2026-09/t.csv`,
        workspaceId: W,
      },
    ]
    const prisma = { document: { findMany: jest.fn().mockResolvedValue(docs) } }
    const storage = {
      read: jest.fn(async (key: string) =>
        key.endsWith('.csv') ? Buffer.from(csv) : Buffer.from('not a workbook')
      ),
    }
    const s = new ExpensesService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      storage as never
    )
    const read = await (
      s as unknown as {
        booksOf: (w: string, p: string) => Promise<{ files: { id: string }[]; unread: string[] }>
      }
    ).booksOf(W, '2026-09')
    expect(prisma.document.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          kind: 'payroll-details',
          contentType: {
            in: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv'],
          },
        }),
      })
    )
    expect(read.files.map((f) => f.id)).toEqual(['d-csv'])
    expect(read.unread).toEqual(['broken.xlsx'])
  })

  it('counts a receipt filed on the workspace and on an engagement once, keeping the copy an owner chose', async () => {
    const doc = (id: string, sha256: string, engagementId: string | null) => ({
      id,
      sha256,
      engagementId,
      workspaceId: W,
      storageKey: `${W}/${engagementId ?? 'workspace'}/2026-09/${id}.pdf`,
    })
    const docs = [
      doc('a-eng', 'sha-a', 'e-1'),
      doc('a-ws', 'sha-a', null),
      doc('b-eng', 'sha-b', 'e-1'),
      doc('b-ws', 'sha-b', null),
      doc('c-eng', 'sha-c', 'e-1'),
    ]
    const prisma = {
      document: { findMany: jest.fn().mockResolvedValue(docs) },
      booksBill: { findMany: jest.fn().mockResolvedValue([{ documentId: 'b-eng' }]) },
    }
    const s = new ExpensesService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    )
    const kept = await (
      s as unknown as { receiptsOf: (w: string, p: string) => Promise<{ id: string }[]> }
    ).receiptsOf(W, '2026-09')
    expect(kept.map((d) => d.id)).toEqual(['a-ws', 'b-eng', 'c-eng'])
  })
})

describe("ExpensesService: an owner's word on a bill", () => {
  it('logs the bill and what changed: its receipt, its payment line, dropped', async () => {
    const choice = {
      documentId: 'd-bank',
      line: { page: 1, x: 1, y: 2, width: 3, height: 4, text: 'PIXEL TOOLS 80.00' },
    }
    const { s, prisma, log } = setup({
      lines: [line({ bills: [bill({ paymentChoices: [choice] as never })] })],
      existing: [],
    })
    await s.setBill(owner, W, { period: '2026-09', transactionId: '9003', documentId: 'd-receipt' })
    expect(log.entries[0]).toMatchObject({
      subjectId: 'bb-1',
      changes: [{ field: 'Receipt', before: null, after: 'd-receipt' }],
    })
    prisma.booksBill.findUnique.mockResolvedValue({
      id: 'bb-1',
      documentId: 'd-receipt',
      dropped: false,
      paymentDocumentId: null,
      paymentLine: null,
    })
    await s.setPayment(owner, W, {
      period: '2026-09',
      transactionId: '9003',
      payment: { documentId: 'd-bank', page: 1, text: 'PIXEL TOOLS 80.00' },
    })
    expect(log.entries[1]).toMatchObject({
      subjectId: 'bb-1',
      changes: [
        { field: 'Payment statement', before: null, after: 'd-bank' },
        { field: 'Payment line', before: null, after: 'PIXEL TOOLS 80.00' },
      ],
    })
  })
})

describe("ExpensesService: a receipt opened from the Expense matching step (owner's decision, 2026-11-13)", () => {
  const receipt = {
    id: 'd-receipt',
    workspaceId: W,
    engagementId: null,
    period: '2026-09',
    kind: 'receipt',
    sensitivity: 'financial',
    fileName: 'pixel.pdf',
    contentType: 'application/pdf',
    storageKey: `${W}/workspace/receipts/pixel.pdf`,
  }
  const make = (doc: object | null) => {
    const prisma = { document: { findFirst: jest.fn().mockResolvedValue(doc) } }
    const log = fakeLog(prisma)
    const storage = { read: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4')) }
    const s = new ExpensesService(
      prisma as never,
      log as never,
      {} as never,
      {} as never,
      {} as never,
      storage as never
    )
    return { s, prisma, log, storage }
  }

  it("serves the month's receipt to an owner, and logs the open", async () => {
    await expect(
      make(receipt).s.receiptFile(member('auditor'), W, '2026-09', 'd-receipt')
    ).rejects.toThrow(NotFoundException)
    for (const role of ['owner'] as const) {
      const { s, prisma, log } = make(receipt)
      const f = await s.receiptFile(member(role), W, '2026-09', 'd-receipt')
      expect(f).toMatchObject({ contentType: 'application/pdf', fileName: 'pixel.pdf' })
      expect(prisma.document.findFirst.mock.calls[0][0].where).toMatchObject({
        id: 'd-receipt',
        workspaceId: W,
        period: '2026-09',
        sensitivity: 'financial',
      })
      expect(log.entries[0]).toMatchObject({
        resource: 'document',
        action: 'read',
        subjectId: 'd-receipt',
      })
    }
  })

  it('finds nothing for another workspace, a file stored outside it, or a month not YYYY-MM', async () => {
    await expect(
      make(receipt).s.receiptFile(member('owner', 'ws-2'), W, '2026-09', 'd-receipt')
    ).rejects.toThrow(NotFoundException)
    const { s, storage } = make({ ...receipt, storageKey: 'ws-2/workspace/receipts/pixel.pdf' })
    await expect(s.receiptFile(owner, W, '2026-09', 'd-receipt')).rejects.toThrow(NotFoundException)
    expect(storage.read).not.toHaveBeenCalled()
    await expect(make(null).s.receiptFile(owner, W, '2026-09', 'nope')).rejects.toThrow(
      NotFoundException
    )
    await expect(make(receipt).s.receiptFile(owner, W, 'Sept', 'd-receipt')).rejects.toThrow(
      'YYYY-MM'
    )
  })
})

describe("ExpensesService: removing a receipt from File Management (owner's decision, 2026-11-14)", () => {
  const draft = { status: 'draft', period: '2026-09', engagement: { name: 'Youth Coding Program' } }
  const receipt = (over: object = {}) => ({
    id: 'd-receipt',
    workspaceId: W,
    engagementId: null,
    engagement: null,
    period: '2026-09',
    kind: 'receipt',
    sensitivity: 'financial',
    fileName: 'pixel.pdf',
    storageKey: `${W}/workspace/2026-09/pixel.pdf`,
    _count: { participants: 0, staffPayProofs: 0, payLines: 0 },
    ...over,
  })
  const make = (
    doc: object | null,
    links: { itemNumber: string; month: object }[] = [],
    held = 0,
    bills: object[] = []
  ) => {
    const prisma = {
      document: {
        findFirst: jest.fn().mockResolvedValue(doc),
        delete: jest.fn().mockResolvedValue(doc),
      },
      expense: {
        findMany: jest.fn().mockResolvedValue(bills),
        update: jest.fn().mockResolvedValue({}),
      },
      payrollMatchFile: { count: jest.fn().mockResolvedValue(held) },
      expenseDocument: {
        findMany: jest
          .fn()
          .mockResolvedValue(
            links.map((l) => ({ expense: { itemNumber: l.itemNumber, monthlyReport: l.month } }))
          ),
      },
      wexPaymentDocument: { findMany: jest.fn().mockResolvedValue([]) },
    }
    const log = fakeLog(prisma)
    const documents = { dropStored: jest.fn().mockResolvedValue(undefined) }
    const checks = { refresh: jest.fn().mockResolvedValue(undefined) }
    const s = new ExpensesService(
      prisma as never,
      log as never,
      checks as never,
      documents as never,
      {} as never,
      {} as never
    )
    const dto = jest
      .spyOn(s as unknown as { dto: () => unknown }, 'dto')
      .mockReturnValue({ receipts: [] })
    jest.spyOn(s as unknown as { planOf: () => Promise<unknown> }, 'planOf').mockResolvedValue({})
    return { s, prisma, log, documents, dto, checks }
  }

  it('deletes the receipt and its file, and logs which expenses lose it as proof', async () => {
    const { s, prisma, log, documents } = make(receipt(), [{ itemNumber: 'QB-9003', month: draft }])
    await s.removeReceipt(owner, W, '2026-09', 'd-receipt')
    expect(prisma.document.delete).toHaveBeenCalledWith({ where: { id: 'd-receipt' } })
    expect(log.entries[0]).toMatchObject({
      resource: 'document',
      action: 'delete',
      subjectId: 'd-receipt',
    })
    expect(log.entries[0]!.description).toContain('expense QB-9003 no longer has it as proof')
    expect(documents.dropStored).toHaveBeenCalled()
  })

  it('is an owner’s alone: a bookkeeper or auditor is refused, another workspace finds nothing', async () => {
    for (const role of ['bookkeeper', 'auditor'] as const)
      await expect(
        make(receipt()).s.removeReceipt(member(role), W, '2026-09', 'd-receipt')
      ).rejects.toThrow('Only an owner')
    await expect(
      make(receipt()).s.removeReceipt(member('owner', 'ws-2'), W, '2026-09', 'd-receipt')
    ).rejects.toThrow(NotFoundException)
    await expect(make(null).s.removeReceipt(owner, W, '2026-09', 'nope')).rejects.toThrow(
      NotFoundException
    )
    const outside = make(receipt({ storageKey: 'ws-2/workspace/2026-09/pixel.pdf' }))
    await expect(outside.s.removeReceipt(owner, W, '2026-09', 'd-receipt')).rejects.toThrow(
      NotFoundException
    )
    expect(outside.prisma.document.delete).not.toHaveBeenCalled()
  })

  it('refuses while it proves a line of a closed or submitted month, and deletes nothing', async () => {
    const { s, prisma, log, documents } = make(receipt(), [
      { itemNumber: 'QB-9003', month: { ...draft, status: 'submitted' } },
    ])
    await expect(s.removeReceipt(owner, W, '2026-09', 'd-receipt')).rejects.toThrow(
      /submitted: reopen that month first/
    )
    expect(prisma.document.delete).not.toHaveBeenCalled()
    expect(log.entries).toHaveLength(0)
    expect(documents.dropStored).not.toHaveBeenCalled()
  })

  it('refuses one filed on an engagement month that is not a draft, used elsewhere, or held by an upload', async () => {
    const filed = receipt({
      engagementId: 'e-a',
      storageKey: `${W}/e-a/2026-09/pixel.pdf`,
      engagement: { monthlyReports: [{ ...draft, status: 'closed' }] },
    })
    await expect(make(filed).s.removeReceipt(owner, W, '2026-09', 'd-receipt')).rejects.toThrow(
      ConflictException
    )
    const used = receipt({ _count: { participants: 0, staffPayProofs: 1, payLines: 0 } })
    await expect(make(used).s.removeReceipt(owner, W, '2026-09', 'd-receipt')).rejects.toThrow(
      'payroll proof'
    )
    await expect(
      make(receipt(), [], 1).s.removeReceipt(owner, W, '2026-09', 'd-receipt')
    ).rejects.toThrow("An upload that isn't saved yet holds pixel.pdf")
  })

  it("clears it from the saved bills of the month's lines in the same change, and checks those months again", async () => {
    const bills = [
      {
        id: 'x-1',
        itemNumber: 'QB-9004',
        monthlyReport: { ...draft, id: 'r-9' },
        booksBills: [{ transactionId: 't-1', documentId: 'd-receipt', dropped: false }],
      },
    ]
    const { s, prisma, log, checks } = make(receipt(), [], 0, bills)
    await s.removeReceipt(owner, W, '2026-09', 'd-receipt')
    expect(prisma.expense.update).toHaveBeenCalledWith({
      where: { id: 'x-1' },
      data: { booksBills: [{ transactionId: 't-1', documentId: null, dropped: false }] },
    })
    expect(log.entries[0]!.description).toContain('expense QB-9004 no longer has it as proof')
    expect(checks.refresh).toHaveBeenCalledWith('r-9')
    const locked = make(receipt(), [], 0, [
      { ...bills[0]!, monthlyReport: { ...draft, status: 'submitted' } },
    ])
    await expect(locked.s.removeReceipt(owner, W, '2026-09', 'd-receipt')).rejects.toThrow(
      /submitted: reopen that month first/
    )
    expect(locked.prisma.document.delete).not.toHaveBeenCalled()
  })
})

describe('ExpensesService: moving and renaming a file in File Management (issue #82)', () => {
  jest.mock('../receipts/read-receipt')
  const counts = {
    participants: 0,
    staffPayProofs: 0,
    payLines: 0,
    expenses: 0,
    wexPayments: 0,
    booksPayments: 0,
  }
  const draft = {
    id: 'r-1',
    status: 'draft',
    period: '2026-10',
    engagement: { name: 'Youth Coding Program' },
  }
  const file = (over: object = {}) => ({
    id: 'd-1',
    workspaceId: W,
    engagementId: null,
    engagement: null,
    period: '2026-10',
    kind: 'receipt',
    sensitivity: 'financial',
    contentType: 'application/pdf',
    fileName: 'scan.pdf',
    sha256: 'sha-1',
    size: 10,
    uploadedAt: new Date('2026-10-30T00:00:00Z'),
    addedSinceMatch: false,
    storageKey: `${W}/workspace/2026-10/a.pdf`,
    _count: counts,
    // The months whose lines it proves (fake only: read back as its links).
    proofIn: [] as object[],
    ...over,
  })
  type Doc = ReturnType<typeof file>
  const PAYROLL = ['timesheet', 'payroll-register', 'paystub', 'bank-statement', 'payroll-details']
  const make = (
    doc: Doc | null,
    opts: {
      links?: { itemNumber: string; month: object }[]
      others?: Doc[]
      held?: boolean
      bills?: { id: string; itemNumber: string; booksBills: object[]; monthlyReport: object }[]
      // The emailed documents inbox: the email's row, an owner's open match, the month's books, an owner's bill choice.
      row?: { id: string; senderUserId: string | null; documentIds: string[] } | null
      run?: boolean
      books?: boolean
      chosen?: boolean
    } = {}
  ) => {
    const links = opts.links ?? []
    const all = [...(doc ? [doc] : []), ...(opts.others ?? [])]
    const linked = (d: Doc) => [
      ...d.proofIn,
      ...(d.id === doc?.id ? links.map((l) => l.month) : []),
    ]
    const findMany = jest.fn(async (args: { where: Record<string, unknown> }) => {
      const w = args.where
      const ids = (w.id as { in?: string[] } | undefined)?.in
      if (ids)
        return all
          .filter((d) => ids.includes(d.id))
          .map((d) => ({
            ...d,
            expenses: linked(d).map((m) => ({ expense: { monthlyReport: m } })),
            wexPayments: [],
          }))
      if (w.AND) {
        const shas = (w.AND as { sha256: { in: string[] } }[])[1]!.sha256.in
        return all.filter((d) => d.kind === 'receipt' && shas.includes(d.sha256))
      }
      if (typeof w.kind === 'string')
        return all.filter(
          (d) =>
            d.kind === w.kind &&
            d.engagementId === null &&
            d.sha256 === w.sha256 &&
            d.id !== (w.id as { not: string }).not
        )
      return all.filter((d) => PAYROLL.includes(d.kind) && d.engagementId === null)
    })
    const prisma = {
      document: {
        findFirst: jest.fn().mockResolvedValue(doc),
        findMany,
        update: jest.fn().mockResolvedValue(doc),
        count: jest.fn().mockResolvedValue(opts.books ? 1 : 0),
      },
      inboundReceipt: { findFirst: jest.fn().mockResolvedValue(opts.row ?? null) },
      payrollMatchRun: {
        findFirst: jest.fn().mockResolvedValue(opts.run ? { id: 'run-1' } : null),
      },
      payrollMatchFile: {
        count: jest.fn().mockResolvedValue(opts.held ? 1 : 0),
        findMany: jest.fn().mockResolvedValue(opts.held ? [{ documentId: 'd-1' }] : []),
      },
      monthlyReport: { findFirst: jest.fn().mockResolvedValue(doc?.engagementId ? draft : null) },
      expense: {
        findMany: jest.fn().mockResolvedValue(opts.bills ?? []),
        update: jest.fn().mockResolvedValue({}),
        count: jest.fn().mockResolvedValue(0),
      },
      expenseDocument: {
        findMany: jest
          .fn()
          .mockResolvedValue(
            links.map((l) => ({ expense: { itemNumber: l.itemNumber, monthlyReport: l.month } }))
          ),
        deleteMany: jest.fn().mockResolvedValue({ count: links.length }),
        count: jest.fn().mockResolvedValue(links.length),
      },
      wexPaymentDocument: {
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        count: jest.fn().mockResolvedValue(0),
      },
      booksBill: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        count: jest.fn().mockResolvedValue(opts.chosen ? 1 : 0),
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
    }
    const log = fakeLog(prisma)
    const documents = { dropStored: jest.fn().mockResolvedValue(undefined) }
    const checks = { refresh: jest.fn().mockResolvedValue(undefined) }
    const storage = {
      read: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4 fictional')),
      upload: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
    }
    const s = new ExpensesService(
      prisma as never,
      log as never,
      checks as never,
      documents as never,
      {} as never,
      storage as never
    )
    jest
      .spyOn(s as unknown as { fileManagement: () => Promise<unknown> }, 'fileManagement')
      .mockImplementation(async (...a: unknown[]) => ({ note: a[3] }))
    return { s, prisma, log, documents, storage, checks }
  }
  const unchanged = (t: ReturnType<typeof make>) => {
    expect(t.prisma.document.update).not.toHaveBeenCalled()
    expect(t.log.entries).toHaveLength(0)
  }

  it('moves a receipt to a payroll folder: drops its proof links, clears what was read, and waits for a match', async () => {
    const { s, prisma, log, checks } = make(file(), {
      links: [{ itemNumber: 'QB-9003', month: draft }],
    })
    const done = (await s.moveFile(owner, W, '2026-10', 'd-1', 'timesheet')) as { note: string }
    expect(prisma.expenseDocument.deleteMany).toHaveBeenCalledWith({ where: { documentId: 'd-1' } })
    expect(prisma.booksBill.updateMany).toHaveBeenCalled()
    expect(prisma.document.update).toHaveBeenCalledWith({
      where: { id: 'd-1' },
      data: expect.objectContaining({
        kind: 'timesheet',
        sensitivity: 'financial',
        addedSinceMatch: true,
        receiptAmount: null,
        receiptVendor: null,
      }),
    })
    expect(log.entries[0]!.description).toBe(
      'Moved a receipt for October 2026 to Timesheets in File Management; expense QB-9003 no longer has it as proof'
    )
    expect(checks.refresh).toHaveBeenCalledWith('r-1')
    expect(done.note).toMatch(/counts once you Re-match with same files/)
    // Under the month's payroll lock, where why it cannot move is read again.
    expect(prisma.$queryRaw).toHaveBeenCalled()
  })

  it("finds only one of the month's receipts as the bills see them, never one dismissed", async () => {
    const { s, prisma } = make(file())
    await s.moveFile(owner, W, '2026-10', 'd-1', 'timesheet')
    const where = prisma.document.findFirst.mock.calls[0]![0].where as { OR: object[] }
    expect(where.OR[1]).toMatchObject({ receiptDismissed: false, sensitivity: 'financial' })
  })

  it("clears the receipt from the saved bills of the month's lines, so their checks count it gone", async () => {
    const bills = [
      {
        id: 'x-1',
        itemNumber: 'QB-9004',
        monthlyReport: draft,
        booksBills: [
          { transactionId: 't-1', documentId: 'd-1', dropped: false },
          { transactionId: 't-2', documentId: 'd-other', dropped: false },
        ],
      },
    ]
    const { s, prisma, log } = make(file(), { bills })
    await s.moveFile(owner, W, '2026-10', 'd-1', 'timesheet')
    expect(prisma.expense.update).toHaveBeenCalledWith({
      where: { id: 'x-1' },
      data: {
        booksBills: [
          { transactionId: 't-1', documentId: null, dropped: false },
          { transactionId: 't-2', documentId: 'd-other', dropped: false },
        ],
      },
    })
    expect(log.entries[0]!.description).toContain('expense QB-9004 no longer has it as proof')
    const locked = make(file(), {
      bills: [{ ...bills[0]!, monthlyReport: { ...draft, status: 'closed' } }],
    })
    await expect(locked.s.moveFile(owner, W, '2026-10', 'd-1', 'timesheet')).rejects.toThrow(
      /closed: reopen that month first/
    )
    expect(locked.prisma.expense.update).not.toHaveBeenCalled()
  })

  it("stores a receipt from an engagement's month again under the workspace's month, then removes the old object", async () => {
    const { s, prisma, storage, documents } = make(
      file({
        engagementId: 'e-a',
        storageKey: `${W}/e-a/2026-10/a.pdf`,
        engagement: { name: 'Youth Coding Program', monthlyReports: [draft] },
      })
    )
    await s.moveFile(owner, W, '2026-10', 'd-1', 'bank-statement')
    const key = storage.upload.mock.calls[0]![0] as string
    expect(key).toMatch(new RegExp(`^${W}/workspace/2026-10/.+\\.pdf$`))
    expect(prisma.document.update).toHaveBeenCalledWith({
      where: { id: 'd-1' },
      data: expect.objectContaining({ storageKey: key, engagementId: null }),
    })
    expect(storage.delete).toHaveBeenCalledWith(`${W}/e-a/2026-10/a.pdf`)
    expect(documents.dropStored).not.toHaveBeenCalled()
  })

  it('refuses what would break a saved match or lower protection, and changes nothing', async () => {
    const proves = make(file({ kind: 'timesheet', _count: { ...counts, booksPayments: 1 } }))
    await expect(proves.s.moveFile(owner, W, '2026-10', 'd-1', 'payroll-register')).rejects.toThrow(
      /already proves pay/
    )
    const stub = make(file({ kind: 'paystub', sensitivity: 'personal' }))
    await expect(stub.s.moveFile(owner, W, '2026-10', 'd-1', 'receipt')).rejects.toThrow(
      /personal pay/
    )
    const sheet = make(file({ kind: 'timesheet', contentType: 'text/csv', fileName: 'a.csv' }))
    await expect(sheet.s.moveFile(owner, W, '2026-10', 'd-1', 'receipt')).rejects.toThrow(
      'Receipts takes PDF, PNG, JPG files, and this is CSV'
    )
    const locked = make(file(), {
      links: [{ itemNumber: 'QB-1', month: { ...draft, status: 'submitted' } }],
    })
    await expect(locked.s.moveFile(owner, W, '2026-10', 'd-1', 'timesheet')).rejects.toThrow(
      /submitted: reopen that month first/
    )
    const held = make(file(), { held: true })
    await expect(held.s.moveFile(owner, W, '2026-10', 'd-1', 'timesheet')).rejects.toThrow(
      "An upload that isn't saved yet holds it: it can move once that upload is saved or discarded"
    )
    for (const t of [proves, stub, sheet, locked, held]) unchanged(t)
    await expect(make(file()).s.moveFile(owner, W, '2026-10', 'd-1', 'receipt')).rejects.toThrow(
      'in Receipts already'
    )
    await expect(make(file()).s.moveFile(owner, W, '2026-10', 'd-1', 'contract')).rejects.toThrow(
      'Choose the folder'
    )
  })

  it('keeps a personal file personal: a pay stub moves to payroll details, never to timesheets', async () => {
    const toTimesheets = make(file({ kind: 'paystub', sensitivity: 'personal' }))
    await expect(toTimesheets.s.moveFile(owner, W, '2026-10', 'd-1', 'timesheet')).rejects.toThrow(
      'A pay stub holds personal pay, so it is not moved to Timesheets: remove it and upload the right file there instead'
    )
    unchanged(toTimesheets)
    const toDetails = make(file({ kind: 'paystub', sensitivity: 'personal' }))
    await toDetails.s.moveFile(owner, W, '2026-10', 'd-1', 'payroll-details')
    expect(toDetails.prisma.document.update).toHaveBeenCalledWith({
      where: { id: 'd-1' },
      data: expect.objectContaining({ kind: 'payroll-details', sensitivity: 'personal' }),
    })
  })

  it('refuses a receipt filed twice, naming where the copy is', async () => {
    const copy = file({
      id: 'd-2',
      engagementId: 'e-a',
      storageKey: `${W}/e-a/2026-10/b.pdf`,
      engagement: { name: 'Youth Coding Program', monthlyReports: [draft] },
    })
    const t = make(file(), { others: [copy] })
    await expect(t.s.moveFile(owner, W, '2026-10', 'd-1', 'timesheet')).rejects.toThrow(
      "A copy is also filed on Youth Coding Program's October 2026: remove that copy first"
    )
    unchanged(t)
  })

  it('refuses a move into a payroll folder that has the same file already', async () => {
    const there = file({ id: 'd-2', kind: 'timesheet', storageKey: `${W}/workspace/2026-10/b.pdf` })
    const t = make(file(), { others: [there] })
    await expect(t.s.moveFile(owner, W, '2026-10', 'd-1', 'timesheet')).rejects.toThrow(
      'That file is in Timesheets already; remove this copy'
    )
    unchanged(t)
    expect(t.storage.upload).not.toHaveBeenCalled()
  })

  it('answers pays saved a moment ago (the database keeps such a file in place) with a plain 409', async () => {
    const t = make(file({ kind: 'timesheet' }))
    t.prisma.document.update.mockRejectedValue(
      new Prisma.PrismaClientUnknownRequestError(
        'ERROR: Document d-1: a payroll file with saved pays keeps its kind, month and place (23514)',
        { clientVersion: 'test' }
      )
    )
    await expect(t.s.moveFile(owner, W, '2026-10', 'd-1', 'payroll-register')).rejects.toThrow(
      /already proves pay/
    )
  })

  it('is an owner’s alone', async () => {
    for (const role of ['bookkeeper', 'auditor'] as const) {
      await expect(
        make(file()).s.moveFile(member(role), W, '2026-10', 'd-1', 'timesheet')
      ).rejects.toThrow('Only an owner')
      await expect(
        make(file()).s.renameFile(member(role), W, '2026-10', 'd-1', 'x')
      ).rejects.toThrow('Only an owner')
    }
    await expect(make(null).s.moveFile(owner, W, '2026-10', 'nope', 'timesheet')).rejects.toThrow(
      NotFoundException
    )
  })

  describe("from the emailed documents inbox (owner's decision, 2026-11-17)", () => {
    const bookkeeper = member('bookkeeper')
    const own = { id: 'in-1', senderUserId: bookkeeper.userId, documentIds: ['d-1'] }

    it('lets a bookkeeper move a receipt they emailed to Pay stubs, logged in the inbox’s words', async () => {
      const t = make(file(), { row: own })
      const done = await t.s.moveEmailed(bookkeeper, W, 'in-1', 'd-1', 'paystub')
      expect(t.prisma.document.update).toHaveBeenCalledWith({
        where: { id: 'd-1' },
        data: expect.objectContaining({
          kind: 'paystub',
          sensitivity: 'personal',
          addedSinceMatch: true,
        }),
      })
      expect(t.log.entries).toHaveLength(1)
      expect(t.log.entries[0]!.description).toBe(
        'Moved an emailed receipt to Pay stubs from the emailed documents inbox'
      )
      expect(done.note).toBe('Moved scan.pdf to Pay stubs. An owner matches it at month end.')
      expect(done.files.map((f) => f.id)).toEqual(['d-1'])
      // Under the month's payroll lock, read again.
      expect(t.prisma.$queryRaw).toHaveBeenCalled()
      // An owner's choices for bills are not the bookkeeper's to see: never read as "none".
      expect(t.prisma.booksBill.count).not.toHaveBeenCalled()
    })

    it("refuses another member's email, and lists its files as not theirs to move", async () => {
      const theirs = { ...own, senderUserId: 'u-someone-else' }
      const t = make(file(), { row: theirs })
      await expect(t.s.moveEmailed(bookkeeper, W, 'in-1', 'd-1', 'paystub')).rejects.toThrow(
        'Only the person who emailed it, or an owner, moves it'
      )
      unchanged(t)
      const listed = await make(file(), { row: theirs }).s.emailedFiles(bookkeeper, W, 'in-1')
      expect(listed.files[0]!.cannotMove).toBe(
        'Only the person who emailed it, or an owner, moves it'
      )
      // An owner moves any row's file.
      await make(file(), { row: theirs }).s.moveEmailed(owner, W, 'in-1', 'd-1', 'paystub')
    })

    it('refuses once an owner has matched it, and while the bookkeeper cannot see whether they have', async () => {
      const matched = 'An owner has matched it already: ask an owner to move it in Month End Close'
      const linked = make(file(), {
        row: own,
        links: [{ itemNumber: 'QB-1', month: draft }],
      })
      await expect(linked.s.moveEmailed(bookkeeper, W, 'in-1', 'd-1', 'paystub')).rejects.toThrow(
        matched
      )
      const read = make(file({ kind: 'timesheet', addedSinceMatch: false }), { row: own })
      await expect(read.s.moveEmailed(bookkeeper, W, 'in-1', 'd-1', 'paystub')).rejects.toThrow(
        matched
      )
      const chosen = make(file(), { row: { ...own, senderUserId: owner.userId }, chosen: true })
      await expect(chosen.s.moveEmailed(owner, W, 'in-1', 'd-1', 'paystub')).rejects.toThrow(
        matched
      )
      const running = make(file({ kind: 'timesheet', addedSinceMatch: true }), {
        row: own,
        run: true,
      })
      await expect(
        running.s.moveEmailed(bookkeeper, W, 'in-1', 'd-1', 'payroll-register')
      ).rejects.toThrow('An owner is matching October 2026 now')
      const books = make(file(), { row: own, books: true })
      await expect(books.s.moveEmailed(bookkeeper, W, 'in-1', 'd-1', 'paystub')).rejects.toThrow(
        "The month's books are in"
      )
      for (const t of [linked, read, chosen, running, books]) unchanged(t)
      const listed = await make(file(), { row: own, books: true }).s.emailedFiles(
        bookkeeper,
        W,
        'in-1'
      )
      expect(listed.files[0]!.cannotMove).toMatch(/books are in/)
    })

    it('is never an auditor’s, and finds nothing of another workspace or outside the email', async () => {
      const auditor = member('auditor')
      const t = make(file(), { row: own })
      await expect(t.s.moveEmailed(auditor, W, 'in-1', 'd-1', 'paystub')).rejects.toThrow(
        ForbiddenException
      )
      await expect(t.s.emailedFiles(auditor, W, 'in-1')).rejects.toThrow(ForbiddenException)
      unchanged(t)
      await expect(
        make(file(), { row: null }).s.moveEmailed(bookkeeper, W, 'in-x', 'd-1', 'paystub')
      ).rejects.toThrow(NotFoundException)
      await expect(
        make(file(), { row: own }).s.moveEmailed(bookkeeper, W, 'in-1', 'd-2', 'paystub')
      ).rejects.toThrow(NotFoundException)
      await expect(
        make(file(), { row: own }).s.moveEmailed(
          member('bookkeeper', 'ws-2'),
          W,
          'in-1',
          'd-1',
          'paystub'
        )
      ).rejects.toThrow(NotFoundException)
    })
  })

  it('renames the shown name only, keeps the extension, and logs the field alone', async () => {
    const { s, prisma, log } = make(file())
    await s.renameFile(owner, W, '2026-10', 'd-1', ' Staples October.PDF ')
    expect(prisma.document.update).toHaveBeenCalledWith({
      where: { id: 'd-1' },
      data: { fileName: 'Staples October.pdf' },
    })
    expect(log.entries[0]).toMatchObject({
      description: 'Renamed a receipt for October 2026 in File Management',
      changes: [{ field: 'File name' }],
    })
    await expect(make(file()).s.renameFile(owner, W, '2026-10', 'd-1', '  ')).rejects.toThrow(
      'Type the new name'
    )
  })

  it('refuses a rename exactly when File Management says it cannot be renamed', async () => {
    const held = make(file({ kind: 'timesheet' }), { held: true })
    await expect(held.s.renameFile(owner, W, '2026-10', 'd-1', 'x')).rejects.toThrow(
      "An upload that isn't saved yet holds it: it can be renamed once that upload is saved or discarded"
    )
    const proof = make(file({ proofIn: [{ ...draft, status: 'submitted' }] }))
    await expect(proof.s.renameFile(owner, W, '2026-10', 'd-1', 'x')).rejects.toThrow(
      "It is proof in Youth Coding Program's October 2026, which is submitted: reopen that month first"
    )
    const filed = make(
      file({
        engagementId: 'e-a',
        storageKey: `${W}/e-a/2026-10/a.pdf`,
        engagement: {
          name: 'Youth Coding Program',
          monthlyReports: [{ ...draft, status: 'closed' }],
        },
      })
    )
    await expect(filed.s.renameFile(owner, W, '2026-10', 'd-1', 'x')).rejects.toThrow(
      "It is filed on Youth Coding Program's October 2026, which is closed: reopen that month first"
    )
    for (const t of [held, proof, filed]) unchanged(t)
    // A receipt filed twice moves no more, but may still be renamed.
    const copy = file({ id: 'd-2', storageKey: `${W}/workspace/2026-10/b.pdf` })
    const twice = make(file(), { others: [copy] })
    await twice.s.renameFile(owner, W, '2026-10', 'd-1', 'Staples')
    expect(twice.prisma.document.update).toHaveBeenCalled()
  })

  it('lists each payroll file with why it cannot move or be renamed, a payment of a bill included', async () => {
    const { prisma } = make(file({ kind: 'timesheet' }), {
      others: [
        file({
          id: 'd-2',
          kind: 'bank-statement',
          sha256: 's2',
          _count: { ...counts, booksPayments: 1 },
        }),
        file({
          id: 'd-3',
          kind: 'payroll-register',
          sha256: 's3',
          proofIn: [{ ...draft, status: 'closed' }],
        }),
      ],
    })
    const files = await setFileDtos(prisma as never, W, '2026-10')
    const by = new Map(files.map((f) => [f.id, f]))
    expect(by.get('d-1')).toMatchObject({ cannotMove: null, cannotRename: null })
    expect(by.get('d-2')!.cannotMove).toMatch(/already proves pay/)
    expect(by.get('d-2')!.cannotRename).toBeNull()
    expect(by.get('d-3')!.cannotRename).toBe(
      "It is proof in Youth Coding Program's October 2026, which is closed: reopen that month first"
    )
  })
})
