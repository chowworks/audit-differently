import { ConflictException, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import type { BooksBillDto, BooksLineDto } from '@ad/types'
import { member, W } from '../core/testing/callers'
import { fakeLog } from '../core/testing/log'
import { BOOKS } from './books.testing'
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
    mappings: [],
    receipts: [{ id: 'd-receipt', fileName: 'pixel.pdf', receiptAmount: null }],
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
      mappings: [],
      receipts: [],
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

  it("serves the month's receipt to an owner or an auditor, and logs the open", async () => {
    for (const role of ['owner', 'auditor'] as const) {
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
    held = 0
  ) => {
    const prisma = {
      document: {
        findFirst: jest.fn().mockResolvedValue(doc),
        delete: jest.fn().mockResolvedValue(doc),
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
    const s = new ExpensesService(
      prisma as never,
      log as never,
      {} as never,
      documents as never,
      {} as never,
      {} as never
    )
    const dto = jest
      .spyOn(s as unknown as { dto: () => unknown }, 'dto')
      .mockReturnValue({ receipts: [] })
    jest.spyOn(s as unknown as { planOf: () => Promise<unknown> }, 'planOf').mockResolvedValue({})
    return { s, prisma, log, documents, dto }
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
    ).rejects.toThrow('not saved yet')
  })
})
