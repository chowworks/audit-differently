import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import {
  ALLOCATION_TYPE_LABELS,
  ALLOCATION_TYPES,
  DOCUMENT_PURPOSES,
  REPORT_LINE_LABELS,
  REPORT_LINES,
  type CheckDto,
  type DocumentPurpose,
  type ExpenseDto,
  type ExpenseInput,
  type ReportDetail,
  type ReportReview,
  type ReportStatus,
  type WexPaymentDto,
  type WexPaymentInput,
  DOCUMENT_PURPOSE_LABELS,
  WRITE_ROLES,
} from '@ad/types'
import { ChecksService } from '../checks/checks.service'
import { AccessLogService } from '../core/access-log.service'
import { allow, tenantWhere, workspaceRole, type Caller } from '../core/caller'
import { changesOf, howMany, monthName, type Fields } from '../core/changes'
import { participantDto } from '../engagements/engagements.service'
import { eligibilityItemsOf } from '../engagements/eligibility'
import { documentDto } from '../documents/document.dto'
import { linkDocument, NothingChanged, unlessUnchanged } from '../documents/link'
import type { StagedFile } from '../documents/staged-file'
import { PrismaService } from '../prisma/prisma.service'
import { computeLines } from './report-lines'

const iso = (d: Date) => d.toISOString()
const isoDate = (d: Date) => d.toISOString().slice(0, 10)
const SEVERITY_RANK = { blocker: 0, attention: 1, info: 2 } as const

/**
 * An expense in the access log, labelled as the expense form labels it: amounts, dates, categories and ID-like
 * numbers by value; names and free text by name alone.
 */
const EXPENSE_FIELDS: Fields = {
  itemNumber: { label: 'Item number', show: 'text' },
  date: { label: 'Date', show: 'date' },
  vendor: { label: 'Vendor' },
  memo: { label: 'Memo' },
  account: { label: 'Account (general ledger)', show: 'text' },
  totalCost: { label: 'Total cost', show: 'money' },
  allocatedAmount: { label: 'Amount charged to this program', show: 'money' },
  allocationType: { label: 'Allocation', show: 'text', labels: ALLOCATION_TYPE_LABELS },
  allocationNote: { label: 'Allocation note' },
  reportLine: { label: 'Report line', show: 'text', labels: REPORT_LINE_LABELS },
}

/** A work-experience payment is a participant's pay: every field by name alone. */
const WEX_FIELDS: Fields = {
  participantId: { label: 'Participant' },
  payPeriodStart: { label: 'Pay period start' },
  payPeriodEnd: { label: 'Pay period end' },
  hours: { label: 'Hours' },
  grossAmount: { label: 'Gross pay' },
}

/**
 * A month's report, labelled as the month's page and the funder's decision form label it: its status, dates and
 * the funder's invoice number by value; the people who prepared and authorized it and the funder's words by name
 * alone.
 */
const REPORT_FIELDS: Fields = {
  status: { label: 'Status', show: 'text' },
  submittedAt: { label: 'Submitted on', show: 'date' },
  preparedByName: { label: 'Prepared by' },
  authorizedByName: { label: 'Authorized by' },
  authorizedAt: { label: 'Authorized on', show: 'date' },
  invoiceNumber: { label: 'IV# for payment', show: 'text' },
  review: { label: "Funder's review checklist" },
  deniedReason: { label: 'If denied, why' },
}

/** Item numbers, general-ledger accounts and the funder's invoice number are logged by value, so they stay ID-like. */
const ID_LIKE = /^[A-Za-z0-9#&./ -]{1,40}$/

/** `value`, trimmed, if it is ID-like; a 400 in plain words if not. */
export function idLike(label: string, value: string): string {
  const v = value.trim()
  if (!ID_LIKE.test(v))
    throw new BadRequestException(
      `${label} may use letters, digits, #, &, ., /, - and spaces, from 1 to 40 characters`
    )
  return v
}

const purposeLabel = (p: string) =>
  (DOCUMENT_PURPOSE_LABELS[p as DocumentPurpose] ?? p).toLowerCase()

type ReportRow = NonNullable<Awaited<ReturnType<ReportsService['find']>>>

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly checks: ChecksService,
    private readonly log: AccessLogService
  ) {}

  private find(caller: Caller, id: string) {
    return this.prisma.monthlyReport.findFirst({
      where: { id, ...tenantWhere(caller) },
      include: {
        engagement: {
          include: {
            workspace: true,
            budgetLines: true,
            participants: {
              include: { documents: { include: { document: true } } },
              orderBy: { displayName: 'asc' },
            },
          },
        },
        expenses: {
          include: { documents: { include: { document: true } } },
          orderBy: [{ date: 'asc' }, { itemNumber: 'asc' }],
        },
        wexPayments: {
          include: { participant: true, documents: { include: { document: true } } },
          orderBy: [{ payPeriodStart: 'asc' }, { participant: { displayName: 'asc' } }],
        },
        checks: { where: { status: 'open' }, orderBy: { createdAt: 'asc' } },
      },
    })
  }

  private async load(caller: Caller, id: string): Promise<ReportRow> {
    const r = await this.find(caller, id)
    if (!r) throw new NotFoundException()
    return r
  }

  /** The month's page, as the person opens it: one line names what it lists. */
  async get(caller: Caller, id: string): Promise<ReportDetail> {
    const r = await this.load(caller, id)
    const detail = await this.detail(caller, r)
    await this.log.log(caller, {
      workspaceId: r.workspaceId!,
      resource: 'report',
      subjectId: r.id,
      action: 'read',
      description: `Viewed ${monthName(r.period)} of ${r.engagement.name}: ${howMany(detail.documents.length, 'document')}, ${howMany(detail.participants.length, 'participant')}`,
    })
    return detail
  }

  /**
   * The month's page again, after a change the person just made on it. The open was logged; a change's answer
   * is not another read, so this writes no line.
   */
  private async fresh(caller: Caller, id: string): Promise<ReportDetail> {
    return this.detail(caller, await this.load(caller, id))
  }

  private async detail(caller: Caller, r: ReportRow): Promise<ReportDetail> {
    const earlier = await this.prisma.expense.findMany({
      where: { engagementId: r.engagementId, monthlyReport: { period: { lt: r.period } } },
      select: { reportLine: true, allocatedAmount: true },
    })
    const documents = await this.prisma.document.findMany({
      where: { workspaceId: r.workspaceId! },
      orderBy: { uploadedAt: 'desc' },
      take: 300,
    })
    const c = r.engagement
    const writer = workspaceRole(caller, c.workspaceId, WRITE_ROLES)
    return {
      id: r.id,
      period: r.period,
      status: r.status as ReportStatus,
      dueDate: iso(r.dueDate),
      submittedAt: r.submittedAt ? iso(r.submittedAt) : null,
      preparedByName: r.preparedByName,
      authorizedByName: r.authorizedByName,
      authorizedAt: r.authorizedAt ? iso(r.authorizedAt) : null,
      comments: r.comments,
      review: (r.review as ReportReview | null) ?? null,
      reviewedAt: r.reviewedAt ? iso(r.reviewedAt) : null,
      deniedReason: r.deniedReason,
      isFinal: r.isFinal,
      engagement: {
        id: c.id,
        kind: c.kind as ReportDetail['engagement']['kind'],
        name: c.name,
        number: c.number,
        funder: c.funder,
        periodStart: c.periodStart ? iso(c.periodStart) : null,
        periodEnd: c.periodEnd ? iso(c.periodEnd) : null,
        fundingSources: c.fundingSources,
        fundingOptions: c.workspace.fundingSources,
        reportDueDay: c.reportDueDay,
        awardAmount: c.awardAmount == null ? null : Number(c.awardAmount),
        workspace: { id: c.workspace.id, name: c.workspace.name },
        eligibilityItems: eligibilityItemsOf(c),
        reportTo: c.reportTo,
        preparerName: c.preparerName,
        preparerOrganization: c.preparerOrganization,
        authorizerName: c.authorizerName,
        authorizerOrganization: c.authorizerOrganization,
      },
      lines: computeLines(
        c.budgetLines.map((b) => ({ reportLine: b.reportLine, amount: Number(b.amount) })),
        earlier.map((e) => ({ reportLine: e.reportLine, amount: Number(e.allocatedAmount) })),
        r.expenses.map((e) => ({ reportLine: e.reportLine, amount: Number(e.allocatedAmount) }))
      ),
      expenses: r.expenses.map(expenseDto),
      wexPayments: r.wexPayments.map(wexDto),
      checks: [...r.checks]
        .sort(
          (a, b) =>
            SEVERITY_RANK[a.severity as keyof typeof SEVERITY_RANK] -
            SEVERITY_RANK[b.severity as keyof typeof SEVERITY_RANK]
        )
        .map(checkDto),
      participants: c.participants.map(participantDto),
      documents: documents.map(documentDto),
      can: {
        edit: writer && r.status === 'draft',
        submit: writer && r.status === 'draft',
        review: writer && (r.status === 'submitted' || r.status === 'under-review'),
        reopen: writer && r.status === 'denied',
      },
    }
  }

  // ── Expenses ──────────────────────────────────────────────────────────────

  private async editable(caller: Caller, reportId: string): Promise<ReportRow> {
    const r = await this.load(caller, reportId)
    allow(
      workspaceRole(caller, r.engagement.workspaceId, WRITE_ROLES),
      'Only an owner or bookkeeper edits the ledger'
    )
    if (r.status !== 'draft')
      throw new ConflictException(`The ${r.period} report is ${r.status}; only a draft can change`)
    return r
  }

  private expenseData(input: ExpenseInput) {
    const bad = (m: string) => new BadRequestException(m)
    if (!input.itemNumber?.trim()) throw bad('itemNumber is required')
    const itemNumber = idLike('Item number', input.itemNumber)
    const account = input.account?.trim() ? idLike('Account (general ledger)', input.account) : null
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date ?? '')) throw bad('date must be YYYY-MM-DD')
    if (!input.vendor?.trim()) throw bad('vendor is required')
    const total = Number(input.totalCost)
    const allocated = Number(input.allocatedAmount)
    if (!Number.isFinite(total) || total < 0) throw bad('totalCost must be a positive amount')
    if (!Number.isFinite(allocated) || allocated < 0)
      throw bad('allocatedAmount must be a positive amount')
    if (total >= 1e10 || allocated >= 1e10) throw bad('Amounts must be under $10,000,000,000')
    if (!ALLOCATION_TYPES.includes(input.allocationType))
      throw bad('allocationType is not one of the allowed values')
    if (!REPORT_LINES.includes(input.reportLine))
      throw bad('reportLine is not one of the seven lines')
    return {
      itemNumber,
      date: new Date(`${input.date}T00:00:00Z`),
      vendor: input.vendor.trim(),
      memo: input.memo?.trim() || null,
      account,
      totalCost: total.toFixed(2),
      allocatedAmount: allocated.toFixed(2),
      allocationType: input.allocationType,
      allocationNote: input.allocationNote?.trim() || null,
      reportLine: input.reportLine,
    }
  }

  async addExpense(caller: Caller, reportId: string, input: ExpenseInput): Promise<ReportDetail> {
    const r = await this.editable(caller, reportId)
    const data = this.expenseData(input)
    await this.log.change(
      caller,
      (tx) =>
        tx.expense.create({
          data: {
            engagementId: r.engagementId,
            monthlyReportId: r.id,
            createdById: caller.userId,
            ...data,
          },
        }),
      (e) => ({
        workspaceId: r.workspaceId!,
        resource: 'expense',
        subjectId: e.id,
        action: 'create',
        description: `Added expense ${data.itemNumber} to ${monthName(r.period)}`,
        changes: changesOf(null, data, EXPENSE_FIELDS),
      })
    )
    await this.checks.refresh(r.id)
    return this.fresh(caller, r.id)
  }

  /** Saves an edited expense; a save with nothing edited writes nothing and logs nothing. */
  async updateExpense(
    caller: Caller,
    expenseId: string,
    input: ExpenseInput
  ): Promise<ReportDetail> {
    const existing = await this.prisma.expense.findFirst({
      where: { id: expenseId, ...tenantWhere(caller) },
    })
    if (!existing) throw new NotFoundException()
    const r = await this.editable(caller, existing.monthlyReportId)
    const data = this.expenseData(input)
    await unlessUnchanged(async () => {
      await this.log.change(
        caller,
        async (tx) => {
          const before = await tx.expense.findFirst({ where: { id: expenseId } })
          if (!before) throw new NotFoundException()
          const changes = changesOf(before, data, EXPENSE_FIELDS)
          if (!changes.length) throw new NothingChanged()
          await tx.expense.update({ where: { id: expenseId }, data })
          return { before, changes }
        },
        ({ before, changes }) => ({
          workspaceId: r.workspaceId!,
          resource: 'expense',
          subjectId: expenseId,
          action: 'update',
          description: `Changed expense ${before.itemNumber} in ${monthName(r.period)}`,
          changes,
        })
      )
      await this.checks.refresh(r.id)
    })
    return this.fresh(caller, r.id)
  }

  async deleteExpense(caller: Caller, expenseId: string): Promise<ReportDetail> {
    const existing = await this.prisma.expense.findFirst({
      where: { id: expenseId, ...tenantWhere(caller) },
    })
    if (!existing) throw new NotFoundException()
    const r = await this.editable(caller, existing.monthlyReportId)
    await this.log.change(caller, (tx) => tx.expense.delete({ where: { id: expenseId } }), {
      workspaceId: r.workspaceId!,
      resource: 'expense',
      subjectId: expenseId,
      action: 'delete',
      description: `Removed expense ${existing.itemNumber} from ${monthName(r.period)}`,
      changes: changesOf(existing, null, EXPENSE_FIELDS),
    })
    await this.checks.refresh(r.id)
    return this.fresh(caller, r.id)
  }

  /**
   * Puts a document in one of an expense's proof slots: one the workspace holds (`source` is its id), or a new
   * upload (`source` is the staged file from POST /documents). The same slot again changes nothing; another slot
   * moves it there, and the line says so.
   */
  async attachToExpense(
    caller: Caller,
    expenseId: string,
    purpose: DocumentPurpose,
    source: string | StagedFile
  ): Promise<ReportDetail> {
    if (!DOCUMENT_PURPOSES.includes(purpose))
      throw new BadRequestException('purpose is not one of the allowed values')
    const existing = await this.prisma.expense.findFirst({
      where: { id: expenseId, ...tenantWhere(caller) },
    })
    if (!existing) throw new NotFoundException()
    const r = await this.editable(caller, existing.monthlyReportId)
    const key = (documentId: string) => ({ expenseId_documentId: { expenseId, documentId } })
    await linkDocument(
      this.prisma,
      this.log,
      caller,
      {
        workspaceId: r.workspaceId!,
        engagementId: r.engagementId,
        resource: 'expense',
        subjectId: expenseId,
        subject: `expense ${existing.itemNumber}`,
        purpose,
        words: purposeLabel,
        find: (tx, documentId) =>
          tx.expenseDocument.findFirst({ where: { expenseId, documentId } }),
        create: (tx, documentId) =>
          tx.expenseDocument.create({ data: { expenseId, documentId, purpose } }),
        move: (tx, documentId) =>
          tx.expenseDocument.update({ where: key(documentId), data: { purpose } }),
      },
      source
    )
    await this.checks.refresh(r.id)
    return this.fresh(caller, r.id)
  }

  async detachFromExpense(
    caller: Caller,
    expenseId: string,
    documentId: string
  ): Promise<ReportDetail> {
    const existing = await this.prisma.expense.findFirst({
      where: { id: expenseId, ...tenantWhere(caller) },
    })
    if (!existing) throw new NotFoundException()
    const r = await this.editable(caller, existing.monthlyReportId)
    await unlessUnchanged(async () => {
      await this.log.change(
        caller,
        async (tx) => {
          const link = await tx.expenseDocument.findFirst({ where: { expenseId, documentId } })
          if (!link) throw new NothingChanged()
          await tx.expenseDocument.deleteMany({ where: { expenseId, documentId } })
          return link
        },
        (link) => ({
          workspaceId: r.workspaceId!,
          resource: 'expense',
          subjectId: expenseId,
          action: 'update',
          description: `Detached ${purposeLabel(link.purpose)} from expense ${existing.itemNumber}`,
        })
      )
      await this.checks.refresh(r.id)
    })
    return this.fresh(caller, r.id)
  }

  // ── Work experience payroll ───────────────────────────────────────────────

  async addWexPayment(
    caller: Caller,
    reportId: string,
    input: WexPaymentInput
  ): Promise<ReportDetail> {
    const r = await this.editable(caller, reportId)
    const participant = r.engagement.participants.find((p) => p.id === input.participantId)
    if (!participant)
      throw new BadRequestException('participantId is not a participant of this engagement')
    for (const d of [input.payPeriodStart, input.payPeriodEnd])
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d ?? ''))
        throw new BadRequestException('pay period dates must be YYYY-MM-DD')
    const gross = Number(input.grossAmount)
    if (!Number.isFinite(gross) || gross < 0)
      throw new BadRequestException('grossAmount must be a positive amount')
    if (gross >= 1e10) throw new BadRequestException('grossAmount must be under $10,000,000,000')
    const data = {
      monthlyReportId: r.id,
      participantId: participant.id,
      payPeriodStart: new Date(`${input.payPeriodStart}T00:00:00Z`),
      payPeriodEnd: new Date(`${input.payPeriodEnd}T00:00:00Z`),
      hours: input.hours == null ? null : Number(input.hours).toFixed(2),
      grossAmount: gross.toFixed(2),
    }
    await this.log.change(
      caller,
      (tx) => tx.wexPayment.create({ data }),
      (w) => ({
        workspaceId: r.workspaceId!,
        resource: 'report',
        subjectId: w.id,
        action: 'create',
        description: `Added a work-experience payment to ${monthName(r.period)}`,
        changes: changesOf(null, data, WEX_FIELDS),
      })
    )
    await this.checks.refresh(r.id)
    return this.fresh(caller, r.id)
  }

  /** As `attachToExpense`, for a work-experience payment's proof. */
  async attachToWex(
    caller: Caller,
    wexId: string,
    purpose: DocumentPurpose,
    source: string | StagedFile
  ): Promise<ReportDetail> {
    if (!DOCUMENT_PURPOSES.includes(purpose))
      throw new BadRequestException('purpose is not one of the allowed values')
    const w = await this.prisma.wexPayment.findFirst({
      where: { id: wexId, ...tenantWhere(caller) },
    })
    if (!w) throw new NotFoundException()
    const r = await this.editable(caller, w.monthlyReportId)
    const key = (documentId: string) => ({
      wexPaymentId_documentId: { wexPaymentId: wexId, documentId },
    })
    await linkDocument(
      this.prisma,
      this.log,
      caller,
      {
        workspaceId: r.workspaceId!,
        engagementId: r.engagementId,
        resource: 'report',
        subjectId: wexId,
        subject: `a work-experience payment in ${monthName(r.period)}`,
        purpose,
        words: purposeLabel,
        find: (tx, documentId) =>
          tx.wexPaymentDocument.findFirst({ where: { wexPaymentId: wexId, documentId } }),
        create: (tx, documentId) =>
          tx.wexPaymentDocument.create({ data: { wexPaymentId: wexId, documentId, purpose } }),
        move: (tx, documentId) =>
          tx.wexPaymentDocument.update({ where: key(documentId), data: { purpose } }),
      },
      source
    )
    await this.checks.refresh(r.id)
    return this.fresh(caller, r.id)
  }

  // ── Submission and review ─────────────────────────────────────────────────

  /**
   * Changes the month's own row from `from` statuses, reading the row as it stands inside the transaction so the
   * logged before is the real one.
   */
  private async changeReport(
    caller: Caller,
    r: ReportRow,
    from: string[],
    data: Record<string, unknown>,
    entry: { action: 'submit' | 'review' | 'update'; description: string },
    loggable: (row: Record<string, unknown>) => Record<string, unknown> = (row) => row
  ): Promise<void> {
    await this.log.change(
      caller,
      async (tx) => {
        const before = await tx.monthlyReport.findFirst({ where: { id: r.id } })
        if (!before) throw new NotFoundException()
        if (!from.includes(before.status))
          throw new ConflictException(`The ${r.period} report is ${before.status}`)
        await tx.monthlyReport.update({ where: { id: r.id }, data })
        return before
      },
      (before) => ({
        workspaceId: r.workspaceId!,
        resource: 'report',
        subjectId: r.id,
        ...entry,
        changes: changesOf(loggable(before), loggable(data), REPORT_FIELDS),
      })
    )
  }

  async submit(caller: Caller, reportId: string): Promise<ReportDetail> {
    const r = await this.load(caller, reportId)
    allow(
      workspaceRole(caller, r.engagement.workspaceId, WRITE_ROLES),
      'Only an owner or bookkeeper submits'
    )
    if (r.status !== 'draft')
      throw new ConflictException(`The ${r.period} report is already ${r.status}`)
    await this.checks.refresh(r.id)
    const blockers = await this.prisma.check.findMany({
      where: { monthlyReportId: r.id, status: 'open', severity: 'blocker' },
    })
    if (blockers.length)
      throw new ConflictException({
        message: `${blockers.length} blocking check(s) must be resolved before submitting`,
        blockers: blockers.map(checkDto),
      })
    const isOwner = workspaceRole(caller, r.engagement.workspaceId, ['owner'])
    const data = {
      status: 'submitted',
      submittedAt: new Date(),
      preparedByName: r.preparedByName ?? r.engagement.preparerName ?? caller.displayName,
      authorizedByName: isOwner
        ? (r.engagement.authorizerName ?? caller.displayName)
        : r.authorizedByName,
      authorizedAt: isOwner ? new Date() : r.authorizedAt,
    }
    // As the month's page says it once submitted: "September 2026 submitted to the funder."
    await this.changeReport(caller, r, ['draft'], data, {
      action: 'submit',
      description: `Submitted ${monthName(r.period)} of ${r.engagement.name} to ${r.engagement.funder ?? 'the funder'}`,
    })
    await this.checks.refresh(r.id)
    return this.fresh(caller, r.id)
  }

  async review(
    caller: Caller,
    reportId: string,
    body: { decision: 'approve' | 'deny'; reason?: string; review?: ReportReview }
  ): Promise<ReportDetail> {
    const r = await this.load(caller, reportId)
    // The funder does not sign in: the bookkeeper records its decision from the email or the returned form.
    allow(
      workspaceRole(caller, r.engagement.workspaceId, WRITE_ROLES),
      "Only an owner or bookkeeper records the funder's decision"
    )
    if (r.status !== 'submitted' && r.status !== 'under-review')
      throw new ConflictException(`The ${r.period} report is ${r.status}, not awaiting a decision`)
    if (body.decision !== 'approve' && body.decision !== 'deny')
      throw new BadRequestException('decision must be approve or deny')
    if (body.decision === 'deny' && !body.reason?.trim())
      throw new BadRequestException('A denial needs a reason')
    let review = body.review ? JSON.parse(JSON.stringify(body.review)) : (r.review ?? undefined)
    if (body.review?.invoiceNumber?.trim())
      review = { ...review, invoiceNumber: idLike('IV# for payment', body.review.invoiceNumber) }
    const data = {
      status: body.decision === 'approve' ? 'approved' : 'denied',
      review,
      reviewedById: caller.userId,
      reviewedAt: new Date(),
      deniedReason: body.decision === 'deny' ? body.reason!.trim() : null,
    }
    const invoice = (v: unknown) => (v as ReportReview | null)?.invoiceNumber ?? null
    await this.changeReport(
      caller,
      r,
      ['submitted', 'under-review'],
      data,
      {
        action: 'review',
        description: `Recorded the funder's ${body.decision === 'approve' ? 'approval' : 'denial'} of ${monthName(r.period)} of ${r.engagement.name}`,
      },
      (row) => ({ ...row, invoiceNumber: invoice(row.review) })
    )
    return this.fresh(caller, r.id)
  }

  async reopen(caller: Caller, reportId: string): Promise<ReportDetail> {
    const r = await this.load(caller, reportId)
    allow(
      workspaceRole(caller, r.engagement.workspaceId, WRITE_ROLES),
      'Only an owner or bookkeeper reopens'
    )
    if (r.status !== 'denied') throw new ConflictException('Only a denied report can be reopened')
    await this.changeReport(
      caller,
      r,
      ['denied'],
      { status: 'draft', submittedAt: null },
      {
        action: 'update',
        description: `Reopened ${monthName(r.period)} of ${r.engagement.name} to correct it`,
      }
    )
    await this.checks.refresh(r.id)
    return this.fresh(caller, r.id)
  }
}

export function expenseDto(e: {
  id: string
  itemNumber: string
  date: Date
  vendor: string
  memo: string | null
  account: string | null
  totalCost: unknown
  allocatedAmount: unknown
  allocationType: string
  allocationNote: string | null
  reportLine: string
  documents: { purpose: string; document: Parameters<typeof documentDto>[0] }[]
}): ExpenseDto {
  return {
    id: e.id,
    itemNumber: e.itemNumber,
    date: isoDate(e.date),
    vendor: e.vendor,
    memo: e.memo,
    account: e.account,
    totalCost: Number(e.totalCost),
    allocatedAmount: Number(e.allocatedAmount),
    allocationType: e.allocationType as ExpenseDto['allocationType'],
    allocationNote: e.allocationNote,
    reportLine: e.reportLine as ExpenseDto['reportLine'],
    documents: e.documents.map((d) => ({
      purpose: d.purpose as DocumentPurpose,
      document: documentDto(d.document),
    })),
  }
}

function wexDto(w: {
  id: string
  participantId: string
  participant: { displayName: string; participantId: string }
  payPeriodStart: Date
  payPeriodEnd: Date
  hours: unknown
  grossAmount: unknown
  documents: { purpose: string; document: Parameters<typeof documentDto>[0] }[]
}): WexPaymentDto {
  return {
    id: w.id,
    participantId: w.participantId,
    participantName: w.participant.displayName,
    participantNumber: w.participant.participantId,
    payPeriodStart: isoDate(w.payPeriodStart),
    payPeriodEnd: isoDate(w.payPeriodEnd),
    hours: w.hours == null ? null : Number(w.hours),
    grossAmount: Number(w.grossAmount),
    documents: w.documents.map((d) => ({
      purpose: d.purpose as DocumentPurpose,
      document: documentDto(d.document),
    })),
  }
}

function checkDto(k: {
  id: string
  code: string
  severity: string
  source: string
  message: string
  status: string
  expenseId: string | null
  participantId: string | null
  wexPaymentId: string | null
}): CheckDto {
  return {
    id: k.id,
    code: k.code as CheckDto['code'],
    severity: k.severity as CheckDto['severity'],
    source: k.source as CheckDto['source'],
    message: k.message,
    status: k.status as CheckDto['status'],
    expenseId: k.expenseId,
    participantId: k.participantId,
    wexPaymentId: k.wexPaymentId,
  }
}
