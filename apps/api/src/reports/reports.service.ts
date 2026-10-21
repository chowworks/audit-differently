import { receiptsEmail } from '../inbound/config'
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
  PAYROLL_DOCUMENT_KINDS,
  PERSONAL_DOCUMENT_ROLES,
  REPORT_LINE_LABELS,
  type CheckDto,
  type DocumentPurpose,
  type ExpenseDto,
  type LoggedChange,
  type ExpenseInput,
  type PayrollBudgetKind,
  type ClosingInput,
  type ReportDetail,
  type ReportStatus,
  type StatementMark,
  type WexPaymentDto,
  type WexPaymentInput,
  DOCUMENT_PURPOSE_LABELS,
  WRITE_ROLES,
} from '@ad/types'
import { Prisma, type MonthlyReport } from '@prisma/client'
import { ChecksService } from '../checks/checks.service'
import { AccessLogService } from '../core/access-log.service'
import { allow, staffName, tenantWhere, workspaceRole, type Caller } from '../core/caller'
import { changesOf, howMany, monthName, type Fields } from '../core/changes'
import { participantDto } from '../engagements/engagements.service'
import { eligibilityItemsOf } from '../engagements/eligibility'
import { documentDto } from '../documents/document.dto'
import { linkDocument, NothingChanged, unlessUnchanged } from '../documents/link'
import type { StagedFile } from '../documents/staged-file'
import { PrismaService } from '../prisma/prisma.service'
import {
  computeBudgetLines,
  computeLines,
  countsOnBudget,
  holdsPayroll,
  participantPaySpend,
  payrollCovers,
} from './report-lines'
import { recordReopening, REOPENED, REPORT_FIELDS } from './back-to-draft'
import { currentSignedCopy } from './reopenings'
import { matchingOf, receiptsInclude, receiptsWhere } from '../receipts/receipt.dto'
import { allTagTypes, cleanTags, tagWords } from '../workspaces/tags'

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

/**
 * The expense fields with its tags, by their words in the workspace's list today ("Funding source: …"), and its budget
 * line by the engagement's name for it.
 */
const expenseFields = (
  w: Parameters<typeof tagWords>[0],
  lines: { id: string; name: string }[]
): Fields => ({
  ...EXPENSE_FIELDS,
  budgetLineId: {
    label: 'Budget line',
    show: 'text',
    labels: Object.fromEntries(lines.map((l) => [l.id, l.name])),
  },
  tags: { label: 'Tags', show: 'text', labels: tagWords(w) },
})

/** A work-experience payment is a participant's pay: every field by name alone. */
export const WEX_FIELDS: Fields = {
  participantId: { label: 'Participant' },
  payPeriodStart: { label: 'Pay period start' },
  payPeriodEnd: { label: 'Pay period end' },
  hours: { label: 'Hours' },
  grossAmount: { label: 'Gross pay' },
  // A payroll item's tags can say something of the participant (an age group, say): by name alone too.
  tags: { label: 'Tags' },
}

/** Item numbers and general-ledger accounts are logged by value, so they stay ID-like. */
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

/**
 * A 409 in plain words unless the month is a draft: closed and submitted months are locked. The database holds the
 * same line for a month's lines and their proof (trigger `month_is_draft`, migration 20261015001100).
 */
export function refuseLocked(r: { status: string; period: string }): void {
  if (r.status === 'closed')
    throw new ConflictException(
      `The month-end closing of ${monthName(r.period)} is approved; send it back to change the month`
    )
  if (r.status !== 'draft')
    throw new ConflictException(`The ${r.period} report is ${r.status}; only a draft can change`)
}

export type ReportRow = NonNullable<Awaited<ReturnType<ReportsService['find']>>>

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
        reopenings: { orderBy: { reopenedAt: 'desc' } },
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
  async fresh(caller: Caller, id: string): Promise<ReportDetail> {
    return this.detail(caller, await this.load(caller, id))
  }

  private async detail(caller: Caller, r: ReportRow): Promise<ReportDetail> {
    const [spentBefore, wexBefore] = await Promise.all([
      this.prisma.expense.findMany({
        where: { engagementId: r.engagementId, monthlyReport: { period: { lt: r.period } } },
        select: {
          reportLine: true,
          budgetLineId: true,
          allocatedAmount: true,
          monthlyReportId: true,
          payrollKey: true,
          payrollKind: true,
          account: true,
          memo: true,
        },
      }),
      this.prisma.wexPayment.groupBy({
        by: ['monthlyReportId'],
        where: { monthlyReport: { engagementId: r.engagementId, period: { lt: r.period } } },
        _sum: { grossAmount: true },
        _count: { _all: true },
      }),
    ])
    // A books' payroll transaction stops counting once the match covers its kind of payroll on its month; the
    // participants' pay counts on the line that holds it, this month's and the earlier months'.
    const covers = payrollCovers(
      [...spentBefore, ...r.expenses.map((e) => ({ ...e, monthlyReportId: r.id }))],
      new Map([
        ...wexBefore.map((g) => [g.monthlyReportId, g._count._all] as const),
        [r.id, r.wexPayments.length] as const,
      ]),
      () => holdsPayroll(r.engagement.budgetLines, 'participant-pay')
    )
    const earlier = [
      ...spentBefore.filter((e) => countsOnBudget(e, covers.get(e.monthlyReportId))),
      ...participantPaySpend(
        r.engagement.budgetLines,
        wexBefore.reduce((t, g) => t + Number(g._sum.grossAmount ?? 0), 0)
      ),
    ]
    const spentNow = [
      ...r.expenses.filter((e) => countsOnBudget(e, covers.get(r.id))),
      ...participantPaySpend(
        r.engagement.budgetLines,
        r.wexPayments.reduce((t, w) => t + Number(w.grossAmount), 0)
      ),
    ]
    const lineNames = new Map(r.engagement.budgetLines.map((b) => [b.id, b.name]))
    const documents = await this.prisma.document.findMany({
      where: { workspaceId: r.workspaceId! },
      orderBy: { uploadedAt: 'desc' },
      take: 300,
    })
    const receipts = await this.prisma.document.findMany({
      where: receiptsWhere(r.engagementId, r.period),
      include: receiptsInclude,
      orderBy: { uploadedAt: 'asc' },
    })
    const payroll = await this.prisma.document.findMany({
      where: {
        period: r.period,
        kind: { in: [...PAYROLL_DOCUMENT_KINDS] },
        OR: [
          { engagementId: r.engagementId },
          // A workspace payroll file (the workspace payroll match, migration 20261017000500) that proves this month's
          // items: shown with the month's own, as if it had been matched here.
          {
            workspaceId: r.workspaceId!,
            engagementId: null,
            OR: [
              { expenses: { some: { expense: { monthlyReportId: r.id } } } },
              { wexPayments: { some: { wexPayment: { monthlyReportId: r.id } } } },
            ],
          },
        ],
      },
      orderBy: { uploadedAt: 'asc' },
    })
    // The month's signed copies: the one that counts (uploaded after its latest reopening), and each one submitted
    // before a reopening, kept as history.
    const signedCopies = await this.prisma.document.findMany({
      where: { engagementId: r.engagementId, period: r.period, kind: 'signed-report' },
    })
    const signed = currentSignedCopy(signedCopies, r.period, r.reopenings[0]?.reopenedAt)
    const c = r.engagement
    const writer = workspaceRole(caller, c.workspaceId, WRITE_ROLES)
    const empty = isEmptyMonth(r, await this.prisma.document.count({ where: monthFiles(r) }))
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
      closingNote: r.closingNote,
      sentBackReason: r.sentBackReason,
      sentBackAt: r.sentBackAt ? iso(r.sentBackAt) : null,
      sentBackBy: r.sentBackByEmail,
      editsRequestedAt: r.editsRequestedAt ? iso(r.editsRequestedAt) : null,
      editsRequestedBy: r.editsRequestedByEmail,
      editsRequestComment: r.editsRequestComment,
      reopenings: r.reopenings.map((o) => {
        const d = signedCopies.find((x) => x.id === o.signedDocumentId)
        return {
          id: o.id,
          reopenedAt: iso(o.reopenedAt),
          reopenedBy: o.reopenedByEmail,
          reason: o.reason,
          submittedAt: iso(o.submittedAt),
          approvedByName: o.approvedByName,
          approvedAt: o.approvedAt ? iso(o.approvedAt) : null,
          signedDocument: d ? documentDto(d) : null,
        }
      }),
      signedCopy: signed ? documentDto(signed) : null,
      isFinal: r.isFinal,
      engagement: {
        id: c.id,
        kind: c.kind as ReportDetail['engagement']['kind'],
        name: c.name,
        number: c.number,
        code: c.code,
        funder: c.funder,
        periodStart: c.periodStart ? iso(c.periodStart) : null,
        periodEnd: c.periodEnd ? iso(c.periodEnd) : null,
        tags: c.tags,
        reportDueDay: c.reportDueDay,
        awardAmount: c.awardAmount == null ? null : Number(c.awardAmount),
        workspace: {
          id: c.workspace.id,
          name: c.workspace.name,
          featuredDemo: c.workspace.featuredDemo,
          bookkeepersSeeStaffPayroll: c.workspace.bookkeepersSeeStaffPayroll,
        },
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
        spentNow.map((e) => ({ reportLine: e.reportLine, amount: Number(e.allocatedAmount) }))
      ),
      budgetLines: computeBudgetLines(
        [...r.engagement.budgetLines].sort((a, b) => a.sortOrder - b.sortOrder),
        earlier,
        spentNow
      ),
      expenses: r.expenses.map((e) =>
        expenseDto(e, lineNames, countsOnBudget(e, covers.get(r.id)))
      ),
      wexPayments: r.wexPayments.map(wexDto),
      checks: [...r.checks]
        .sort(
          (a, b) =>
            SEVERITY_RANK[a.severity as keyof typeof SEVERITY_RANK] -
            SEVERITY_RANK[b.severity as keyof typeof SEVERITY_RANK]
        )
        .map(checkDto),
      participants: c.participants.map(participantDto),
      tagTypes: allTagTypes(c.workspace),
      documents: documents.map(documentDto),
      matching: {
        ...matchingOf(
          receipts.filter((d) => d.engagementId === r.engagementId && d.period === r.period),
          r.expenses
        ),
        receiptsEmail: receiptsEmail(c.workspace.receiptsAddress),
      },
      payrollDocuments: payroll
        .filter(
          (d) =>
            (d.engagementId === r.engagementId || d.engagementId === null) &&
            d.period === r.period &&
            (PAYROLL_DOCUMENT_KINDS as readonly string[]).includes(d.kind)
        )
        .map(documentDto),
      can: {
        edit: writer && r.status === 'draft',
        close: writer && r.status === 'draft',
        sendBack: writer && r.status === 'closed',
        requestEdits: writer && (r.status === 'draft' || r.status === 'closed'),
        submit: writer && r.status === 'closed',
        reopen: writer && r.status === 'submitted',
        attachSigned: writer && !signed,
        readPersonal: workspaceRole(caller, c.workspaceId, [...PERSONAL_DOCUMENT_ROLES]),
        deleteMonth: empty && workspaceRole(caller, c.workspaceId, ['owner']),
        // "Bookkeepers see staff payroll" off: the page shows a bookkeeper the payroll proofs as labels, not links to the
        // files. The screen only: the same data is answered.
        seeStaffPayroll:
          c.workspace.bookkeepersSeeStaffPayroll !== false ||
          !workspaceRole(caller, c.workspaceId, ['bookkeeper']),
      },
    }
  }

  // ── Expenses ──────────────────────────────────────────────────────────────

  /** The month, for a change to its ledger: an owner or bookkeeper, and a draft (closed and submitted months are locked). */
  async editable(caller: Caller, reportId: string): Promise<ReportRow> {
    const r = await this.load(caller, reportId)
    allow(
      workspaceRole(caller, r.engagement.workspaceId, WRITE_ROLES),
      'Only an owner or bookkeeper edits the ledger'
    )
    refuseLocked(r)
    return r
  }

  /**
   * An expense's columns, validated. Its tags are checked against the workspace's list; an edit that does not send
   * them leaves them as they are, and keeps any it had whose value has since left the list.
   */
  private expenseData(input: ExpenseInput, r: ReportRow, had?: string[]) {
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
    // Every expense is spent against one of its engagement's budget lines, and reports on that line's form line.
    const line = r.engagement.budgetLines.find((b) => b.id === input.budgetLineId)
    if (!line)
      throw bad("Choose the budget line it is spent against (the engagement's approved budget)")
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
      budgetLineId: line.id,
      reportLine: line.reportLine,
      ...(had && input.tags === undefined
        ? {}
        : { tags: cleanTags(input.tags, r.engagement.workspace, 'expense', had) }),
    }
  }

  async addExpense(caller: Caller, reportId: string, input: ExpenseInput): Promise<ReportDetail> {
    const r = await this.editable(caller, reportId)
    const data = this.expenseData(input, r)
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
        changes: changesOf(
          null,
          data,
          expenseFields(r.engagement.workspace, r.engagement.budgetLines)
        ),
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
    const data = this.expenseData(input, r, existing.tags)
    await unlessUnchanged(async () => {
      await this.log.change(
        caller,
        async (tx) => {
          const before = await tx.expense.findFirst({ where: { id: expenseId } })
          if (!before) throw new NotFoundException()
          const changes = changesOf(
            before,
            data,
            expenseFields(r.engagement.workspace, r.engagement.budgetLines)
          )
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
      changes: changesOf(
        existing,
        null,
        expenseFields(r.engagement.workspace, r.engagement.budgetLines)
      ),
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
          tx.expenseDocument.update({
            where: key(documentId),
            data: { purpose, mark: Prisma.DbNull, marks: [] },
          }),
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

  /** A work-experience payment as typed, checked: a participant of this engagement, a pay period, hours, gross pay. */
  private wexData(r: ReportRow, input: WexPaymentInput, current: string[] = []) {
    const participant = r.engagement.participants.find((p) => p.id === input?.participantId)
    if (!participant)
      throw new BadRequestException('participantId is not a participant of this engagement')
    const [start, end] = [input.payPeriodStart, input.payPeriodEnd].map((d) => {
      const at = /^\d{4}-\d{2}-\d{2}$/.test(d ?? '') ? new Date(`${d}T00:00:00Z`) : null
      if (!at || Number.isNaN(at.getTime()) || isoDate(at) !== d)
        throw new BadRequestException('pay period dates must be YYYY-MM-DD')
      return at
    })
    if (start! > end!)
      throw new BadRequestException('The pay period must start on or before the day it ends')
    const hours = input.hours == null ? null : Number(input.hours)
    if (hours !== null && (!Number.isFinite(hours) || hours < 0 || hours >= 1e6))
      throw new BadRequestException('hours must be a number of hours, 0 or more')
    const gross = Number(input.grossAmount)
    if (!Number.isFinite(gross) || gross <= 0)
      throw new BadRequestException('grossAmount must be more than $0')
    if (gross >= 1e10) throw new BadRequestException('grossAmount must be under $10,000,000,000')
    return {
      participantId: participant.id,
      payPeriodStart: start!,
      payPeriodEnd: end!,
      hours: hours === null ? null : hours.toFixed(2),
      grossAmount: gross.toFixed(2),
      tags: cleanTags(input.tags, r.engagement.workspace, 'payroll', current),
    }
  }

  async addWexPayment(
    caller: Caller,
    reportId: string,
    input: WexPaymentInput
  ): Promise<ReportDetail> {
    const r = await this.editable(caller, reportId)
    const data = { monthlyReportId: r.id, ...this.wexData(r, input) }
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

  /** Changes a work-experience payment: who, the pay period, hours, gross pay and tags. The month must be a draft. */
  async updateWexPayment(
    caller: Caller,
    wexId: string,
    input: WexPaymentInput
  ): Promise<ReportDetail> {
    const existing = await this.prisma.wexPayment.findFirst({
      where: { id: wexId, ...tenantWhere(caller) },
    })
    if (!existing) throw new NotFoundException()
    const r = await this.editable(caller, existing.monthlyReportId)
    const data = this.wexData(r, input, existing.tags)
    await unlessUnchanged(async () => {
      await this.log.change(
        caller,
        async (tx) => {
          const before = await tx.wexPayment.findFirst({ where: { id: wexId } })
          if (!before) throw new NotFoundException()
          const changes = changesOf(before, data, WEX_FIELDS)
          if (!changes.length) throw new NothingChanged()
          await tx.wexPayment.update({ where: { id: wexId }, data })
          // Its proof was matched, and highlighted, for the person it named: for someone else it is matched again.
          const unlinked =
            before.participantId === data.participantId
              ? 0
              : (await tx.wexPaymentDocument.deleteMany({ where: { wexPaymentId: wexId } })).count
          return { changes, unlinked }
        },
        ({ changes, unlinked }) => ({
          workspaceId: r.workspaceId!,
          resource: 'report',
          subjectId: wexId,
          action: 'update',
          description: `Changed a work-experience payment in ${monthName(r.period)}${unlinked ? `; detached its ${howMany(unlinked, 'proof')}, to be matched again for the participant now named` : ''}`,
          changes,
        })
      )
      await this.checks.refresh(r.id)
    })
    return this.fresh(caller, r.id)
  }

  /**
   * Removes a work-experience payment from its month, with its links to proof; the documents themselves stay filed
   * under the month. The month must be a draft.
   */
  async deleteWexPayment(caller: Caller, wexId: string): Promise<ReportDetail> {
    const existing = await this.prisma.wexPayment.findFirst({
      where: { id: wexId, ...tenantWhere(caller) },
    })
    if (!existing) throw new NotFoundException()
    const r = await this.editable(caller, existing.monthlyReportId)
    await this.log.change(
      caller,
      async (tx) => {
        await lockDraft(tx, r.id)
        return tx.wexPayment.delete({ where: { id: wexId } })
      },
      {
        workspaceId: r.workspaceId!,
        resource: 'report',
        subjectId: wexId,
        action: 'delete',
        description: `Removed a work-experience payment from ${monthName(r.period)}`,
        changes: changesOf(existing, null, WEX_FIELDS),
      }
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
          tx.wexPaymentDocument.update({
            where: key(documentId),
            data: { purpose, mark: Prisma.DbNull, marks: [] },
          }),
      },
      source
    )
    await this.checks.refresh(r.id)
    return this.fresh(caller, r.id)
  }

  // ── Month-end closing and submission ──────────────────────────────────────

  /**
   * Changes the month's own row from `from` statuses, reading the row as it stands inside the transaction so the
   * logged before is the real one.
   */
  private async changeReport(
    caller: Caller,
    r: ReportRow,
    from: string[],
    data: Record<string, unknown>,
    entry: { action: 'submit' | 'review'; description: string },
    also?: {
      /** Another write in the same transaction, given the month's row as it stood before. */
      write: (tx: Prisma.TransactionClient, before: MonthlyReport) => Promise<unknown>
      /** The fields it touched, for the line (by name alone). */
      changes: LoggedChange[]
    }
  ): Promise<void> {
    await this.log.change(
      caller,
      (tx) => changeMonthRow(tx, r, from, data, also),
      (before) => reportLine(r, before, data, entry, also)
    )
  }

  /**
   * The same change as `changeReport`, written on a transaction the caller already holds, with its line on it: for a
   * save that reopens months on the way (the workspace payroll match, GitHub issue #22), so a failure later in that
   * save leaves every month as it was.
   */
  private async changeReportIn(
    tx: Prisma.TransactionClient,
    caller: Caller,
    r: ReportRow,
    from: string[],
    data: Record<string, unknown>,
    entry: { action: 'submit' | 'review'; description: string },
    also?: Parameters<typeof changeMonthRow>[4]
  ): Promise<void> {
    const before = await changeMonthRow(tx, r, from, data, also)
    await this.log.also(tx, caller, reportLine(r, before, data, entry, also))
  }

  /** Refreshes the month's checks and refuses, in plain words, while a blocking one is open. */
  private async refuseBlockers(r: ReportRow, before: string): Promise<void> {
    await this.checks.refresh(r.id)
    const blockers = await this.prisma.check.findMany({
      where: { monthlyReportId: r.id, status: 'open', severity: 'blocker' },
    })
    if (blockers.length)
      throw new ConflictException({
        message: `${blockers.length} blocking check(s) must be resolved before ${before}`,
        blockers: blockers.map(checkDto),
      })
  }

  /**
   * Records the month-end closing as approved: the company's own sign-off on the month, often given offline by
   * someone who is not a user, before the report goes to the funder. The ledger is locked from here.
   */
  async approveClosing(
    caller: Caller,
    reportId: string,
    input: ClosingInput
  ): Promise<ReportDetail> {
    const r = await this.load(caller, reportId)
    allow(
      workspaceRole(caller, r.engagement.workspaceId, WRITE_ROLES),
      'Only an owner or bookkeeper records the month-end closing'
    )
    if (r.status !== 'draft')
      throw new ConflictException(`The ${r.period} report is ${r.status}, not a draft`)
    const approvedBy = input?.approvedBy?.trim()
    if (!approvedBy) throw new BadRequestException('Say who approved the month-end closing')
    if (approvedBy.length > 120)
      throw new BadRequestException("The approver's name must be at most 120 characters")
    const on = /^\d{4}-\d{2}-\d{2}$/.test(input?.approvedOn ?? '')
      ? new Date(`${input.approvedOn}T00:00:00Z`)
      : null
    if (!on || Number.isNaN(on.getTime()) || isoDate(on) !== input.approvedOn)
      throw new BadRequestException('approvedOn must be a date, YYYY-MM-DD')
    if (on > new Date()) throw new BadRequestException('The approval date cannot be in the future')
    const note = input?.note?.trim() || null
    if (note && note.length > 2000)
      throw new BadRequestException('The note must be at most 2,000 characters')
    await this.refuseBlockers(r, 'approving the month-end closing')
    await this.changeReport(
      caller,
      r,
      ['draft'],
      {
        status: 'closed',
        authorizedByName: approvedBy,
        authorizedAt: on,
        closingNote: note,
        sentBackReason: null,
        sentBackAt: null,
        sentBackByEmail: null,
        editsRequestedAt: null,
        editsRequestedByEmail: null,
        editsRequestComment: null,
      },
      {
        action: 'review',
        description: `Approved the month-end closing of ${monthName(r.period)} for ${r.engagement.name}`,
      }
    )
    return this.fresh(caller, r.id)
  }

  /** Records the month-end closing as sent back, with the reason: the month is a draft again, to be corrected. */
  async sendBack(caller: Caller, reportId: string, reason: string): Promise<ReportDetail> {
    const { r, data, entry } = await this.sendingBack(caller, reportId, reason)
    await this.changeReport(caller, r, ['closed'], data, entry)
    await this.checks.refresh(r.id)
    return this.fresh(caller, r.id)
  }

  /**
   * `sendBack`, checked now and written later on the caller's transaction (the workspace payroll match's save):
   * the same refusals, the same row and the same line. The caller refreshes the month's checks after its commit.
   */
  async sendBackWith(
    caller: Caller,
    reportId: string,
    reason: string
  ): Promise<(tx: Prisma.TransactionClient) => Promise<void>> {
    const { r, data, entry } = await this.sendingBack(caller, reportId, reason)
    return (tx) => this.changeReportIn(tx, caller, r, ['closed'], data, entry)
  }

  private async sendingBack(caller: Caller, reportId: string, reason: string) {
    const r = await this.load(caller, reportId)
    allow(
      workspaceRole(caller, r.engagement.workspaceId, WRITE_ROLES),
      'Only an owner or bookkeeper records the month-end closing'
    )
    if (r.status !== 'closed')
      throw new ConflictException(
        `Only a month whose closing is approved can be sent back; ${monthName(r.period)} is ${r.status}`
      )
    const why = reason?.trim()
    if (!why) throw new BadRequestException('Say why the month-end closing was sent back')
    if (why.length > 2000)
      throw new BadRequestException('The reason must be at most 2,000 characters')
    const data = {
      status: 'draft',
      authorizedByName: null,
      authorizedAt: null,
      closingNote: null,
      sentBackReason: why,
      sentBackAt: new Date(),
      sentBackByEmail: staffName(caller),
    }
    const entry = {
      action: 'review' as const,
      description: `Sent back the month-end closing of ${monthName(r.period)} for ${r.engagement.name}`,
    }
    return { r, data, entry }
  }

  /**
   * Asks for edits, with a comment: on a draft, records who asked, when and why, the status unchanged; on a month
   * whose closing is approved, sends the closing back (sendBack) with the comment as the reason.
   */
  async requestEdits(caller: Caller, reportId: string, comment: unknown): Promise<ReportDetail> {
    const r = await this.load(caller, reportId)
    allow(
      workspaceRole(caller, r.engagement.workspaceId, WRITE_ROLES),
      'Only an owner or bookkeeper asks for edits'
    )
    const why = typeof comment === 'string' ? comment.trim() : ''
    if (!why) throw new BadRequestException('Say what needs editing')
    if (why.length > 500)
      throw new BadRequestException('The comment must be at most 500 characters')
    if (r.status === 'closed') return this.sendBack(caller, reportId, why)
    if (r.status !== 'draft')
      throw new ConflictException(
        `Edits are asked for on a draft or a closed month; ${monthName(r.period)} is ${r.status}`
      )
    await this.changeReport(
      caller,
      r,
      ['draft'],
      {
        editsRequestedAt: new Date(),
        editsRequestedByEmail: staffName(caller),
        editsRequestComment: why,
      },
      {
        action: 'review',
        description: `Asked for edits on ${monthName(r.period)} of ${r.engagement.name}`,
      }
    )
    return this.fresh(caller, r.id)
  }

  /**
   * Reopens a submitted month to correct it (a typo, say), with the reason: a draft again, without its submission or
   * its closing approval, so it is closed and submitted again. What it undid is kept for good in a ReportReopening
   * row, written in the same transaction: the submission's date, the closing's approval and the signed copy that was
   * submitted (never replaced or removed after this). Every document stays; the corrected signed copy is attached
   * beside it.
   */
  /**
   * Deletes a month with nothing in it: a draft with no expenses, no payroll, no file filed under it and no history of
   * a submission. There is nothing to submit for it, so it goes rather than sit as a report. Owners only, as every
   * deletion; logged. Anything in the month refuses it: remove that first.
   */
  async deleteEmptyMonth(caller: Caller, reportId: string): Promise<{ engagementId: string }> {
    const r = await this.load(caller, reportId)
    allow(
      workspaceRole(caller, r.engagement.workspaceId, ['owner']),
      'Only an owner deletes a month'
    )
    const notEmpty = () =>
      new ConflictException(
        `${monthName(r.period)} is not empty: only a draft month with no expenses, payroll or files can be deleted`
      )
    const files = await this.prisma.document.count({ where: monthFiles(r) })
    if (!isEmptyMonth(r, files)) throw notEmpty()
    await this.log.change(
      caller,
      async (tx) => {
        // Checked again on the month as it stands, locked: a closing, an expense or a payment written meanwhile
        // waits for this delete (and then finds no month), or was written first and is counted here.
        const [month] = await tx.$queryRaw<{ status: string }[]>`
          SELECT "status" FROM "MonthlyReport" WHERE "id" = ${r.id} FOR UPDATE`
        if (!month) throw new NotFoundException()
        const left =
          (await tx.expense.count({ where: { monthlyReportId: r.id } })) +
          (await tx.wexPayment.count({ where: { monthlyReportId: r.id } })) +
          (await tx.reportReopening.count({ where: { monthlyReportId: r.id } })) +
          (await tx.document.count({ where: monthFiles(r) }))
        if (month.status !== 'draft' || left) throw notEmpty()
        // An unsaved payroll match holds staged files the delete would leave in storage: it is saved or discarded
        // first, or goes by itself after RUN_HOURS (payroll-match.sweeper.ts).
        if (await tx.payrollMatchRun.count({ where: { monthlyReportId: r.id } }))
          throw new ConflictException(
            `Payroll is being matched for ${monthName(r.period)}: save or discard that match first (an unsaved one goes by itself after a day)`
          )
        return tx.monthlyReport.delete({ where: { id: r.id } })
      },
      {
        workspaceId: r.workspaceId!,
        resource: 'report',
        subjectId: r.id,
        action: 'delete',
        description: `Deleted ${monthName(r.period)}, a month with nothing to submit`,
      }
    )
    return { engagementId: r.engagementId }
  }

  async reopen(caller: Caller, reportId: string, reason: string): Promise<ReportDetail> {
    const { r, entry, also } = await this.reopening(caller, reportId, reason)
    await this.changeReport(caller, r, ['submitted'], REOPENED, entry, also)
    await this.checks.refresh(r.id)
    return this.fresh(caller, r.id)
  }

  /**
   * `reopen`, checked now and written later on the caller's transaction (the workspace payroll match's save): the
   * same refusals, the same ReportReopening row and the same line. The caller refreshes the month's checks after its
   * commit.
   */
  async reopenWith(
    caller: Caller,
    reportId: string,
    reason: string
  ): Promise<(tx: Prisma.TransactionClient) => Promise<void>> {
    const { r, entry, also } = await this.reopening(caller, reportId, reason)
    return (tx) => this.changeReportIn(tx, caller, r, ['submitted'], REOPENED, entry, also)
  }

  private async reopening(caller: Caller, reportId: string, reason: string) {
    const r = await this.load(caller, reportId)
    allow(
      workspaceRole(caller, r.engagement.workspaceId, WRITE_ROLES),
      'Only an owner or bookkeeper reopens a month'
    )
    if (r.status !== 'submitted')
      throw new ConflictException(
        `Only a submitted month can be reopened; ${monthName(r.period)} is ${r.status}`
      )
    const why = typeof reason === 'string' ? reason.trim() : ''
    if (!why) throw new BadRequestException('Say why the month is reopened')
    if (why.length > 500) throw new BadRequestException('The reason must be at most 500 characters')
    const entry = {
      action: 'review' as const,
      description: `Reopened ${monthName(r.period)} of ${r.engagement.name} to correct it`,
    }
    const also = {
      write: (tx: Prisma.TransactionClient, before: MonthlyReport) =>
        recordReopening(tx, before, caller, why),
      // The reason and the approver are on the month's page; the line names the fields alone.
      changes: [{ field: 'Why it was reopened' }],
    }
    return { r, entry, also }
  }

  /** Submits the month to the funder; its month-end closing must be approved first. */
  async submit(caller: Caller, reportId: string): Promise<ReportDetail> {
    const r = await this.load(caller, reportId)
    allow(
      workspaceRole(caller, r.engagement.workspaceId, WRITE_ROLES),
      'Only an owner or bookkeeper submits'
    )
    if (r.status === 'draft')
      throw new ConflictException(
        `Approve the month-end closing of ${monthName(r.period)} before submitting it`
      )
    if (r.status !== 'closed')
      throw new ConflictException(`The ${r.period} report is already ${r.status}`)
    await this.refuseBlockers(r, 'submitting')
    const data = {
      status: 'submitted',
      submittedAt: new Date(),
      preparedByName: r.preparedByName ?? r.engagement.preparerName ?? caller.displayName,
    }
    // As the month's page says it once submitted: "September 2026 submitted to the funder."
    await this.changeReport(caller, r, ['closed'], data, {
      action: 'submit',
      description: `Submitted ${monthName(r.period)} of ${r.engagement.name} to ${r.engagement.funder ?? 'the funder'}`,
    })
    await this.checks.refresh(r.id)
    return this.fresh(caller, r.id)
  }
}

/**
 * The month's own row changed from `from` statuses, read as it stands inside the transaction so the logged before is
 * the real one, with any other write the change carries. Answers the row as it was.
 */
async function changeMonthRow(
  tx: Prisma.TransactionClient,
  r: ReportRow,
  from: string[],
  data: Record<string, unknown>,
  also?: {
    /** Another write in the same transaction, given the month's row as it stood before. */
    write: (tx: Prisma.TransactionClient, before: MonthlyReport) => Promise<unknown>
    /** The fields it touched, for the line (by name alone). */
    changes: LoggedChange[]
  }
): Promise<MonthlyReport> {
  const before = await tx.monthlyReport.findFirst({ where: { id: r.id } })
  if (!before) throw new NotFoundException()
  if (!from.includes(before.status))
    throw new ConflictException(`The ${r.period} report is ${before.status}`)
  if (also) await also.write(tx, before)
  await tx.monthlyReport.update({ where: { id: r.id }, data })
  return before
}

/** The line of a change to the month's own row. */
function reportLine(
  r: ReportRow,
  before: MonthlyReport,
  data: Record<string, unknown>,
  entry: { action: 'submit' | 'review'; description: string },
  also?: { changes: LoggedChange[] }
) {
  return {
    workspaceId: r.workspaceId!,
    resource: 'report' as const,
    subjectId: r.id,
    ...entry,
    changes: [...changesOf(before, data, REPORT_FIELDS), ...(also?.changes ?? [])],
  }
}

export function expenseDto(
  e: {
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
    budgetLineId: string | null
    tags: string[]
    payrollKey?: string | null
    payrollKind?: string | null
    documents: {
      purpose: string
      mark?: unknown
      marks?: unknown
      document: Parameters<typeof documentDto>[0]
    }[]
  },
  /** The engagement's budget line names, by id. */
  lineNames: Map<string, string>,
  /** Whether it counts on the budget now (a books' payroll transaction stops once the match covers it). */
  counts = true
): ExpenseDto {
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
    budgetLineId: e.budgetLineId,
    budgetLineName: (e.budgetLineId && lineNames.get(e.budgetLineId)) ?? null,
    tags: e.tags,
    fromPayroll: !!e.payrollKey,
    payrollKind: (e.payrollKind as PayrollBudgetKind | null) ?? null,
    counts,
    documents: e.documents.map((d) => ({
      purpose: d.purpose as DocumentPurpose,
      document: documentDto(d.document),
      mark: (d.mark as StatementMark | null | undefined) ?? null,
      marks: Array.isArray(d.marks) ? (d.marks as StatementMark[]) : [],
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
  tags: string[]
  documents: {
    purpose: string
    mark?: unknown
    marks?: unknown
    document: Parameters<typeof documentDto>[0]
  }[]
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
    tags: w.tags,
    documents: w.documents.map((d) => ({
      purpose: d.purpose as DocumentPurpose,
      document: documentDto(d.document),
      mark: (d.mark as StatementMark | null | undefined) ?? null,
      marks: Array.isArray(d.marks) ? (d.marks as StatementMark[]) : [],
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

/**
 * Inside a change's transaction: the month as it stands, share-locked until the change commits, so a closing approved
 * meanwhile waits for it, and one approved first refuses it. The database's own month lock (migration
 * 20261015001100) checks additions and changes only, so a removal is checked here.
 */
async function lockDraft(tx: Prisma.TransactionClient, reportId: string): Promise<void> {
  const [month] = await tx.$queryRaw<{ status: string; period: string }[]>`
    SELECT "status", "period" FROM "MonthlyReport" WHERE "id" = ${reportId} FOR SHARE`
  if (!month) throw new NotFoundException()
  refuseLocked(month)
}

/** The files filed under a month: anything here keeps the month from being deleted. */
const monthFiles = (r: { engagementId: string; period: string }) => ({
  engagementId: r.engagementId,
  period: r.period,
})

/** A draft month with no expenses, no payroll, no file and no submission behind it: nothing to submit. */
function isEmptyMonth(
  r: { status: string; expenses: unknown[]; wexPayments: unknown[]; reopenings: unknown[] },
  files: number
): boolean {
  return (
    r.status === 'draft' &&
    !r.expenses.length &&
    !r.wexPayments.length &&
    !r.reopenings.length &&
    files === 0
  )
}
