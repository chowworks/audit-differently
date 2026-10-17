import { Prisma } from '@prisma/client'
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common'
import type { ExpenseInput, WexPaymentInput } from '@ad/types'
import { member, OTHER, scoped, stranger, W } from '../core/testing/callers'
import { expectNoneOf, fakeLog } from '../core/testing/log'
import { StagedFile } from '../documents/staged-file'
import { ReportsService } from './reports.service'

/** The gates on a month: members read it, owners and bookkeepers change a draft, nobody else sees it. */
const report = (status = 'draft') => ({
  id: 'r-1',
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
  sentBackAt: null,
  sentBackByEmail: null,
  editsRequestedAt: null,
  editsRequestedByEmail: null,
  editsRequestComment: null,
  isFinal: false,
  engagement: {
    id: 'e-1',
    workspaceId: W,
    kind: 'grant',
    name: 'Coding Pathway',
    number: 'DEMO-1',
    funder: 'Demo Workforce Board',
    periodStart: new Date('2026-07-01T00:00:00Z'),
    periodEnd: new Date('2027-06-30T00:00:00Z'),
    tags: [],
    reportDueDay: 12,
    awardAmount: 125000,
    workspace: {
      id: W,
      name: 'Riverbend Youth Services',
      tagTypes: [
        {
          key: 'funding-source',
          label: 'Funding source',
          appliesTo: ['engagement', 'expense', 'payroll', 'participant'],
          values: [
            { key: 'youth-workforce-fund', label: 'Youth Workforce Fund' },
            { key: 'adult-training-fund', label: 'Adult Training Fund' },
          ],
        },
        {
          key: 'age-group',
          label: 'Age group',
          appliesTo: ['payroll', 'participant'],
          values: [{ key: 'under-18', label: 'Under 18' }],
        },
      ],
    },
    eligibilityItems: [],
    reportTo: null,
    preparerName: null,
    preparerOrganization: null,
    authorizerName: null,
    authorizerOrganization: null,
    budgetLines: [],
    participants: [
      {
        id: 'p-1',
        participantId: '900001',
        displayName: 'Jordan Sample',
        enrollmentStatus: 'new',
        currentStatus: 'active',
        documents: [],
      },
    ],
  },
  expenses: [],
  wexPayments: [],
  checks: [],
  reopenings: [] as Record<string, unknown>[],
})

/** A signed copy of the September report, uploaded at `at`. */
const signedCopy = (id: string, at: string) => ({
  ...document(id, W, 'signed-report'),
  engagementId: 'e-1',
  period: '2026-09',
  uploadedAt: new Date(at),
})

/** The month's signed copies on file, as the month's page and a reopening read them. */
function signedOnFile(prisma: { document: { findMany: jest.Mock } }, docs: object[]) {
  prisma.document.findMany.mockImplementation(async (args?: { where?: { kind?: string } }) =>
    args?.where?.kind === 'signed-report' ? docs : [document('d-1', W)]
  )
}

const document = (id: string, workspaceId: string, kind = 'invoice') => ({
  id,
  workspaceId,
  kind,
  sensitivity: 'financial',
  fileName: `${id}.pdf`,
  contentType: 'application/pdf',
  size: 1,
  period: null,
  uploadedAt: new Date('2026-10-01T00:00:00Z'),
})

/** Expense 1001 as it is stored: the same values `expense` below sends, so saving `expense` again changes nothing. */
const stored = {
  id: 'x-1',
  workspaceId: W,
  monthlyReportId: 'r-1',
  itemNumber: '1001',
  date: new Date('2026-09-02T00:00:00Z'),
  vendor: 'Ledger & Co.',
  memo: null,
  account: '60701 Accounting Fees',
  totalCost: '100.00',
  allocatedAmount: '50.00',
  allocationType: 'direct',
  allocationNote: null,
  reportLine: 'program-costs',
}

function service(status = 'draft', over: Record<string, unknown> = {}) {
  const prisma = {
    // The month as the change's transaction reads it, locked: as loaded, unless a test says it changed meanwhile.
    $queryRaw: jest.fn().mockResolvedValue([{ status, period: '2026-09' }]),
    monthlyReport: {
      ...scoped({ ...report(status), ...over }),
      update: jest.fn(),
      delete: jest.fn(),
    },
    expense: {
      ...scoped(stored),
      create: jest.fn(async ({ data }: { data: object }) => ({ id: 'x-2', ...data })),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
    },
    expenseDocument: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      update: jest.fn(),
      deleteMany: jest.fn(),
    },
    wexPayment: {
      ...scoped({ id: 'wx-1', workspaceId: W, monthlyReportId: 'r-1' }),
      create: jest.fn(async ({ data }: { data: object }) => ({ id: 'wx-2', ...data })),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
    },
    wexPaymentDocument: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      update: jest.fn(),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    payrollMatchRun: { count: jest.fn().mockResolvedValue(0) },
    document: {
      // Files filed under the month: one, unless a test says the month is empty.
      count: jest.fn().mockResolvedValue(1),
      findMany: jest.fn().mockResolvedValue([document('d-1', W)]),
      // No signed copy on file for the month unless a test says so.
      findFirst: jest.fn(async (args?: { where?: { kind?: string } }) =>
        args?.where?.kind === 'signed-report'
          ? null
          : scoped(
              document('d-1', W),
              document('d-bank', W, 'bank-statement'),
              document('d-other', OTHER)
            ).findFirst(args as never)
      ),
      create: jest.fn(async ({ data }: { data: object }) => ({
        id: 'd-new',
        uploadedAt: new Date('2026-10-02T00:00:00Z'),
        ...data,
      })),
    },
    check: { findMany: jest.fn().mockResolvedValue([]) },
    reportReopening: {
      count: jest.fn().mockResolvedValue(0),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(async ({ data }: { data: object }) => ({
        id: 'ro-new',
        workspaceId: W,
        ...data,
      })),
    },
  }
  // Only the month's own earlier expenses are read; the fake expense rows are for the id lookups.
  prisma.expense.findMany.mockResolvedValue([])
  const checks = { refresh: jest.fn().mockResolvedValue([]) }
  const log = fakeLog(prisma)
  const writes = [
    prisma.monthlyReport.update,
    prisma.expense.create,
    prisma.expense.update,
    prisma.expense.delete,
    prisma.expenseDocument.create,
    prisma.expenseDocument.update,
    prisma.expenseDocument.deleteMany,
    prisma.wexPayment.create,
    prisma.wexPayment.update,
    prisma.wexPaymentDocument.create,
    prisma.wexPaymentDocument.update,
    prisma.document.create,
    prisma.reportReopening.create,
  ]
  return {
    service: new ReportsService(prisma as never, checks as never, log as never),
    prisma,
    log,
    writes,
  }
}

/** A bank statement uploaded for expense 1001's proof, staged as POST /documents stages it. */
function staged(engagementId = 'e-1') {
  const storage = {
    upload: jest.fn(),
    delete: jest.fn().mockResolvedValue(undefined),
    getSignedUrl: jest.fn(),
    deleteByPrefix: jest.fn(),
    putFile: jest.fn(),
    read: jest.fn(),
  }
  const file = new StagedFile(
    storage,
    {
      workspaceId: W,
      engagementId,
      period: '2026-09',
      kind: 'bank-statement',
      sensitivity: 'financial',
      fileName: 'Jordan Sample bank.pdf',
      contentType: 'application/pdf',
      size: 3,
      sha256: 'f'.repeat(64),
      storageKey: `${W}/${engagementId}/2026-09/new.pdf`,
      uploadedById: 'u-bookkeeper-ws-1',
    },
    Buffer.from('%PDF')
  )
  return { file, storage }
}

const expense: ExpenseInput = {
  itemNumber: '1001',
  date: '2026-09-02',
  vendor: 'Ledger & Co.',
  account: '60701 Accounting Fees',
  totalCost: 100,
  allocatedAmount: 50,
  allocationType: 'direct',
  reportLine: 'program-costs',
}
const wex: WexPaymentInput = {
  participantId: 'p-1',
  payPeriodStart: '2026-09-07',
  payPeriodEnd: '2026-09-20',
  grossAmount: 280,
}
const closing = {
  approvedBy: 'Sam Whitfield',
  approvedOn: '2026-10-05',
  note: 'Signed off by phone',
}

describe('ReportsService', () => {
  it('answers a member of another workspace with 404 from every route and writes nothing', async () => {
    const { service: s, log, writes } = service('submitted')
    const who = stranger()
    await expect(s.get(who, 'r-1')).rejects.toThrow(NotFoundException)
    await expect(s.addExpense(who, 'r-1', expense)).rejects.toThrow(NotFoundException)
    await expect(s.updateExpense(who, 'x-1', expense)).rejects.toThrow(NotFoundException)
    await expect(s.deleteExpense(who, 'x-1')).rejects.toThrow(NotFoundException)
    await expect(s.attachToExpense(who, 'x-1', 'invoice', 'd-1')).rejects.toThrow(NotFoundException)
    await expect(s.detachFromExpense(who, 'x-1', 'd-1')).rejects.toThrow(NotFoundException)
    await expect(s.addWexPayment(who, 'r-1', wex)).rejects.toThrow(NotFoundException)
    await expect(s.updateWexPayment(who, 'wx-1', wex)).rejects.toThrow(NotFoundException)
    await expect(s.deleteWexPayment(who, 'wx-1')).rejects.toThrow(NotFoundException)
    await expect(s.attachToWex(who, 'wx-1', 'payment', 'd-1')).rejects.toThrow(NotFoundException)
    await expect(s.submit(who, 'r-1')).rejects.toThrow(NotFoundException)
    await expect(s.approveClosing(who, 'r-1', closing)).rejects.toThrow(NotFoundException)
    await expect(s.sendBack(who, 'r-1', 'Wrong rent')).rejects.toThrow(NotFoundException)
    await expect(s.reopen(who, 'r-1', 'Typo')).rejects.toThrow(NotFoundException)
    for (const w of writes) expect(w).not.toHaveBeenCalled()
    expect(log.entries).toEqual([])
  })

  it('logs the open of a month as one line naming what it lists', async () => {
    const { service: s, log } = service()
    const who = member('auditor')
    const detail = await s.get(who, 'r-1')
    expect(detail.documents).toHaveLength(1)
    expect(detail.participants).toHaveLength(1)
    expect(log.entries).toEqual([
      {
        workspaceId: W,
        resource: 'report',
        subjectId: 'r-1',
        action: 'read',
        description: 'Viewed September 2026 of Coding Pathway: 1 document, 1 participant',
      },
    ])
    expectNoneOf(log.entries, ['Jordan', '900001'])
  })

  it('lets an auditor read the month and refuses every change, logging nothing for the refusals', async () => {
    const { service: s, log, writes } = service()
    const who = member('auditor')
    expect((await s.get(who, 'r-1')).can).toEqual({
      edit: false,
      close: false,
      sendBack: false,
      requestEdits: false,
      submit: false,
      reopen: false,
      attachSigned: false,
      readPersonal: true,
      deleteMonth: false,
    })
    log.entries.length = 0
    await expect(s.addExpense(who, 'r-1', expense)).rejects.toThrow(ForbiddenException)
    await expect(s.updateExpense(who, 'x-1', expense)).rejects.toThrow(ForbiddenException)
    await expect(s.deleteExpense(who, 'x-1')).rejects.toThrow(ForbiddenException)
    await expect(s.attachToExpense(who, 'x-1', 'invoice', 'd-1')).rejects.toThrow(
      ForbiddenException
    )
    await expect(s.detachFromExpense(who, 'x-1', 'd-1')).rejects.toThrow(ForbiddenException)
    await expect(s.addWexPayment(who, 'r-1', wex)).rejects.toThrow(ForbiddenException)
    await expect(s.updateWexPayment(who, 'wx-1', wex)).rejects.toThrow(ForbiddenException)
    await expect(s.deleteWexPayment(who, 'wx-1')).rejects.toThrow(ForbiddenException)
    await expect(s.attachToWex(who, 'wx-1', 'payment', 'd-1')).rejects.toThrow(ForbiddenException)
    await expect(s.submit(who, 'r-1')).rejects.toThrow(ForbiddenException)
    await expect(s.approveClosing(who, 'r-1', closing)).rejects.toThrow(ForbiddenException)
    for (const w of writes) expect(w).not.toHaveBeenCalled()
    expect(log.entries).toEqual([])
  })

  it('lets an auditor neither approve a month-end closing nor send one back', async () => {
    const draft = service()
    await expect(draft.service.approveClosing(member('auditor'), 'r-1', closing)).rejects.toThrow(
      ForbiddenException
    )
    const closed = service('closed')
    expect((await closed.service.get(member('auditor'), 'r-1')).can).toEqual({
      edit: false,
      close: false,
      sendBack: false,
      requestEdits: false,
      submit: false,
      reopen: false,
      attachSigned: false,
      readPersonal: true,
      deleteMonth: false,
    })
    closed.log.entries.length = 0
    await expect(closed.service.sendBack(member('auditor'), 'r-1', 'Wrong rent')).rejects.toThrow(
      ForbiddenException
    )
    await expect(closed.service.submit(member('auditor'), 'r-1')).rejects.toThrow(
      ForbiddenException
    )
    expect(draft.prisma.monthlyReport.update).not.toHaveBeenCalled()
    expect(closed.prisma.monthlyReport.update).not.toHaveBeenCalled()
    expect([...draft.log.entries, ...closed.log.entries]).toEqual([])
  })

  it('offers the signed copy in any status until one is on file, and personal records to owners', async () => {
    const submitted = service('submitted')
    const owner = member('owner')
    expect((await submitted.service.get(owner, 'r-1')).can).toMatchObject({
      edit: false,
      attachSigned: true,
      readPersonal: true,
      deleteMonth: false,
    })
    signedOnFile(submitted.prisma, [signedCopy('d-signed', '2026-10-07T00:00:00Z')])
    const detail = await submitted.service.get(owner, 'r-1')
    expect(detail.can.attachSigned).toBe(false)
    expect(detail.signedCopy?.id).toBe('d-signed')
    expect(submitted.prisma.document.findMany).toHaveBeenCalledWith({
      where: { engagementId: 'e-1', period: '2026-09', kind: 'signed-report' },
    })
  })

  it('refuses to submit a month before its month-end closing is approved', async () => {
    const who = member('bookkeeper')
    const draft = service()
    expect((await draft.service.get(who, 'r-1')).can).toEqual({
      edit: true,
      close: true,
      sendBack: false,
      requestEdits: true,
      submit: false,
      reopen: false,
      attachSigned: true,
      readPersonal: false,
      deleteMonth: false,
    })
    draft.log.entries.length = 0
    await expect(draft.service.submit(who, 'r-1')).rejects.toThrow(
      'Approve the month-end closing of September 2026 before submitting it'
    )
    await expect(draft.service.sendBack(who, 'r-1', 'Wrong rent')).rejects.toThrow(
      ConflictException
    )
    for (const w of draft.writes) expect(w).not.toHaveBeenCalled()
    expect(draft.log.entries).toEqual([])
  })

  it('locks the ledger of a month whose closing is approved until it is sent back', async () => {
    const who = member('bookkeeper')
    const closed = service('closed')
    expect((await closed.service.get(who, 'r-1')).can).toEqual({
      edit: false,
      close: false,
      sendBack: true,
      requestEdits: true,
      submit: true,
      reopen: false,
      attachSigned: true,
      readPersonal: false,
      deleteMonth: false,
    })
    closed.log.entries.length = 0
    await expect(closed.service.addExpense(who, 'r-1', expense)).rejects.toThrow(
      'The month-end closing of September 2026 is approved; send it back to change the month'
    )
    await expect(closed.service.approveClosing(who, 'r-1', closing)).rejects.toThrow(
      ConflictException
    )
    await expect(closed.service.sendBack(who, 'r-1', '  ')).rejects.toThrow(BadRequestException)
    for (const w of closed.writes) expect(w).not.toHaveBeenCalled()
    expect(closed.log.entries).toEqual([])
    await closed.service.sendBack(who, 'r-1', 'Rent for September is the wrong amount')
    expect(closed.prisma.monthlyReport.update).toHaveBeenCalledWith({
      where: { id: 'r-1' },
      data: {
        status: 'draft',
        authorizedByName: null,
        authorizedAt: null,
        closingNote: null,
        sentBackReason: 'Rent for September is the wrong amount',
        sentBackAt: expect.any(Date),
        sentBackByEmail: who.email,
      },
    })
  })

  describe('asking for edits', () => {
    it('lets an owner or bookkeeper ask on a draft or a closed month, never an auditor or another workspace', async () => {
      for (const status of ['draft', 'closed']) {
        const s = service(status)
        expect((await s.service.get(member('bookkeeper'), 'r-1')).can.requestEdits).toBe(true)
        expect((await s.service.get(member('auditor'), 'r-1')).can.requestEdits).toBe(false)
        s.log.entries.length = 0
        await expect(
          s.service.requestEdits(member('auditor'), 'r-1', 'Fix the rent')
        ).rejects.toThrow(ForbiddenException)
        await expect(s.service.requestEdits(stranger(), 'r-1', 'Fix the rent')).rejects.toThrow(
          NotFoundException
        )
        for (const w of s.writes) expect(w).not.toHaveBeenCalled()
        expect(s.log.entries).toEqual([])
      }
    })

    it('needs a comment of at most 500 characters, and refuses a submitted month', async () => {
      const who = member('owner')
      const s = service()
      for (const bad of ['', '   ', undefined, 42, 'x'.repeat(501)])
        await expect(s.service.requestEdits(who, 'r-1', bad)).rejects.toThrow(BadRequestException)
      const sent = service('submitted')
      expect((await sent.service.get(who, 'r-1')).can.requestEdits).toBe(false)
      sent.log.entries.length = 0
      await expect(sent.service.requestEdits(who, 'r-1', 'Fix the rent')).rejects.toThrow(
        ConflictException
      )
      for (const x of [s, sent]) {
        for (const w of x.writes) expect(w).not.toHaveBeenCalled()
        expect(x.log.entries).toEqual([])
      }
    })

    it.each(['owner', 'bookkeeper'] as const)(
      "records the %s's request on a draft without changing its status, logged once with the comment by name",
      async (role) => {
        const who = member(role)
        const s = service()
        const answer = await s.service.requestEdits(who, 'r-1', '  Rent for September is wrong  ')
        expect(answer.id).toBe('r-1')
        expect(s.prisma.monthlyReport.update).toHaveBeenCalledWith({
          where: { id: 'r-1' },
          data: {
            editsRequestedAt: expect.any(Date),
            editsRequestedByEmail: who.email,
            editsRequestComment: 'Rent for September is wrong',
          },
        })
        expect(s.log.entries).toEqual([
          {
            workspaceId: W,
            resource: 'report',
            subjectId: 'r-1',
            action: 'review',
            description: 'Asked for edits on September 2026 of Coding Pathway',
            changes: [
              { field: 'Edits asked for on', before: null, after: expect.any(String) },
              { field: 'Edits asked for by', before: null, after: who.email },
              { field: 'What needs editing' },
            ],
          },
        ])
        expectNoneOf(s.log.entries, ['Rent for September'])
      }
    )

    it('sends a closed month back to a draft with the comment as the reason', async () => {
      const who = member('bookkeeper')
      const s = service('closed', { authorizedByName: 'Sam Whitfield' })
      await s.service.requestEdits(who, 'r-1', 'Rent for September is wrong')
      expect(s.prisma.monthlyReport.update).toHaveBeenCalledWith({
        where: { id: 'r-1' },
        data: {
          status: 'draft',
          authorizedByName: null,
          authorizedAt: null,
          closingNote: null,
          sentBackReason: 'Rent for September is wrong',
          sentBackAt: expect.any(Date),
          sentBackByEmail: who.email,
        },
      })
      expect(s.log.entries).toHaveLength(1)
      expect(s.log.entries[0]).toMatchObject({
        description: 'Sent back the month-end closing of September 2026 for Coding Pathway',
      })
      expectNoneOf(s.log.entries, ['Rent for September', 'Sam Whitfield'])
    })

    it('clears the request when the closing is approved', async () => {
      const s = service('draft', {
        editsRequestedAt: new Date('2026-10-10T00:00:00Z'),
        editsRequestedByEmail: 'owner@example.test',
        editsRequestComment: 'Fix the rent',
      })
      await s.service.approveClosing(member('owner'), 'r-1', closing)
      expect(s.prisma.monthlyReport.update).toHaveBeenCalledWith({
        where: { id: 'r-1' },
        data: expect.objectContaining({
          status: 'closed',
          editsRequestedAt: null,
          editsRequestedByEmail: null,
          editsRequestComment: null,
        }),
      })
    })
  })

  describe('reopening a submitted month to correct it', () => {
    const submitted = () =>
      service('submitted', {
        submittedAt: new Date('2026-10-08T00:00:00Z'),
        preparedByName: 'Pat Preparer',
        authorizedByName: 'Sam Whitfield',
        authorizedAt: new Date('2026-10-05T00:00:00Z'),
        closingNote: 'Signed off by phone',
      })

    it('lets an owner or bookkeeper reopen it, never an auditor', async () => {
      const auditor = submitted()
      expect((await auditor.service.get(member('auditor'), 'r-1')).can.reopen).toBe(false)
      expect((await auditor.service.get(member('bookkeeper'), 'r-1')).can.reopen).toBe(true)
      auditor.log.entries.length = 0
      await expect(auditor.service.reopen(member('auditor'), 'r-1', 'Typo')).rejects.toThrow(
        ForbiddenException
      )
      for (const w of auditor.writes) expect(w).not.toHaveBeenCalled()
      expect(auditor.log.entries).toEqual([])
    })

    it('reopens only a submitted month, and only with a reason of at most 500 characters', async () => {
      const who = member('owner')
      for (const status of ['draft', 'closed']) {
        const other = service(status)
        await expect(other.service.reopen(who, 'r-1', 'Typo')).rejects.toThrow(
          `Only a submitted month can be reopened; September 2026 is ${status}`
        )
        for (const w of other.writes) expect(w).not.toHaveBeenCalled()
        expect(other.log.entries).toEqual([])
      }
      const s = submitted()
      for (const bad of ['', '   ', undefined, 'x'.repeat(501)])
        await expect(s.service.reopen(who, 'r-1', bad as never)).rejects.toThrow(
          BadRequestException
        )
      for (const w of s.writes) expect(w).not.toHaveBeenCalled()
      expect(s.log.entries).toEqual([])
    })

    it.each(['owner', 'bookkeeper'] as const)(
      'lets the %s reopen it as a draft, without its submission or closing, logged once with the reason by name',
      async (role) => {
        const s = submitted()
        const answer = await s.service.reopen(member(role), 'r-1', '  The rent line has a typo  ')
        expect(answer.id).toBe('r-1')
        expect(s.prisma.monthlyReport.update).toHaveBeenCalledWith({
          where: { id: 'r-1' },
          data: {
            status: 'draft',
            submittedAt: null,
            authorizedByName: null,
            authorizedAt: null,
            closingNote: null,
            sentBackReason: null,
            sentBackAt: null,
            sentBackByEmail: null,
          },
        })
        // Every document stays: nothing is detached or removed.
        expect(s.prisma.expenseDocument.deleteMany).not.toHaveBeenCalled()
        expect(s.log.entries).toEqual([
          {
            workspaceId: W,
            resource: 'report',
            subjectId: 'r-1',
            action: 'review',
            description: 'Reopened September 2026 of Coding Pathway to correct it',
            changes: [
              { field: 'Status', before: 'submitted', after: 'draft' },
              { field: 'Submitted on', before: '2026-10-08', after: null },
              { field: 'Approved by' },
              { field: 'Approved on', before: '2026-10-05', after: null },
              { field: 'Note' },
              { field: 'Why it was reopened' },
            ],
          },
        ])
        expectNoneOf(s.log.entries, ['typo', 'Sam Whitfield', 'Signed off'])
      }
    )

    it('keeps what the reopening undid in the same transaction: the submission, the approval and the signed copy', async () => {
      const s = submitted()
      signedOnFile(s.prisma, [signedCopy('d-signed', '2026-10-07T00:00:00Z')])
      const who = member('bookkeeper')
      await s.service.reopen(who, 'r-1', '  The rent line has a typo  ')
      expect(s.prisma.reportReopening.create).toHaveBeenCalledWith({
        data: {
          monthlyReportId: 'r-1',
          reopenedById: who.userId,
          reopenedByEmail: 'bookkeeper@ws-1.example.org',
          reason: 'The rent line has a typo',
          submittedAt: new Date('2026-10-08T00:00:00Z'),
          approvedByName: 'Sam Whitfield',
          approvedAt: new Date('2026-10-05T00:00:00Z'),
          signedDocumentId: 'd-signed',
        },
      })
      // One transaction: the history row, then the month's own change, then its one line.
      expect(s.log.change).toHaveBeenCalledTimes(1)
      expect(s.prisma.reportReopening.create.mock.invocationCallOrder[0]).toBeLessThan(
        s.prisma.monthlyReport.update.mock.invocationCallOrder[0]!
      )
    })

    it('adds a second row on a second reopening, naming only the signed copy submitted since the first', async () => {
      const first = {
        id: 'ro-1',
        workspaceId: W,
        monthlyReportId: 'r-1',
        reopenedAt: new Date('2026-10-09T00:00:00Z'),
        reopenedByEmail: 'owner@ws-1.example.org',
        reason: 'Rent typo',
        submittedAt: new Date('2026-10-08T00:00:00Z'),
        approvedByName: 'Sam Whitfield',
        approvedAt: new Date('2026-10-05T00:00:00Z'),
        signedDocumentId: 'd-signed',
      }
      const s = service('submitted', {
        submittedAt: new Date('2026-10-12T00:00:00Z'),
        authorizedByName: 'Sam Whitfield',
        authorizedAt: new Date('2026-10-11T00:00:00Z'),
        reopenings: [first],
      })
      s.prisma.reportReopening.findFirst.mockResolvedValue(first)
      signedOnFile(s.prisma, [
        signedCopy('d-signed', '2026-10-07T00:00:00Z'),
        signedCopy('d-signed-2', '2026-10-11T00:00:00Z'),
      ])
      await s.service.reopen(member('owner'), 'r-1', 'Vendor name misspelled')
      expect(s.prisma.reportReopening.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          reason: 'Vendor name misspelled',
          submittedAt: new Date('2026-10-12T00:00:00Z'),
          approvedAt: new Date('2026-10-11T00:00:00Z'),
          signedDocumentId: 'd-signed-2',
        }),
      })
    })

    it('shows every reopening on the month, with its reason, after the month is closed and submitted again', async () => {
      const kept = {
        id: 'ro-1',
        workspaceId: W,
        monthlyReportId: 'r-1',
        reopenedAt: new Date('2026-10-09T00:00:00Z'),
        reopenedByEmail: 'owner@ws-1.example.org',
        reason: 'Rent typo',
        submittedAt: new Date('2026-10-08T00:00:00Z'),
        approvedByName: 'Sam Whitfield',
        approvedAt: new Date('2026-10-05T00:00:00Z'),
        signedDocumentId: 'd-signed',
      }
      for (const status of ['draft', 'closed', 'submitted']) {
        const s = service(status, { reopenings: [kept] })
        signedOnFile(s.prisma, [
          signedCopy('d-signed', '2026-10-07T00:00:00Z'),
          signedCopy('d-signed-2', '2026-10-11T00:00:00Z'),
        ])
        const detail = await s.service.get(member('auditor'), 'r-1')
        expect(detail.reopenings).toEqual([
          {
            id: 'ro-1',
            reopenedAt: '2026-10-09T00:00:00.000Z',
            reopenedBy: 'owner@ws-1.example.org',
            reason: 'Rent typo',
            submittedAt: '2026-10-08T00:00:00.000Z',
            approvedByName: 'Sam Whitfield',
            approvedAt: '2026-10-05T00:00:00.000Z',
            signedDocument: expect.objectContaining({ id: 'd-signed' }),
          },
        ])
        // The copy that counts is the one attached after the reopening.
        expect(detail.signedCopy?.id).toBe('d-signed-2')
        // The page's read line names no reason and no approver.
        expectNoneOf(s.log.entries, ['Rent typo', 'Sam Whitfield'])
      }
      // Approving the closing again changes the month's own row only: the history stays.
      const draft = service('draft', { reopenings: [kept] })
      await draft.service.approveClosing(member('owner'), 'r-1', closing)
      expect(draft.prisma.reportReopening.create).not.toHaveBeenCalled()
      expect(draft.prisma.monthlyReport.update.mock.calls[0]![0].data).not.toHaveProperty(
        'reopenReason'
      )
    })

    it('asks for a new signed copy after a reopening, until one newer than the reopening is on file', async () => {
      const kept = {
        id: 'ro-1',
        reopenedAt: new Date('2026-10-09T00:00:00Z'),
        reopenedByEmail: 'owner@ws-1.example.org',
        reason: 'Rent typo',
        submittedAt: new Date('2026-10-08T00:00:00Z'),
        approvedByName: null,
        approvedAt: null,
        signedDocumentId: 'd-signed',
      }
      const s = service('draft', { reopenings: [kept] })
      signedOnFile(s.prisma, [signedCopy('d-signed', '2026-10-07T00:00:00Z')])
      const before = await s.service.get(member('bookkeeper'), 'r-1')
      expect(before.can.attachSigned).toBe(true)
      expect(before.signedCopy).toBeNull()
      signedOnFile(s.prisma, [
        signedCopy('d-signed', '2026-10-07T00:00:00Z'),
        signedCopy('d-signed-2', '2026-10-10T00:00:00Z'),
      ])
      const after = await s.service.get(member('bookkeeper'), 'r-1')
      expect(after.can.attachSigned).toBe(false)
      expect(after.signedCopy?.id).toBe('d-signed-2')
    })
  })

  it('refuses a month-end closing without an approver, with a bad date, or while a check blocks it', async () => {
    const who = member('owner')
    const draft = service()
    await expect(
      draft.service.approveClosing(who, 'r-1', { ...closing, approvedBy: ' ' })
    ).rejects.toThrow(BadRequestException)
    await expect(
      draft.service.approveClosing(who, 'r-1', { ...closing, approvedOn: '2026-02-30' })
    ).rejects.toThrow(BadRequestException)
    await expect(
      draft.service.approveClosing(who, 'r-1', { ...closing, approvedOn: '2999-01-01' })
    ).rejects.toThrow(BadRequestException)
    draft.prisma.check.findMany.mockResolvedValue([
      {
        id: 'k-1',
        code: 'missing-proof',
        severity: 'blocker',
        source: 'rule',
        message: 'Proof missing',
        status: 'open',
        expenseId: 'x-1',
        participantId: null,
        wexPaymentId: null,
      },
    ])
    await expect(draft.service.approveClosing(who, 'r-1', closing)).rejects.toThrow(
      '1 blocking check(s) must be resolved before approving the month-end closing'
    )
    for (const w of draft.writes) expect(w).not.toHaveBeenCalled()
    expect(draft.log.entries).toEqual([])
  })

  it('logs nothing for a refused change: a month no longer a draft, a blocked submit, bad values', async () => {
    const who = member('bookkeeper')
    const submitted = service('submitted')
    await expect(submitted.service.addExpense(who, 'r-1', expense)).rejects.toThrow(
      ConflictException
    )
    await expect(submitted.service.deleteExpense(who, 'x-1')).rejects.toThrow(ConflictException)
    await expect(submitted.service.submit(who, 'r-1')).rejects.toThrow(ConflictException)
    const closed = service('closed')
    closed.prisma.check.findMany.mockResolvedValue([
      {
        id: 'k-1',
        code: 'missing-proof',
        severity: 'blocker',
        source: 'rule',
        message: 'Proof missing',
        status: 'open',
        expenseId: 'x-1',
        participantId: null,
        wexPaymentId: null,
      },
    ])
    await expect(closed.service.submit(who, 'r-1')).rejects.toThrow(
      '1 blocking check(s) must be resolved before submitting'
    )
    const draft = service()
    await expect(
      draft.service.addExpense(who, 'r-1', { ...expense, itemNumber: '<b>1001</b>' })
    ).rejects.toThrow(BadRequestException)
    await expect(draft.service.attachToExpense(who, 'x-1', 'invoice', 'd-other')).rejects.toThrow(
      NotFoundException
    )
    await expect(draft.service.attachToWex(who, 'wx-1', 'payment', 'd-other')).rejects.toThrow(
      NotFoundException
    )
    for (const w of [...submitted.writes, ...closed.writes, ...draft.writes])
      expect(w).not.toHaveBeenCalled()
    expect([...submitted.log.entries, ...closed.log.entries, ...draft.log.entries]).toEqual([])
  })

  it('takes item numbers and accounts as ID-like text only, and explains the rule', async () => {
    const who = member('bookkeeper')
    const { service: s, log } = service()
    const rule = 'may use letters, digits, #, &, ., /, - and spaces, from 1 to 40 characters'
    await expect(
      s.addExpense(who, 'r-1', { ...expense, itemNumber: 'Jordan; 555-01-0000!' })
    ).rejects.toThrow(`Item number ${rule}`)
    await expect(
      s.addExpense(who, 'r-1', { ...expense, account: 'Stipend: J. Doe' })
    ).rejects.toThrow(`Account (general ledger) ${rule}`)
    // A general-ledger name like "69000 G&A" is ID-like (a separate service, so its line is not counted below).
    await expect(
      service().service.addExpense(who, 'r-1', { ...expense, account: '69000 G&A' })
    ).resolves.toBeDefined()
    await expect(
      s.addExpense(who, 'r-1', { ...expense, itemNumber: '1'.repeat(41) })
    ).rejects.toThrow(BadRequestException)
    expect(log.entries).toEqual([])
    // The values the demo seed and the other specs use pass.
    for (const itemNumber of ['RYS-14', 'HTC-2', 'T-1', '1001', 'No. 4/2026 #7'])
      await s.addExpense(who, 'r-1', { ...expense, itemNumber })
    for (const account of ['60701 Accounting Fees', '63103 Salaries - WEX', '62100 Travel'])
      await s.addExpense(who, 'r-1', { ...expense, account })
  })

  it("logs every change once, in the screen's words, with amounts and dates but no participant or vendor names", async () => {
    const who = member('bookkeeper')
    const draft = service()
    // Nothing in the slot when attaching; the attached statement there when detaching.
    draft.prisma.expenseDocument.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ purpose: 'payment' })
    const answers = [
      await draft.service.addExpense(who, 'r-1', { ...expense, memo: 'Classroom rent' }),
      await draft.service.updateExpense(who, 'x-1', {
        ...expense,
        allocatedAmount: 75,
        allocationType: 'usage',
        reportLine: 'staff-salaries',
      }),
      await draft.service.attachToExpense(who, 'x-1', 'payment', 'd-1'),
      await draft.service.detachFromExpense(who, 'x-1', 'd-1'),
      await draft.service.deleteExpense(who, 'x-1'),
      await draft.service.addWexPayment(who, 'r-1', wex),
      await draft.service.attachToWex(who, 'wx-1', 'timesheet', 'd-1'),
      await draft.service.approveClosing(who, 'r-1', closing),
    ]
    const closed = service('closed')
    answers.push(await closed.service.sendBack(who, 'r-1', 'Jordan Sample is missing a timesheet'))
    const ready = service('closed')
    answers.push(await ready.service.submit(who, 'r-1'))
    // Each change answers with the month's page, and that answer is not another read.
    for (const a of answers) expect(a.id).toBe('r-1')
    const entries = [...draft.log.entries, ...closed.log.entries, ...ready.log.entries]
    expect(entries.map((e) => [e.resource, e.action, e.description])).toEqual([
      ['expense', 'create', 'Added expense 1001 to September 2026'],
      ['expense', 'update', 'Changed expense 1001 in September 2026'],
      ['expense', 'update', 'Attached evidence of payment to expense 1001'],
      ['expense', 'update', 'Detached evidence of payment from expense 1001'],
      ['expense', 'delete', 'Removed expense 1001 from September 2026'],
      ['report', 'create', 'Added a work-experience payment to September 2026'],
      ['report', 'update', 'Attached timesheet to a work-experience payment in September 2026'],
      ['report', 'review', 'Approved the month-end closing of September 2026 for Coding Pathway'],
      ['report', 'review', 'Sent back the month-end closing of September 2026 for Coding Pathway'],
      ['report', 'submit', 'Submitted September 2026 of Coding Pathway to Demo Workforce Board'],
    ])
    expect(entries.every((e) => e.workspaceId === W)).toBe(true)
    // Amounts, dates and statuses by value, under the form's labels; the vendor, the memo and anything about a
    // participant by name alone.
    expect(entries[0]!.changes).toEqual(
      expect.arrayContaining([
        { field: 'Date', after: '2026-09-02' },
        { field: 'Amount charged to this program', after: '50.00' },
        { field: 'Account (general ledger)', after: '60701 Accounting Fees' },
        { field: 'Allocation', after: 'Direct (all of it)' },
        { field: 'Report line', after: 'Program Costs' },
        { field: 'Vendor' },
        { field: 'Memo' },
      ])
    )
    expect(entries[1]!.changes).toEqual([
      { field: 'Amount charged to this program', before: '50.00', after: '75.00' },
      { field: 'Allocation', before: 'Direct (all of it)', after: 'Shared, by usage' },
      { field: 'Report line', before: 'Program Costs', after: 'Staff Salaries' },
    ])
    expect(entries[5]!.changes).toEqual([
      { field: 'Participant' },
      { field: 'Pay period start' },
      { field: 'Pay period end' },
      { field: 'Gross pay' },
    ])
    // The approver is a person and the note and reason are free text: by name alone; the date by value.
    expect(entries[7]!.changes).toEqual([
      { field: 'Status', before: 'draft', after: 'closed' },
      { field: 'Approved by' },
      { field: 'Approved on', before: null, after: '2026-10-05' },
      { field: 'Note' },
    ])
    expect(entries[8]!.changes).toEqual([
      { field: 'Status', before: 'closed', after: 'draft' },
      { field: 'Why it was sent back' },
      { field: 'Sent back on', before: null, after: expect.any(String) },
      { field: 'Sent back by', before: null, after: 'bookkeeper@ws-1.example.org' },
    ])
    expect(entries[9]!.changes).toEqual(
      expect.arrayContaining([
        { field: 'Status', before: 'closed', after: 'submitted' },
        { field: 'Prepared by' },
      ])
    )
    expectNoneOf(entries, [
      'Jordan',
      '900001',
      'p-1',
      'Ledger & Co.',
      'Classroom rent',
      '280',
      'The bookkeeper',
      'Sam Whitfield',
      'Signed off by phone',
      'missing a timesheet',
    ])
  })

  describe('tags', () => {
    const youth = 'funding-source:youth-workforce-fund'

    it("tags an expense from the workspace's list, logged in the list's words", async () => {
      const { service: s, prisma, log } = service()
      const detail = await s.addExpense(member('bookkeeper'), 'r-1', { ...expense, tags: [youth] })
      expect((prisma.expense.create.mock.calls[0]![0].data as { tags: string[] }).tags).toEqual([
        youth,
      ])
      expect(detail.tagTypes.map((t) => t.label)).toEqual(['Funding source', 'Age group'])
      expect(log.entries[0]!.changes).toEqual(
        expect.arrayContaining([{ field: 'Tags', after: 'Funding source: Youth Workforce Fund' }])
      )
    })

    it('refuses free text, a value of a type that is not for expenses, and a non-list', async () => {
      const { service: s, writes, log } = service()
      const who = member('bookkeeper')
      for (const tags of [
        ['north campus'],
        ['age-group:under-18'],
        ['funding-source:not-a-fund'],
        'x',
      ])
        await expect(
          s.addExpense(who, 'r-1', { ...expense, tags: tags as string[] })
        ).rejects.toThrow(BadRequestException)
      for (const w of writes) expect(w).not.toHaveBeenCalled()
      expect(log.entries).toEqual([])
    })

    it('keeps a tag whose value left the list on the record that has it, and leaves tags alone when not sent', async () => {
      const { service: s, prisma } = service()
      const old = { ...stored, tags: ['funding-source:Retired Fund'] }
      prisma.expense.findFirst.mockResolvedValue(old)
      const who = member('bookkeeper')
      await s.updateExpense(who, 'x-1', { ...expense, memo: 'Rent', tags: [...old.tags, youth] })
      expect(prisma.expense.update.mock.calls[0][0].data.tags).toEqual([youth, ...old.tags])
      await s.updateExpense(who, 'x-1', { ...expense, memo: 'Rent again' })
      expect(prisma.expense.update.mock.calls[1][0].data).not.toHaveProperty('tags')
      await expect(
        s.addExpense(who, 'r-1', { ...expense, tags: ['funding-source:Retired Fund'] })
      ).rejects.toThrow(BadRequestException)
    })

    it('refuses a work-experience payment with impossible hours, pay or dates (400), and stores nothing', async () => {
      const { service: s, prisma, log } = service()
      const who = member('bookkeeper')
      for (const bad of [
        { hours: -1 },
        { hours: Number.NaN },
        { hours: 'lots' as unknown as number },
        { grossAmount: 0 },
        { grossAmount: -5 },
        { payPeriodStart: '2026-09-21' },
        { payPeriodEnd: '2026-02-31' },
      ])
        await expect(s.addWexPayment(who, 'r-1', { ...wex, ...bad })).rejects.toThrow(
          BadRequestException
        )
      expect(prisma.wexPayment.create).not.toHaveBeenCalled()
      expect(log.entries).toEqual([])
      await s.addWexPayment(who, 'r-1', { ...wex, hours: 0, payPeriodEnd: wex.payPeriodStart })
      expect(prisma.wexPayment.create).toHaveBeenCalledTimes(1)
    })

    it('changes and removes a work-experience payment, each with its line, and logs pay by field', async () => {
      const { service: s, prisma, log } = service()
      const who = member('bookkeeper')
      await s.updateWexPayment(who, 'wx-1', { ...wex, grossAmount: 300 })
      expect(prisma.wexPayment.update.mock.calls[0][0]).toMatchObject({
        where: { id: 'wx-1' },
        data: { grossAmount: '300.00' },
      })
      await s.deleteWexPayment(who, 'wx-1')
      expect(prisma.wexPayment.delete).toHaveBeenCalledWith({ where: { id: 'wx-1' } })
      expect(log.entries.map((e) => [e.action, e.description])).toEqual([
        ['update', 'Changed a work-experience payment in September 2026'],
        ['delete', 'Removed a work-experience payment from September 2026'],
      ])
      await expect(s.updateWexPayment(who, 'wx-1', { ...wex, grossAmount: 0 })).rejects.toThrow(
        BadRequestException
      )
    })

    it("tags a payroll item in its edit and logs the field by name alone: a participant's pay", async () => {
      const { service: s, prisma, log } = service()
      await s.updateWexPayment(member('bookkeeper'), 'wx-1', {
        ...wex,
        tags: ['age-group:under-18'],
      })
      expect(prisma.wexPayment.update.mock.calls[0][0].data.tags).toEqual(['age-group:under-18'])
      expect(log.entries[0]!.changes).toContainEqual({ field: 'Tags' })
      expectNoneOf(log.entries, ['Under 18', 'under-18', 'age-group'])
      await expect(
        s.updateWexPayment(member('bookkeeper'), 'wx-1', { ...wex, tags: ['site:north'] })
      ).rejects.toThrow(BadRequestException)
      expect(prisma.wexPayment.update).toHaveBeenCalledTimes(1)
    })

    it('detaches the proof when the payment names another participant, and says so in the line', async () => {
      const {
        service: s,
        prisma,
        log,
      } = service('draft', {
        engagement: {
          ...report().engagement,
          participants: [
            ...report().engagement.participants,
            { ...report().engagement.participants[0]!, id: 'p-2', displayName: 'Casey Demo' },
          ],
        },
      })
      prisma.wexPayment.findFirst.mockResolvedValue({
        id: 'wx-1',
        workspaceId: W,
        monthlyReportId: 'r-1',
        participantId: 'p-1',
        tags: [],
      } as never)
      prisma.wexPaymentDocument.deleteMany.mockResolvedValueOnce({ count: 3 })
      await s.updateWexPayment(member('bookkeeper'), 'wx-1', { ...wex, participantId: 'p-2' })
      expect(prisma.wexPaymentDocument.deleteMany).toHaveBeenCalledWith({
        where: { wexPaymentId: 'wx-1' },
      })
      // The same person, other pay: the proof stays linked.
      await s.updateWexPayment(member('bookkeeper'), 'wx-1', { ...wex, grossAmount: 300 })
      expect(prisma.wexPaymentDocument.deleteMany).toHaveBeenCalledTimes(1)
      expect(log.entries.map((e) => e.description)).toEqual([
        'Changed a work-experience payment in September 2026; detached its 3 proofs, to be matched again for the participant now named',
        'Changed a work-experience payment in September 2026',
      ])
      expectNoneOf(log.entries, ['Casey', 'Jordan'])
    })

    it('removes no payroll item once the closing was approved meanwhile', async () => {
      const { service: s, prisma, log } = service()
      prisma.$queryRaw.mockResolvedValueOnce([{ status: 'closed', period: '2026-09' }])
      await expect(s.deleteWexPayment(member('owner'), 'wx-1')).rejects.toThrow(
        /month-end closing of September 2026 is approved/
      )
      expect(prisma.wexPayment.delete).not.toHaveBeenCalled()
      expect(log.entries).toEqual([])
    })

    it('changes no payroll item in a month whose closing is approved', async () => {
      const { service: s, prisma } = service('closed')
      await expect(
        s.updateWexPayment(member('owner'), 'wx-1', { ...wex, tags: [youth] })
      ).rejects.toThrow(ConflictException)
      await expect(s.deleteWexPayment(member('owner'), 'wx-1')).rejects.toThrow(ConflictException)
      expect(prisma.wexPayment.update).not.toHaveBeenCalled()
      expect(prisma.wexPayment.delete).not.toHaveBeenCalled()
    })
  })

  describe('deleting an empty month', () => {
    const empty = { expenses: [], wexPayments: [], reopenings: [] }

    it('lets an owner delete a draft with nothing in it, and logs it', async () => {
      const { service: s, prisma, log } = service('draft', empty)
      prisma.document.count.mockResolvedValue(0)
      expect((await s.get(member('owner'), 'r-1')).can.deleteMonth).toBe(true)
      expect(await s.deleteEmptyMonth(member('owner'), 'r-1')).toEqual({ engagementId: 'e-1' })
      expect(prisma.monthlyReport.delete).toHaveBeenCalledWith({ where: { id: 'r-1' } })
      expect(log.entries.map((e) => e.description)).toContain(
        'Deleted September 2026, a month with nothing to submit'
      )
    })

    it('refuses a bookkeeper, and a month with a file, a line or a submission behind it', async () => {
      const bookkeeper = service('draft', empty)
      bookkeeper.prisma.document.count.mockResolvedValue(0)
      expect((await bookkeeper.service.get(member('bookkeeper'), 'r-1')).can.deleteMonth).toBe(
        false
      )
      await expect(
        bookkeeper.service.deleteEmptyMonth(member('bookkeeper'), 'r-1')
      ).rejects.toThrow(ForbiddenException)
      const withFile = service('draft', empty)
      await expect(withFile.service.deleteEmptyMonth(member('owner'), 'r-1')).rejects.toThrow(
        /not empty/
      )
      const submitted = service('submitted', empty)
      submitted.prisma.document.count.mockResolvedValue(0)
      await expect(submitted.service.deleteEmptyMonth(member('owner'), 'r-1')).rejects.toThrow(
        ConflictException
      )
      const withLine = service('draft', { ...empty, expenses: [{ id: 'x-1' }] })
      withLine.prisma.document.count.mockResolvedValue(0)
      await expect(withLine.service.deleteEmptyMonth(member('owner'), 'r-1')).rejects.toThrow(
        /not empty/
      )
      for (const x of [bookkeeper, withFile, submitted, withLine])
        expect(x.prisma.monthlyReport.delete).not.toHaveBeenCalled()
    })

    it('checks again inside the delete: a closing approved or an expense added meanwhile refuses it', async () => {
      const closed = service('draft', empty)
      closed.prisma.document.count.mockResolvedValue(0)
      closed.prisma.$queryRaw.mockResolvedValueOnce([{ status: 'closed' }])
      const added = service('draft', empty)
      added.prisma.document.count.mockResolvedValue(0)
      added.prisma.expense.count.mockResolvedValueOnce(1)
      for (const x of [closed, added]) {
        await expect(x.service.deleteEmptyMonth(member('owner'), 'r-1')).rejects.toThrow(
          /not empty/
        )
        expect(x.prisma.monthlyReport.delete).not.toHaveBeenCalled()
        expect(x.log.entries).toEqual([])
      }
      expect(closed.prisma.$queryRaw.mock.calls[0]![0].join('?')).toContain('FOR UPDATE')
    })

    it('refuses while an unsaved payroll match holds staged files for the month', async () => {
      const { service: s, prisma, log } = service('draft', empty)
      prisma.document.count.mockResolvedValue(0)
      prisma.payrollMatchRun.count.mockResolvedValueOnce(1)
      await expect(s.deleteEmptyMonth(member('owner'), 'r-1')).rejects.toThrow(
        /save or discard that match first/
      )
      expect(prisma.monthlyReport.delete).not.toHaveBeenCalled()
      expect(log.entries).toEqual([])
    })
  })

  it('writes nothing and logs nothing for a save with nothing edited', async () => {
    const { service: s, prisma, log } = service()
    const detail = await s.updateExpense(member('bookkeeper'), 'x-1', expense)
    expect(detail.id).toBe('r-1')
    expect(prisma.expense.update).not.toHaveBeenCalled()
    expect(log.entries).toEqual([])
  })

  it('logs nothing when the document is already in that slot, and a move when it is in another', async () => {
    const who = member('bookkeeper')
    const { service: s, prisma, log } = service()
    prisma.expenseDocument.findFirst.mockResolvedValue({ purpose: 'invoice' })
    await s.attachToExpense(who, 'x-1', 'invoice', 'd-bank')
    expect(prisma.expenseDocument.update).not.toHaveBeenCalled()
    expect(log.entries).toEqual([])
    await s.attachToExpense(who, 'x-1', 'payment', 'd-bank')
    expect(prisma.expenseDocument.update).toHaveBeenCalledWith({
      where: { expenseId_documentId: { expenseId: 'x-1', documentId: 'd-bank' } },
      // A move clears any marked line and highlights: they belong to the proof it was.
      data: { purpose: 'payment', mark: Prisma.DbNull, marks: [] },
    })
    expect(prisma.expenseDocument.create).not.toHaveBeenCalled()
    prisma.wexPaymentDocument.findFirst.mockResolvedValue({ purpose: 'timesheet' })
    await s.attachToWex(who, 'wx-1', 'timesheet', 'd-bank')
    await s.attachToWex(who, 'wx-1', 'register', 'd-bank')
    expect(log.entries.map((e) => e.description)).toEqual([
      'Moved a bank statement on expense 1001 from invoice to evidence of payment',
      'Moved a bank statement on a work-experience payment in September 2026 from timesheet to payroll register',
    ])
  })

  it('uploads and attaches in one transaction with one line, and the file is never named', async () => {
    const who = member('bookkeeper')
    const { service: s, prisma, log } = service()
    const { file, storage } = staged()
    const detail = await s.attachToExpense(who, 'x-1', 'payment', file)
    expect(detail.id).toBe('r-1')
    expect(storage.upload).toHaveBeenCalledTimes(1)
    expect(prisma.expenseDocument.create).toHaveBeenCalledWith({
      data: { expenseId: 'x-1', documentId: 'd-new', purpose: 'payment' },
    })
    expect(file.row?.id).toBe('d-new')
    expect(log.entries).toEqual([
      {
        workspaceId: W,
        resource: 'expense',
        subjectId: 'x-1',
        action: 'update',
        description:
          'Uploaded a bank statement and attached it to expense 1001 as evidence of payment',
      },
    ])
    expectNoneOf(log.entries, ['Jordan', 'bank.pdf'])
  })

  it('leaves nothing half done when an upload cannot be attached', async () => {
    const who = member('bookkeeper')
    // Filed under another engagement: refused before anything is stored.
    const other = service()
    const wrong = staged('e-9')
    await expect(other.service.attachToExpense(who, 'x-1', 'payment', wrong.file)).rejects.toThrow(
      BadRequestException
    )
    expect(wrong.storage.upload).not.toHaveBeenCalled()
    // The transaction fails after the object was stored: the object is deleted again, and no line stays.
    const { service: s, prisma, log } = service()
    prisma.expenseDocument.create.mockRejectedValue(new Error('database down'))
    const { file, storage } = staged()
    await expect(s.attachToExpense(who, 'x-1', 'payment', file)).rejects.toThrow('database down')
    expect(storage.upload).toHaveBeenCalledTimes(1)
    expect(storage.delete).toHaveBeenCalledWith(`${W}/e-1/2026-09/new.pdf`)
    expect(file.row).toBeNull()
    expect([...other.log.entries, ...log.entries]).toEqual([])
  })
})
