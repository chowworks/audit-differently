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

function service(status = 'draft') {
  const prisma = {
    monthlyReport: { ...scoped(report(status)), update: jest.fn() },
    expense: {
      ...scoped(stored),
      create: jest.fn(async ({ data }: { data: object }) => ({ id: 'x-2', ...data })),
      update: jest.fn(),
      delete: jest.fn(),
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
    },
    wexPaymentDocument: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      update: jest.fn(),
    },
    document: {
      findMany: jest.fn().mockResolvedValue([document('d-1', W)]),
      findFirst: scoped(
        document('d-1', W),
        document('d-bank', W, 'bank-statement'),
        document('d-other', OTHER)
      ).findFirst,
      create: jest.fn(async ({ data }: { data: object }) => ({
        id: 'd-new',
        uploadedAt: new Date('2026-10-02T00:00:00Z'),
        ...data,
      })),
    },
    check: { findMany: jest.fn().mockResolvedValue([]) },
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
    prisma.wexPaymentDocument.create,
    prisma.wexPaymentDocument.update,
    prisma.document.create,
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
const decision = { decision: 'approve' as const }

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
    await expect(s.attachToWex(who, 'wx-1', 'payment', 'd-1')).rejects.toThrow(NotFoundException)
    await expect(s.submit(who, 'r-1')).rejects.toThrow(NotFoundException)
    await expect(s.review(who, 'r-1', decision)).rejects.toThrow(NotFoundException)
    await expect(s.reopen(who, 'r-1')).rejects.toThrow(NotFoundException)
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
      submit: false,
      review: false,
      reopen: false,
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
    await expect(s.attachToWex(who, 'wx-1', 'payment', 'd-1')).rejects.toThrow(ForbiddenException)
    await expect(s.submit(who, 'r-1')).rejects.toThrow(ForbiddenException)
    await expect(s.reopen(who, 'r-1')).rejects.toThrow(ForbiddenException)
    for (const w of writes) expect(w).not.toHaveBeenCalled()
    expect(log.entries).toEqual([])
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
    expect([...submitted.log.entries, ...denied.log.entries]).toEqual([])
  })

  it('logs nothing for a refused change: a month no longer a draft, a blocked submit, bad values', async () => {
    const who = member('bookkeeper')
    const submitted = service('submitted')
    await expect(submitted.service.addExpense(who, 'r-1', expense)).rejects.toThrow(
      ConflictException
    )
    await expect(submitted.service.deleteExpense(who, 'x-1')).rejects.toThrow(ConflictException)
    await expect(submitted.service.submit(who, 'r-1')).rejects.toThrow(ConflictException)
    const draft = service()
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
    await expect(draft.service.submit(who, 'r-1')).rejects.toThrow(ConflictException)
    await expect(
      draft.service.addExpense(who, 'r-1', { ...expense, itemNumber: '<b>1001</b>' })
    ).rejects.toThrow(BadRequestException)
    await expect(draft.service.attachToExpense(who, 'x-1', 'invoice', 'd-other')).rejects.toThrow(
      NotFoundException
    )
    await expect(draft.service.attachToWex(who, 'wx-1', 'payment', 'd-other')).rejects.toThrow(
      NotFoundException
    )
    for (const w of [...submitted.writes, ...draft.writes]) expect(w).not.toHaveBeenCalled()
    expect([...submitted.log.entries, ...draft.log.entries]).toEqual([])
  })

  it('takes item numbers, accounts and IV numbers as ID-like text only, and explains the rule', async () => {
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
    const submitted = service('submitted')
    await expect(
      submitted.service.review(who, 'r-1', {
        decision: 'approve',
        review: { invoiceNumber: 'INV\n42' },
      })
    ).rejects.toThrow(`IV# for payment ${rule}`)
    expect([...log.entries, ...submitted.log.entries]).toEqual([])
    // The values the demo seed and the other specs use pass.
    for (const itemNumber of ['RYS-14', 'HTC-2', 'T-1', '1001', 'No. 4/2026 #7'])
      await s.addExpense(who, 'r-1', { ...expense, itemNumber })
    for (const account of ['60701 Accounting Fees', '63103 Salaries - WEX', '62100 Travel'])
      await s.addExpense(who, 'r-1', { ...expense, account })
    await submitted.service.review(who, 'r-1', {
      decision: 'approve',
      review: { invoiceNumber: 'IV-26-0412' },
    })
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
      await draft.service.submit(who, 'r-1'),
    ]
    const submitted = service('submitted')
    answers.push(
      await submitted.service.review(who, 'r-1', {
        decision: 'deny',
        reason: 'Jordan Sample is missing a timesheet',
        review: { invoiceNumber: 'INV-0042' },
      })
    )
    const denied = service('denied')
    answers.push(await denied.service.reopen(who, 'r-1'))
    // Each change answers with the month's page, and that answer is not another read.
    for (const a of answers) expect(a.id).toBe('r-1')
    const entries = [...draft.log.entries, ...submitted.log.entries, ...denied.log.entries]
    expect(entries.map((e) => [e.resource, e.action, e.description])).toEqual([
      ['expense', 'create', 'Added expense 1001 to September 2026'],
      ['expense', 'update', 'Changed expense 1001 in September 2026'],
      ['expense', 'update', 'Attached evidence of payment to expense 1001'],
      ['expense', 'update', 'Detached evidence of payment from expense 1001'],
      ['expense', 'delete', 'Removed expense 1001 from September 2026'],
      ['report', 'create', 'Added a work-experience payment to September 2026'],
      ['report', 'update', 'Attached timesheet to a work-experience payment in September 2026'],
      ['report', 'submit', 'Submitted September 2026 of Coding Pathway to Demo Workforce Board'],
      ['report', 'review', "Recorded the funder's denial of September 2026 of Coding Pathway"],
      ['report', 'update', 'Reopened September 2026 of Coding Pathway to correct it'],
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
    expect(entries[7]!.changes).toEqual(
      expect.arrayContaining([
        { field: 'Status', before: 'draft', after: 'submitted' },
        { field: 'Prepared by' },
      ])
    )
    expect(entries[8]!.changes).toEqual(
      expect.arrayContaining([
        { field: 'Status', before: 'submitted', after: 'denied' },
        { field: 'IV# for payment', before: null, after: 'INV-0042' },
        { field: 'If denied, why' },
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
    ])
  })

  it('names who authorized a month an owner submits by field alone', async () => {
    const draft = service()
    await draft.service.submit(member('owner'), 'r-1')
    expect(draft.log.entries[0]!.changes).toEqual(
      expect.arrayContaining([
        { field: 'Authorized by' },
        {
          field: 'Authorized on',
          before: null,
          after: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        },
      ])
    )
    expectNoneOf(draft.log.entries, ['The owner'])
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
      data: { purpose: 'payment' },
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
