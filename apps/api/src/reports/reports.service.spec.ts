import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common'
import type { ExpenseInput, WexPaymentInput } from '@ad/types'
import { member, OTHER, scoped, stranger, W } from '../core/testing/callers'
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
  review: null,
  reviewedAt: null,
  deniedReason: null,
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
    fundingSources: [],
    reportDueDay: 12,
    awardAmount: 125000,
    workspace: { id: W, name: 'Riverbend Youth Services', fundingSources: [] },
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
})

const document = (id: string, workspaceId: string) => ({
  id,
  workspaceId,
  kind: 'invoice',
  sensitivity: 'financial',
  fileName: `${id}.pdf`,
  contentType: 'application/pdf',
  size: 1,
  period: null,
  uploadedAt: new Date('2026-10-01T00:00:00Z'),
})

function service(status = 'draft') {
  const prisma = {
    monthlyReport: { ...scoped(report(status)), update: jest.fn() },
    expense: {
      ...scoped({ id: 'x-1', workspaceId: W, monthlyReportId: 'r-1', itemNumber: 'RYS-1' }),
      create: jest.fn(async ({ data }: { data: object }) => ({
        id: 'x-2',
        documents: [],
        ...data,
      })),
      update: jest.fn(),
      delete: jest.fn(),
    },
    expenseDocument: { upsert: jest.fn(), deleteMany: jest.fn() },
    wexPayment: {
      ...scoped({ id: 'wx-1', workspaceId: W, monthlyReportId: 'r-1' }),
      create: jest.fn(),
    },
    wexPaymentDocument: { upsert: jest.fn() },
    document: {
      findMany: jest.fn().mockResolvedValue([document('d-1', W)]),
      findFirst: scoped(document('d-1', W), document('d-other', OTHER)).findFirst,
    },
    check: { findMany: jest.fn().mockResolvedValue([]) },
  }
  // Only the month's own earlier expenses are read; the fake expense rows are for the id lookups.
  prisma.expense.findMany.mockResolvedValue([])
  const checks = { refresh: jest.fn().mockResolvedValue([]) }
  const log = { log: jest.fn().mockResolvedValue(undefined) }
  const writes = [
    prisma.monthlyReport.update,
    prisma.expense.create,
    prisma.expense.update,
    prisma.expense.delete,
    prisma.expenseDocument.upsert,
    prisma.expenseDocument.deleteMany,
    prisma.wexPayment.create,
    prisma.wexPaymentDocument.upsert,
  ]
  return {
    service: new ReportsService(prisma as never, checks as never, log as never),
    prisma,
    log,
    writes,
  }
}

const expense: ExpenseInput = {
  itemNumber: 'RYS-2',
  date: '2026-09-02',
  vendor: 'Ledger & Co.',
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
const decision = { decision: 'approve' as const }

describe('ReportsService', () => {
  it('answers a member of another workspace with 404 from every route and writes nothing', async () => {
    const { service: s, log, writes } = service('submitted')
    const who = stranger()
    await expect(s.get(who, 'r-1')).rejects.toThrow(NotFoundException)
    await expect(s.addExpense(who, 'r-1', expense)).rejects.toThrow(NotFoundException)
    await expect(s.updateExpense(who, 'x-1', expense)).rejects.toThrow(NotFoundException)
    await expect(s.deleteExpense(who, 'x-1')).rejects.toThrow(NotFoundException)
    await expect(s.attachToExpense(who, 'x-1', 'd-1', 'invoice')).rejects.toThrow(NotFoundException)
    await expect(s.detachFromExpense(who, 'x-1', 'd-1')).rejects.toThrow(NotFoundException)
    await expect(s.addWexPayment(who, 'r-1', wex)).rejects.toThrow(NotFoundException)
    await expect(s.attachToWex(who, 'wx-1', 'd-1', 'payment')).rejects.toThrow(NotFoundException)
    await expect(s.submit(who, 'r-1')).rejects.toThrow(NotFoundException)
    await expect(s.review(who, 'r-1', decision)).rejects.toThrow(NotFoundException)
    await expect(s.reopen(who, 'r-1')).rejects.toThrow(NotFoundException)
    for (const w of writes) expect(w).not.toHaveBeenCalled()
    expect(log.log).not.toHaveBeenCalled()
  })

  it('lets an auditor read the month, logs what it lists, and refuses every change', async () => {
    const { service: s, log, writes } = service()
    const who = member('auditor')
    const detail = await s.get(who, 'r-1')
    expect(detail.can).toEqual({ edit: false, submit: false, review: false, reopen: false })
    expect(detail.documents).toHaveLength(1)
    expect(detail.participants).toHaveLength(1)
    expect(log.log).toHaveBeenCalledWith(
      who,
      expect.objectContaining({ workspaceId: W, resource: 'document', action: 'list' })
    )
    expect(log.log).toHaveBeenCalledWith(
      who,
      expect.objectContaining({ workspaceId: W, resource: 'participant', action: 'list' })
    )
    await expect(s.addExpense(who, 'r-1', expense)).rejects.toThrow(ForbiddenException)
    await expect(s.updateExpense(who, 'x-1', expense)).rejects.toThrow(ForbiddenException)
    await expect(s.deleteExpense(who, 'x-1')).rejects.toThrow(ForbiddenException)
    await expect(s.attachToExpense(who, 'x-1', 'd-1', 'invoice')).rejects.toThrow(
      ForbiddenException
    )
    await expect(s.detachFromExpense(who, 'x-1', 'd-1')).rejects.toThrow(ForbiddenException)
    await expect(s.addWexPayment(who, 'r-1', wex)).rejects.toThrow(ForbiddenException)
    await expect(s.attachToWex(who, 'wx-1', 'd-1', 'payment')).rejects.toThrow(ForbiddenException)
    await expect(s.submit(who, 'r-1')).rejects.toThrow(ForbiddenException)
    await expect(s.reopen(who, 'r-1')).rejects.toThrow(ForbiddenException)
    for (const w of writes) expect(w).not.toHaveBeenCalled()
  })

  it("lets an auditor neither record the funder's decision nor reopen a denied month", async () => {
    const submitted = service('submitted')
    await expect(submitted.service.review(member('auditor'), 'r-1', decision)).rejects.toThrow(
      ForbiddenException
    )
    const denied = service('denied')
    await expect(denied.service.reopen(member('auditor'), 'r-1')).rejects.toThrow(
      ForbiddenException
    )
    expect(submitted.prisma.monthlyReport.update).not.toHaveBeenCalled()
    expect(denied.prisma.monthlyReport.update).not.toHaveBeenCalled()
  })

  it('lets a bookkeeper change a draft, and only a draft', async () => {
    const draft = service()
    const who = member('bookkeeper')
    expect((await draft.service.get(who, 'r-1')).can.edit).toBe(true)
    await draft.service.addExpense(who, 'r-1', expense)
    expect(draft.prisma.expense.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ monthlyReportId: 'r-1', engagementId: 'e-1' }),
      })
    )
    await draft.service.attachToExpense(who, 'x-1', 'd-1', 'invoice')
    expect(draft.prisma.expenseDocument.upsert).toHaveBeenCalled()
    // A document of another workspace is not there to attach.
    await expect(draft.service.attachToExpense(who, 'x-1', 'd-other', 'invoice')).rejects.toThrow(
      NotFoundException
    )
    await expect(draft.service.attachToWex(who, 'wx-1', 'd-other', 'payment')).rejects.toThrow(
      NotFoundException
    )
    const submitted = service('submitted')
    await expect(submitted.service.addExpense(who, 'r-1', expense)).rejects.toThrow(
      ConflictException
    )
    await expect(submitted.service.deleteExpense(who, 'x-1')).rejects.toThrow(ConflictException)
    expect(submitted.prisma.expense.delete).not.toHaveBeenCalled()
  })

  it("lets a bookkeeper submit a draft and record the funder's decision on a submitted month", async () => {
    const who = member('bookkeeper')
    const draft = service()
    expect(await draft.service.submit(who, 'r-1')).toEqual({ blockers: [] })
    expect(draft.prisma.monthlyReport.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'submitted' }) })
    )
    const submitted = service('submitted')
    await submitted.service.review(who, 'r-1', decision)
    expect(submitted.prisma.monthlyReport.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'approved' }) })
    )
  })
})
