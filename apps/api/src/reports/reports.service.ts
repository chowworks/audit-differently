import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import {
  ALLOCATION_TYPES,
  DOCUMENT_PURPOSES,
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
  WRITE_ROLES,
} from '@ad/types'
import { ChecksService } from '../checks/checks.service'
import { AccessLogService } from '../core/access-log.service'
import { allow, tenantWhere, workspaceRole, type Caller } from '../core/caller'
import { participantDto } from '../engagements/engagements.service'
import { eligibilityItemsOf } from '../engagements/eligibility'
import { documentDto } from '../documents/document.dto'
import { PrismaService } from '../prisma/prisma.service'
import { computeLines } from './report-lines'

const iso = (d: Date) => d.toISOString()
const isoDate = (d: Date) => d.toISOString().slice(0, 10)
const SEVERITY_RANK = { blocker: 0, attention: 1, info: 2 } as const

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

  async get(caller: Caller, id: string): Promise<ReportDetail> {
    const r = await this.load(caller, id)
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
    // The month's page lists the workspace's documents and the engagement's participants: both are logged.
    if (documents.length > 0)
      await this.log
        .log(caller, {
          workspaceId: r.workspaceId!,
          resource: 'document',
          action: 'list',
          detail: `${documents.length} documents, ${r.period} report of ${c.name}`,
        })
        .catch(() => undefined)
    if (c.participants.length > 0)
      await this.log
        .log(caller, {
          workspaceId: r.workspaceId!,
          resource: 'participant',
          action: 'list',
          detail: `${c.participants.length} participants, ${r.period} report of ${c.name}`,
        })
        .catch(() => undefined)
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
      itemNumber: input.itemNumber.trim(),
      date: new Date(`${input.date}T00:00:00Z`),
      vendor: input.vendor.trim(),
      memo: input.memo?.trim() || null,
      account: input.account?.trim() || null,
      totalCost: total.toFixed(2),
      allocatedAmount: allocated.toFixed(2),
      allocationType: input.allocationType,
      allocationNote: input.allocationNote?.trim() || null,
      reportLine: input.reportLine,
    }
  }

  async addExpense(caller: Caller, reportId: string, input: ExpenseInput): Promise<ExpenseDto> {
    const r = await this.editable(caller, reportId)
    const e = await this.prisma.expense.create({
      data: {
        engagementId: r.engagementId,
        monthlyReportId: r.id,
        createdById: caller.userId,
        ...this.expenseData(input),
      },
      include: { documents: { include: { document: true } } },
    })
    await this.checks.refresh(r.id)
    await this.log.log(caller, {
      workspaceId: r.workspaceId!,
      resource: 'expense',
      subjectId: e.id,
      action: 'create',
      detail: e.itemNumber,
    })
    return expenseDto(e)
  }

  async updateExpense(caller: Caller, expenseId: string, input: ExpenseInput): Promise<ExpenseDto> {
    const existing = await this.prisma.expense.findFirst({
      where: { id: expenseId, ...tenantWhere(caller) },
    })
    if (!existing) throw new NotFoundException()
    const r = await this.editable(caller, existing.monthlyReportId)
    const e = await this.prisma.expense.update({
      where: { id: expenseId },
      data: this.expenseData(input),
      include: { documents: { include: { document: true } } },
    })
    await this.checks.refresh(r.id)
    await this.log.log(caller, {
      workspaceId: r.workspaceId!,
      resource: 'expense',
      subjectId: e.id,
      action: 'update',
      detail: e.itemNumber,
    })
    return expenseDto(e)
  }

  async deleteExpense(caller: Caller, expenseId: string): Promise<void> {
    const existing = await this.prisma.expense.findFirst({
      where: { id: expenseId, ...tenantWhere(caller) },
    })
    if (!existing) throw new NotFoundException()
    const r = await this.editable(caller, existing.monthlyReportId)
    await this.prisma.expense.delete({ where: { id: expenseId } })
    await this.checks.refresh(r.id)
    await this.log.log(caller, {
      workspaceId: r.workspaceId!,
      resource: 'expense',
      subjectId: expenseId,
      action: 'delete',
      detail: existing.itemNumber,
    })
  }

  async attachToExpense(
    caller: Caller,
    expenseId: string,
    documentId: string,
    purpose: DocumentPurpose
  ): Promise<void> {
    if (!DOCUMENT_PURPOSES.includes(purpose))
      throw new BadRequestException('purpose is not one of the allowed values')
    const existing = await this.prisma.expense.findFirst({
      where: { id: expenseId, ...tenantWhere(caller) },
    })
    if (!existing) throw new NotFoundException()
    const r = await this.editable(caller, existing.monthlyReportId)
    const doc = await this.prisma.document.findFirst({
      where: { id: documentId, workspaceId: r.workspaceId! },
    })
    if (!doc) throw new NotFoundException('No such document in this workspace')
    await this.prisma.expenseDocument.upsert({
      where: { expenseId_documentId: { expenseId, documentId } },
      update: { purpose },
      create: { expenseId, documentId, purpose },
    })
    await this.checks.refresh(r.id)
    await this.log.log(caller, {
      workspaceId: r.workspaceId!,
      resource: 'expense',
      subjectId: expenseId,
      action: 'update',
      detail: `attached ${purpose}`,
    })
  }

  async detachFromExpense(caller: Caller, expenseId: string, documentId: string): Promise<void> {
    const existing = await this.prisma.expense.findFirst({
      where: { id: expenseId, ...tenantWhere(caller) },
    })
    if (!existing) throw new NotFoundException()
    const r = await this.editable(caller, existing.monthlyReportId)
    await this.prisma.expenseDocument.deleteMany({ where: { expenseId, documentId } })
    await this.checks.refresh(r.id)
  }

  // ── Work experience payroll ───────────────────────────────────────────────

  async addWexPayment(
    caller: Caller,
    reportId: string,
    input: WexPaymentInput
  ): Promise<WexPaymentDto> {
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
    const w = await this.prisma.wexPayment.create({
      data: {
        monthlyReportId: r.id,
        participantId: participant.id,
        payPeriodStart: new Date(`${input.payPeriodStart}T00:00:00Z`),
        payPeriodEnd: new Date(`${input.payPeriodEnd}T00:00:00Z`),
        hours: input.hours == null ? null : Number(input.hours).toFixed(2),
        grossAmount: gross.toFixed(2),
      },
      include: { participant: true, documents: { include: { document: true } } },
    })
    await this.checks.refresh(r.id)
    return wexDto(w)
  }

  async attachToWex(
    caller: Caller,
    wexId: string,
    documentId: string,
    purpose: DocumentPurpose
  ): Promise<void> {
    if (!DOCUMENT_PURPOSES.includes(purpose))
      throw new BadRequestException('purpose is not one of the allowed values')
    const w = await this.prisma.wexPayment.findFirst({
      where: { id: wexId, ...tenantWhere(caller) },
    })
    if (!w) throw new NotFoundException()
    const r = await this.editable(caller, w.monthlyReportId)
    const doc = await this.prisma.document.findFirst({
      where: { id: documentId, workspaceId: r.workspaceId! },
    })
    if (!doc) throw new NotFoundException('No such document in this workspace')
    await this.prisma.wexPaymentDocument.upsert({
      where: { wexPaymentId_documentId: { wexPaymentId: wexId, documentId } },
      update: { purpose },
      create: { wexPaymentId: wexId, documentId, purpose },
    })
    await this.checks.refresh(r.id)
  }

  // ── Submission and review ─────────────────────────────────────────────────

  async submit(caller: Caller, reportId: string): Promise<{ blockers: CheckDto[] }> {
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
    await this.prisma.monthlyReport.update({
      where: { id: r.id },
      data: {
        status: 'submitted',
        submittedAt: new Date(),
        preparedByName: r.preparedByName ?? r.engagement.preparerName ?? caller.displayName,
        authorizedByName: isOwner
          ? (r.engagement.authorizerName ?? caller.displayName)
          : r.authorizedByName,
        authorizedAt: isOwner ? new Date() : r.authorizedAt,
      },
    })
    await this.checks.refresh(r.id)
    await this.log.log(caller, {
      workspaceId: r.workspaceId!,
      resource: 'report',
      subjectId: r.id,
      action: 'submit',
      detail: r.period,
    })
    return { blockers: [] }
  }

  async review(
    caller: Caller,
    reportId: string,
    body: { decision: 'approve' | 'deny'; reason?: string; review?: ReportReview }
  ): Promise<void> {
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
    await this.prisma.monthlyReport.update({
      where: { id: r.id },
      data: {
        status: body.decision === 'approve' ? 'approved' : 'denied',
        review: body.review ? JSON.parse(JSON.stringify(body.review)) : (r.review ?? undefined),
        reviewedById: caller.userId,
        reviewedAt: new Date(),
        deniedReason: body.decision === 'deny' ? body.reason!.trim() : null,
      },
    })
    await this.log.log(caller, {
      workspaceId: r.workspaceId!,
      resource: 'report',
      subjectId: r.id,
      action: 'review',
      detail: `${body.decision} ${r.period}`,
    })
  }

  async reopen(caller: Caller, reportId: string): Promise<void> {
    const r = await this.load(caller, reportId)
    allow(
      workspaceRole(caller, r.engagement.workspaceId, WRITE_ROLES),
      'Only an owner or bookkeeper reopens'
    )
    if (r.status !== 'denied') throw new ConflictException('Only a denied report can be reopened')
    await this.prisma.monthlyReport.update({
      where: { id: r.id },
      data: { status: 'draft', submittedAt: null },
    })
    await this.checks.refresh(r.id)
    await this.log.log(caller, {
      workspaceId: r.workspaceId!,
      resource: 'report',
      subjectId: r.id,
      action: 'update',
      detail: `reopened ${r.period}`,
    })
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
