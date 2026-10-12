import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import {
  DOCUMENT_KINDS,
  ENGAGEMENT_KINDS,
  WRITE_ROLES,
  type BudgetCategory,
  type DocumentKind,
  type EngagementDetail,
  type EngagementInput,
  type EngagementKind,
  type EngagementStatus,
  type EngagementSummary,
  type ParticipantDto,
  type ReportLine,
  type ReportStatus,
  type ReportSummary,
} from '@ad/types'
import { Prisma } from '@prisma/client'
import { ChecksService } from '../checks/checks.service'
import { dueDate } from '../checks/rules'
import { AccessLogService } from '../core/access-log.service'
import { allow, tenantWhere, workspaceRole, type Caller } from '../core/caller'
import { documentDto } from '../documents/document.dto'
import { PrismaService } from '../prisma/prisma.service'
import { cleanEligibilityItems, eligibilityItemsOf } from './eligibility'

const iso = (d: Date) => d.toISOString()
const DAY = /^\d{4}-\d{2}-\d{2}$/

/** One engagement: a grant, a contract or an agreement a workspace accounts for to a funder. */
@Injectable()
export class EngagementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly checks: ChecksService,
    private readonly log: AccessLogService
  ) {}

  private readonly summaryInclude = {
    workspace: true,
    monthlyReports: {
      include: {
        expenses: { select: { allocatedAmount: true } },
        checks: { where: { status: 'open' }, select: { severity: true } },
      },
      orderBy: { period: 'asc' as const },
    },
    documents: { orderBy: { uploadedAt: 'desc' as const } },
    participants: { select: { documents: { select: { purpose: true } } } },
    _count: { select: { budgetLines: true } },
  }

  async list(caller: Caller): Promise<EngagementSummary[]> {
    const rows = await this.prisma.engagement.findMany({
      where: tenantWhere(caller),
      include: this.summaryInclude,
      orderBy: [{ workspace: { name: 'asc' } }, { name: 'asc' }],
    })
    const summaries = rows.map((c) => this.summary(c))
    const count = summaries.reduce((t, c) => t + c.documents.length, 0)
    if (count > 0)
      await this.log.log(caller, {
        workspaceId: rows[0]!.workspaceId,
        resource: 'document',
        action: 'list',
        detail: `${count} engagement records across ${rows.length} engagements`,
      })
    return summaries
  }

  async get(caller: Caller, id: string): Promise<EngagementDetail> {
    const c = await this.prisma.engagement.findFirst({
      where: { id, ...tenantWhere(caller) },
      include: {
        ...this.summaryInclude,
        budgetLines: { orderBy: { sortOrder: 'asc' } },
        participants: {
          include: { documents: { include: { document: true } } },
          orderBy: { displayName: 'asc' },
        },
      },
    })
    if (!c) throw new NotFoundException()
    if (c.documents.length > 0)
      await this.log.log(caller, {
        workspaceId: c.workspaceId,
        resource: 'document',
        action: 'list',
        detail: `${c.documents.length} records of ${c.name}`,
      })
    if (c.participants.length > 0)
      await this.log.log(caller, {
        workspaceId: c.workspaceId,
        resource: 'participant',
        action: 'list',
        detail: `${c.participants.length} participants of ${c.name}`,
      })
    return {
      ...this.summary(c),
      funderContact: c.funderContact,
      solicitation: c.solicitation,
      proposalSubmittedOn: c.proposalSubmittedOn ? iso(c.proposalSubmittedOn) : null,
      awardedOn: c.awardedOn ? iso(c.awardedOn) : null,
      fundingSources: c.fundingSources,
      fundingOptions: c.workspace.fundingSources,
      reportDueDay: c.reportDueDay,
      indirectTerms: c.indirectTerms,
      reportTo: c.reportTo,
      submissionMethod: c.submissionMethod,
      preparerName: c.preparerName,
      preparerOrganization: c.preparerOrganization,
      authorizerName: c.authorizerName,
      authorizerOrganization: c.authorizerOrganization,
      eligibilityItems: eligibilityItemsOf(c),
      budgetLines: c.budgetLines.map((b) => ({
        category: b.category as BudgetCategory,
        reportLine: b.reportLine as ReportLine,
        amount: Number(b.amount),
        narrative: b.narrative,
      })),
      participants: c.participants.map(participantDto),
      canManage: workspaceRole(caller, c.workspaceId, WRITE_ROLES),
    }
  }

  /** The columns an input may set, validated. `partial` leaves out what the input does not mention. */
  private data(input: Partial<EngagementInput>, partial: boolean) {
    const bad = (m: string) => new BadRequestException(m)
    const out: Prisma.EngagementUncheckedUpdateInput = {}
    const has = (k: keyof EngagementInput) => !partial || k in input
    if (has('kind')) {
      if (!ENGAGEMENT_KINDS.includes(input.kind as EngagementKind))
        throw bad('kind is not one of the kinds')
      out.kind = input.kind
    }
    if (has('name')) {
      const name = input.name?.trim()
      if (!name) throw bad('An engagement needs a name')
      out.name = name
    }
    const text = (
      k:
        | 'funder'
        | 'funderContact'
        | 'solicitation'
        | 'number'
        | 'indirectTerms'
        | 'reportTo'
        | 'submissionMethod'
        | 'preparerName'
        | 'preparerOrganization'
        | 'authorizerName'
        | 'authorizerOrganization'
    ) => {
      if (has(k)) out[k] = input[k]?.trim() || null
    }
    text('funder')
    text('funderContact')
    text('solicitation')
    text('number')
    text('indirectTerms')
    text('reportTo')
    text('submissionMethod')
    text('preparerName')
    text('preparerOrganization')
    text('authorizerName')
    text('authorizerOrganization')
    // A new engagement may leave the checklist out: the defaults apply until an owner sets one.
    if (has('eligibilityItems') && (partial || input.eligibilityItems !== undefined)) {
      try {
        out.eligibilityItems = cleanEligibilityItems(
          input.eligibilityItems
        ) as unknown as Prisma.InputJsonValue
      } catch (e) {
        throw bad((e as Error).message)
      }
    }
    const amount = (k: 'requestedAmount' | 'awardAmount') => {
      if (!has(k)) return
      if (input[k] == null || input[k] === ('' as unknown)) {
        out[k] = null
        return
      }
      const n = Number(input[k])
      if (!Number.isFinite(n) || n <= 0) throw bad(`${k} must be a positive amount`)
      if (n >= 1e10) throw bad(`${k} must be under $10,000,000,000`)
      out[k] = n.toFixed(2)
    }
    amount('requestedAmount')
    amount('awardAmount')
    const day = (k: 'proposalSubmittedOn' | 'awardedOn' | 'periodStart' | 'periodEnd') => {
      if (!has(k)) return
      const v = input[k]
      if (!v) {
        out[k] = null
        return
      }
      if (!DAY.test(v)) throw bad(`${k} must be YYYY-MM-DD`)
      out[k] = new Date(`${v}T00:00:00Z`)
    }
    day('proposalSubmittedOn')
    day('awardedOn')
    day('periodStart')
    day('periodEnd')
    if (has('fundingSources'))
      out.fundingSources = (input.fundingSources ?? []).map((f) => String(f).trim()).filter(Boolean)
    if (has('reportDueDay')) {
      const n = input.reportDueDay == null ? 12 : Number(input.reportDueDay)
      if (!Number.isInteger(n) || n < 1 || n > 28)
        throw bad('reportDueDay must be a day of the month from 1 to 28')
      out.reportDueDay = n
    }
    if (has('waivers')) {
      const clean: Record<string, string> = {}
      for (const [kind, reason] of Object.entries(input.waivers ?? {})) {
        if (!DOCUMENT_KINDS.includes(kind as DocumentKind))
          throw bad(`${kind} is not a document kind`)
        const r = String(reason ?? '').trim()
        if (r.length > 200) throw bad('A reason is at most 200 characters')
        if (r) clean[kind] = r
      }
      out.waivers = clean
    }
    return out
  }

  /** A new engagement. Owners and bookkeepers of the workspace add one; the rest can come later. */
  async create(caller: Caller, input: EngagementInput): Promise<EngagementDetail> {
    allow(
      workspaceRole(caller, input.workspaceId, WRITE_ROLES),
      'Only an owner or bookkeeper of the workspace adds an engagement'
    )
    const data = this.data(input, false)
    if (data.periodStart && data.periodEnd && (data.periodEnd as Date) < (data.periodStart as Date))
      throw new BadRequestException('The engagement must end after it starts')
    let created: { id: string }
    try {
      created = await this.prisma.engagement.create({
        data: {
          ...(data as Prisma.EngagementUncheckedCreateInput),
          workspaceId: input.workspaceId,
          status: this.statusFor(data),
        },
        select: { id: true },
      })
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
        throw new BadRequestException(
          `A contract numbered ${input.number} already exists in this workspace`
        )
      throw e
    }
    await this.log.log(caller, {
      workspaceId: input.workspaceId,
      resource: 'engagement',
      subjectId: created.id,
      action: 'create',
      detail: input.name,
    })
    return this.get(caller, created.id)
  }

  /** Changes to an engagement's facts; the workspace cannot change. */
  async update(
    caller: Caller,
    id: string,
    input: Partial<EngagementInput>
  ): Promise<EngagementDetail> {
    const c = await this.prisma.engagement.findFirst({ where: { id, ...tenantWhere(caller) } })
    if (!c) throw new NotFoundException()
    allow(workspaceRole(caller, c.workspaceId, WRITE_ROLES), 'Only an owner or bookkeeper edits it')
    const data = this.data(input, true)
    const start = (data.periodStart as Date | null | undefined) ?? c.periodStart
    const end = (data.periodEnd as Date | null | undefined) ?? c.periodEnd
    if (start && end && end < start)
      throw new BadRequestException('The engagement must end after it starts')
    const merged = { ...c, ...data }
    try {
      await this.prisma.engagement.update({
        where: { id },
        data: { ...data, status: c.status === 'closed' ? 'closed' : this.statusFor(merged) },
      })
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
        throw new BadRequestException(
          `A contract numbered ${input.number} already exists in this workspace`
        )
      throw e
    }
    await this.log.log(caller, {
      workspaceId: c.workspaceId,
      resource: 'engagement',
      subjectId: id,
      action: 'update',
      detail: Object.keys(data).join(', '),
    })
    return this.get(caller, id)
  }

  /** Proposed until an award amount is on file; active once the contract period is set. */
  private statusFor(e: {
    awardAmount?: unknown
    periodStart?: unknown
    periodEnd?: unknown
  }): EngagementStatus {
    if (e.awardAmount != null && e.periodStart && e.periodEnd) return 'active'
    if (e.awardAmount != null) return 'awarded'
    return 'proposed'
  }

  async createReport(caller: Caller, engagementId: string, period: string): Promise<ReportSummary> {
    const c = await this.prisma.engagement.findFirst({
      where: { id: engagementId, ...tenantWhere(caller) },
    })
    if (!c) throw new NotFoundException()
    allow(workspaceRole(caller, c.workspaceId, WRITE_ROLES))
    if (!/^\d{4}-\d{2}$/.test(period)) throw new BadRequestException('period must be YYYY-MM')
    if (!c.periodStart || !c.periodEnd)
      throw new BadRequestException('Set the contract period (step 4) before starting a month')
    const start = c.periodStart.toISOString().slice(0, 7)
    const end = c.periodEnd.toISOString().slice(0, 7)
    if (period < start || period > end)
      throw new BadRequestException(`period must be within the contract (${start} to ${end})`)
    const report = await this.prisma.monthlyReport.create({
      data: { engagementId, period, dueDate: dueDate(period, c.reportDueDay) },
    })
    await this.checks.refresh(report.id)
    await this.log.log(caller, {
      workspaceId: c.workspaceId,
      resource: 'report',
      subjectId: report.id,
      action: 'create',
      detail: period,
    })
    return this.reportSummary({ ...report, expenses: [], checks: [] })
  }

  async createParticipant(
    caller: Caller,
    engagementId: string,
    input: { participantId: string; displayName: string; enrollmentStatus?: string }
  ): Promise<ParticipantDto> {
    const c = await this.prisma.engagement.findFirst({
      where: { id: engagementId, ...tenantWhere(caller) },
    })
    if (!c) throw new NotFoundException()
    allow(workspaceRole(caller, c.workspaceId, WRITE_ROLES))
    if (!input.participantId?.trim() || !input.displayName?.trim())
      throw new BadRequestException('participantId and displayName are required')
    const p = await this.prisma.participant.create({
      data: {
        engagementId,
        participantId: input.participantId.trim(),
        displayName: input.displayName.trim(),
        enrollmentStatus: input.enrollmentStatus === 'carryover' ? 'carryover' : 'new',
      },
      include: { documents: { include: { document: true } } },
    })
    await this.log.log(caller, {
      workspaceId: c.workspaceId,
      resource: 'participant',
      subjectId: p.id,
      action: 'create',
    })
    return participantDto(p)
  }

  private summary(c: {
    id: string
    workspaceId: string
    kind: string
    name: string
    funder: string | null
    number: string | null
    status: string
    periodStart: Date | null
    periodEnd: Date | null
    requestedAmount: unknown
    awardAmount: unknown
    waivers: unknown
    eligibilityItems: unknown
    workspace: { name: string }
    monthlyReports: Parameters<EngagementsService['reportSummary']>[0][]
    documents: Parameters<typeof documentDto>[0][]
    participants: { documents: { purpose: string }[] }[]
    _count: { budgetLines: number }
  }): EngagementSummary {
    const reports = c.monthlyReports.map((r) => this.reportSummary(r))
    const required = eligibilityItemsOf(c).filter((i) => i.required)
    const participantsComplete = c.participants.filter((p) => {
      const have = new Set(p.documents.map((d) => d.purpose))
      return required.every((i) => have.has(i.key))
    }).length
    return {
      id: c.id,
      workspaceId: c.workspaceId,
      workspaceName: c.workspace.name,
      kind: c.kind as EngagementKind,
      name: c.name,
      funder: c.funder,
      number: c.number,
      status: c.status as EngagementStatus,
      periodStart: c.periodStart ? iso(c.periodStart) : null,
      periodEnd: c.periodEnd ? iso(c.periodEnd) : null,
      requestedAmount: c.requestedAmount == null ? null : Number(c.requestedAmount),
      awardAmount: c.awardAmount == null ? null : Number(c.awardAmount),
      cumulativeBilled: reports.reduce((t, r) => t + r.billedThisPeriod, 0),
      budgetLineCount: c._count.budgetLines,
      reports,
      documents: c.documents.map(documentDto),
      waivers: (c.waivers ?? {}) as EngagementSummary['waivers'],
      participantCount: c.participants.length,
      participantsComplete,
    }
  }

  private reportSummary(r: {
    id: string
    period: string
    status: string
    dueDate: Date
    submittedAt: Date | null
    expenses: { allocatedAmount: unknown }[]
    checks: { severity: string }[]
  }): ReportSummary {
    return {
      id: r.id,
      period: r.period,
      status: r.status as ReportStatus,
      dueDate: iso(r.dueDate),
      submittedAt: r.submittedAt ? iso(r.submittedAt) : null,
      billedThisPeriod: r.expenses.reduce((t, e) => t + Number(e.allocatedAmount), 0),
      expenseCount: r.expenses.length,
      openBlockers: r.checks.filter((k) => k.severity === 'blocker').length,
      openAttention: r.checks.filter((k) => k.severity === 'attention').length,
    }
  }
}

export function participantDto(p: {
  id: string
  participantId: string
  displayName: string
  enrollmentStatus: string
  currentStatus: string
  documents: { purpose: string; document: Parameters<typeof documentDto>[0] }[]
}): ParticipantDto {
  return {
    id: p.id,
    participantId: p.participantId,
    displayName: p.displayName,
    enrollmentStatus: p.enrollmentStatus,
    currentStatus: p.currentStatus,
    documents: p.documents.map((d) => ({
      purpose: d.purpose,
      document: documentDto(d.document),
    })),
  }
}
