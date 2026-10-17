import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import {
  DOCUMENT_KIND_LABELS,
  DOCUMENT_KINDS,
  ENGAGEMENT_CODE_PATTERN,
  ENGAGEMENT_KIND_LABELS,
  ENGAGEMENT_KINDS,
  ENGAGEMENT_TRACK_LABELS,
  ENGAGEMENT_TRACKS,
  WRITE_ROLES,
  type DocumentKind,
  type EngagementDetail,
  type EngagementInput,
  type EngagementKind,
  type EngagementTrack,
  type EngagementStatus,
  type EngagementSummary,
  type LoggedChange,
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
import { changesOf, howMany, monthName, type Fields } from '../core/changes'
import { documentDto } from '../documents/document.dto'
import { PrismaService } from '../prisma/prisma.service'
import { budgetItemsOf } from '../workspaces/budget-items'
import { allTagTypes, cleanTags, tagWords } from '../workspaces/tags'
import { cleanEligibilityItems, eligibilityItemsOf } from './eligibility'

const iso = (d: Date) => d.toISOString()
const DAY = /^\d{4}-\d{2}-\d{2}$/

/** How the engagement page words a record that does not exist (RecordModal, and the Details modal's checkboxes). */
const WAIVER_WORDS: Partial<Record<DocumentKind, string>> = {
  proposal: 'proposal',
  'award-letter': 'award letter',
  'budget-narrative': 'budget narrative',
  contract: 'signed contract',
}
const waiverWord = (k: DocumentKind) => WAIVER_WORDS[k] ?? DOCUMENT_KIND_LABELS[k]

/** An engagement's status as its chip on the engagement page shows it. */
const STATUS_WORDS: Record<EngagementStatus, string> = {
  proposed: 'proposed',
  awarded: 'awarded',
  active: 'active',
  closed: 'closed',
}

/**
 * An engagement in the access log, each field under the label the Details modal and the setup flow show for it:
 * amounts, dates, kinds and statuses by value; people's names, contacts, free text, the checklist (its items are
 * the owners' own words) and a waiver's reason by name alone.
 */
const ENGAGEMENT_FIELDS: Fields = {
  kind: { label: 'Kind', show: 'text', labels: ENGAGEMENT_KIND_LABELS },
  name: { label: 'Name', show: 'text' },
  status: { label: 'Status', show: 'text', labels: STATUS_WORDS },
  tracks: { label: 'Records kept', show: 'list', labels: ENGAGEMENT_TRACK_LABELS },
  funder: { label: 'Funding organization', show: 'text' },
  funderContact: { label: 'Funding organization contact' },
  solicitation: { label: 'Proposal name', show: 'text' },
  number: { label: 'Contract number', show: 'text' },
  code: { label: 'Engagement code', show: 'text' },
  requestedAmount: { label: 'Amount requested', show: 'money' },
  awardAmount: { label: 'Award amount', show: 'money' },
  proposalSubmittedOn: { label: 'Submitted on', show: 'date' },
  awardedOn: { label: 'Award letter dated', show: 'date' },
  periodStart: { label: 'Starts', show: 'date' },
  periodEnd: { label: 'Ends', show: 'date' },
  reportDueDay: { label: 'Monthly report due on day', show: 'text' },
  // On no screen today; kept for an API caller.
  indirectTerms: { label: 'Indirect terms' },
  reportTo: { label: 'Submitted to' },
  submissionMethod: { label: 'How it is submitted' },
  preparerName: { label: 'Prepared by' },
  preparerOrganization: { label: 'Preparer organization' },
  authorizerName: { label: 'Authorized by' },
  authorizerOrganization: { label: 'Authorizer organization' },
  eligibilityItems: { label: 'Participant files' },
  ...Object.fromEntries(
    DOCUMENT_KINDS.map((k) => [`waiver:${k}`, { label: `No ${waiverWord(k)}` }])
  ),
}

/** The fields with the engagement's tags in the workspace's words ("Funding source: Youth Workforce Fund"). */
const fieldsFor = (w: { tagTypes?: unknown }): Fields => ({
  ...ENGAGEMENT_FIELDS,
  tags: { label: 'Tags', show: 'list', labels: tagWords(w) },
})

/** Which unique field a duplicate broke: the engagement code, or the contract number. */
function duplicateWords(
  e: Prisma.PrismaClientKnownRequestError,
  input: Partial<EngagementInput>
): string {
  const target = (e.meta as { target?: unknown } | undefined)?.target
  const fields = Array.isArray(target) ? target.map(String) : [String(target ?? '')]
  return fields.some((f) => f.includes('code'))
    ? `Another engagement in this workspace uses the code ${input.code?.trim().toUpperCase()}`
    : `A contract numbered ${input.number} already exists in this workspace`
}

/** A participant is personal: every field by name alone. */
export const PARTICIPANT_FIELDS: Fields = {
  displayName: { label: 'Name' },
  participantId: { label: 'Participant number' },
  enrollmentStatus: { label: 'Enrollment' },
  // A participant's tags are personal data (an age group, a funding stream): by name alone.
  tags: { label: 'Tags' },
}

/**
 * An engagement's values for `changesOf`: a waiver per document kind (every kind when `all`, for an update), and the
 * checklist as the engagement uses it, so a row that holds none compares equal to the defaults it shows.
 */
function loggable(values: Record<string, unknown>, all: boolean): Record<string, unknown> {
  const { waivers, ...rest } = values
  if ('eligibilityItems' in rest && rest.eligibilityItems !== undefined)
    rest.eligibilityItems = eligibilityItemsOf({ eligibilityItems: rest.eligibilityItems })
  if (waivers === undefined) return rest
  const w = (waivers ?? {}) as Record<string, string>
  for (const k of all ? DOCUMENT_KINDS : Object.keys(w)) rest[`waiver:${k}`] = w[k] ?? null
  return rest
}

/**
 * What a change to an engagement says. A change of one waiver alone is worded as RecordModal words it: no such
 * document, a new reason, or the reason removed; anything else is a change of the details.
 */
function describeUpdate(
  name: string,
  changes: LoggedChange[],
  before: unknown,
  after: unknown
): string {
  const touched = DOCUMENT_KINDS.filter((k) =>
    changes.some((ch) => ch.field === ENGAGEMENT_FIELDS[`waiver:${k}`]!.label)
  )
  if (changes.length === 1 && touched.length === 1) {
    const k = touched[0]!
    const b = ((before ?? {}) as Record<string, string>)[k]
    const a = ((after ?? {}) as Record<string, string>)[k]
    const word = waiverWord(k)
    if (!b) return `Recorded that ${name} has no ${word}`
    if (!a) return `Removed the reason ${name} has no ${word}`
    return `Changed why ${name} has no ${word}`
  }
  return `Changed the details of ${name}`
}

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
        reopenings: {
          select: { reopenedAt: true },
          orderBy: { reopenedAt: 'desc' as const },
          take: 1,
        },
      },
      orderBy: { period: 'asc' as const },
    },
    documents: { orderBy: { uploadedAt: 'desc' as const } },
    participants: { select: { documents: { select: { purpose: true } } } },
    // The lines with an amount entered: a line a new engagement ticked starts at $0.
    _count: { select: { budgetLines: { where: { amount: { gt: 0 } } } } },
  }

  /**
   * The engagements of every workspace the caller belongs to (the overview, and a workspace's own page). One line in
   * each workspace's log, with that workspace's own counts: no workspace learns another's size.
   */
  async list(caller: Caller): Promise<EngagementSummary[]> {
    const rows = await this.prisma.engagement.findMany({
      where: tenantWhere(caller),
      include: this.summaryInclude,
      orderBy: [{ workspace: { name: 'asc' } }, { name: 'asc' }],
    })
    const summaries = rows.map((c) => this.summary(c))
    const byWorkspace = new Map<string, EngagementSummary[]>()
    for (const c of summaries)
      byWorkspace.set(c.workspaceId, [...(byWorkspace.get(c.workspaceId) ?? []), c])
    for (const [workspaceId, list] of byWorkspace) {
      const records = list.reduce((t, c) => t + c.documents.length, 0)
      await this.log.log(caller, {
        workspaceId,
        resource: 'engagement',
        action: 'list',
        description: `Viewed the list of engagements: ${howMany(list.length, 'engagement')}, ${howMany(records, 'record')}`,
      })
    }
    return summaries
  }

  /** Opening an engagement's page: one line, with what the page lists. */
  async get(caller: Caller, id: string): Promise<EngagementDetail> {
    const c = await this.detail(caller, id)
    await this.log.log(caller, {
      workspaceId: c.workspaceId,
      resource: 'engagement',
      subjectId: c.id,
      action: 'read',
      description: `Viewed ${c.name}: ${howMany(c.documents.length, 'record')}, ${howMany(c.participants.length, 'participant')}`,
    })
    return c
  }

  /**
   * The engagement as its page shows it, unlogged: what a change returns to the page that made it (here, and an
   * upload into a participant's file). Only `get`, the person opening the page, writes the read line; never serve
   * this from a GET.
   */
  async detail(caller: Caller, id: string): Promise<EngagementDetail> {
    const c = await this.prisma.engagement.findFirst({
      where: { id, ...tenantWhere(caller) },
      include: {
        ...this.summaryInclude,
        budgetLines: {
          orderBy: { sortOrder: 'asc' },
          include: { _count: { select: { expenses: true } } },
        },
        participants: {
          include: { documents: { include: { document: true } } },
          orderBy: { displayName: 'asc' },
        },
      },
    })
    if (!c) throw new NotFoundException()
    // What was charged to each budget line to date, every month together.
    const spentByLine = new Map(
      (
        await this.prisma.expense.groupBy({
          by: ['budgetLineId'],
          where: { engagementId: c.id, ...tenantWhere(caller) },
          _sum: { allocatedAmount: true },
        })
      ).map((g) => [g.budgetLineId, Number(g._sum.allocatedAmount ?? 0)])
    )
    // The names budget lines have in this workspace's other engagements, to suggest.
    const used = await this.prisma.budgetLine.findMany({
      where: { engagement: { workspaceId: c.workspaceId }, ...tenantWhere(caller) },
      select: { name: true },
      distinct: ['name'],
    })
    const suggestions = [...new Set(used.map((u) => u.name.trim()))].sort((a, b) =>
      a.localeCompare(b)
    )
    return {
      ...this.summary(c),
      funderContact: c.funderContact,
      solicitation: c.solicitation,
      proposalSubmittedOn: c.proposalSubmittedOn ? iso(c.proposalSubmittedOn) : null,
      awardedOn: c.awardedOn ? iso(c.awardedOn) : null,
      tags: c.tags,
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
        id: b.id,
        name: b.name,
        reportLine: b.reportLine as ReportLine,
        amount: Number(b.amount),
        narrative: b.narrative,
        hasSpending: b._count.expenses > 0,
        spent: spentByLine.get(b.id) ?? 0,
      })),
      budgetNameSuggestions: suggestions,
      tagTypes: allTagTypes(c.workspace),
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
    // A new engagement that does not say keeps every record (the column's default).
    if (has('tracks') && input.tracks !== undefined) {
      if (!Array.isArray(input.tracks) || input.tracks.some((t) => !ENGAGEMENT_TRACKS.includes(t)))
        throw bad('tracks may hold only proposal, award-letter and contract')
      // In the list's own order, once each, so a Save that reorders nothing is no change.
      out.tracks = ENGAGEMENT_TRACKS.filter((t) => input.tracks!.includes(t))
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
    if (has('code')) {
      const code = input.code?.trim().toUpperCase() || null
      if (code && !ENGAGEMENT_CODE_PATTERN.test(code))
        throw bad('The engagement code is 2 to 20 letters, digits and hyphens')
      out.code = code
    }
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
    const w = (await this.prisma.workspace.findFirst({ where: { id: input.workspaceId } })) ?? {}
    if (input.tags !== undefined) data.tags = cleanTags(input.tags, w, 'engagement')
    if (data.periodStart && data.periodEnd && (data.periodEnd as Date) < (data.periodStart as Date))
      throw new BadRequestException('The engagement must end after it starts')
    let created: { id: string }
    const values = { ...data, status: this.statusFor(data) }
    const budget = await this.enabledItems(input)
    const budgetChange: LoggedChange[] = budget.length
      ? [{ field: 'Budget lines', after: budget.map((i) => i.label).join(', ') }]
      : []
    try {
      created = await this.log.change(
        caller,
        (tx) =>
          tx.engagement.create({
            data: {
              ...(values as Prisma.EngagementUncheckedCreateInput),
              workspaceId: input.workspaceId,
              // Each budget item it uses is a line of $0 until the approved budget is entered (step 4).
              ...(budget.length && {
                budgetLines: {
                  create: budget.map((i) => ({
                    name: i.label,
                    category: i.key,
                    reportLine: i.reportLine,
                    amount: '0.00',
                    sortOrder: i.sortOrder,
                  })),
                },
              }),
            },
            select: { id: true },
          }),
        (made) => ({
          workspaceId: input.workspaceId,
          resource: 'engagement',
          subjectId: made.id,
          action: 'create',
          description: `Created the engagement ${values.name as string}`,
          changes: [...changesOf(null, loggable(values, false), fieldsFor(w)), ...budgetChange],
        })
      )
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
        throw new BadRequestException(duplicateWords(e, input))
      throw e
    }
    return this.detail(caller, created.id)
  }

  /** The workspace's budget items a new engagement uses (`budgetItems`, keys), in the list's order. */
  private async enabledItems(input: EngagementInput) {
    if (input.budgetItems === undefined) return []
    if (!Array.isArray(input.budgetItems))
      throw new BadRequestException('budgetItems must be a list of budget item keys')
    const w = await this.prisma.workspace.findFirst({ where: { id: input.workspaceId } })
    const items = budgetItemsOf(w ?? {})
    const unknown = input.budgetItems.filter((k) => !items.some((i) => i.key === k))
    if (unknown.length) throw new BadRequestException("Choose from the workspace's budget items")
    return items
      .map((i, sortOrder) => ({ ...i, sortOrder }))
      .filter((i) => input.budgetItems!.includes(i.key))
  }

  /** Changes to an engagement's facts; the workspace cannot change. */
  async update(
    caller: Caller,
    id: string,
    input: Partial<EngagementInput>
  ): Promise<EngagementDetail> {
    const c = await this.prisma.engagement.findFirst({
      where: { id, ...tenantWhere(caller) },
      include: { workspace: true },
    })
    if (!c) throw new NotFoundException()
    allow(workspaceRole(caller, c.workspaceId, WRITE_ROLES), 'Only an owner or bookkeeper edits it')
    const data = this.data(input, true)
    if ('tags' in input) data.tags = cleanTags(input.tags, c.workspace, 'engagement', c.tags)
    const fields = fieldsFor(c.workspace)
    const start = (data.periodStart as Date | null | undefined) ?? c.periodStart
    const end = (data.periodEnd as Date | null | undefined) ?? c.periodEnd
    if (start && end && end < start)
      throw new BadRequestException('The engagement must end after it starts')
    // The Details modal sends every field on every Save: only what differs is a change.
    if (
      data.eligibilityItems !== undefined &&
      JSON.stringify(data.eligibilityItems) === JSON.stringify(eligibilityItemsOf(c))
    )
      delete data.eligibilityItems
    if (this.changeOf(c, data, fields).changes.length === 0) return this.detail(caller, id)
    try {
      await this.log.change(
        caller,
        async (tx) => {
          // Read again inside the transaction, so the line describes the row this update changed.
          const before = await tx.engagement.findFirst({ where: { id, ...tenantWhere(caller) } })
          if (!before) throw new NotFoundException()
          const change = this.changeOf(before, data, fields)
          await tx.engagement.update({ where: { id }, data: change.values })
          return { before, ...change }
        },
        ({ before, values, changes }) => ({
          workspaceId: before.workspaceId,
          resource: 'engagement',
          subjectId: id,
          action: 'update',
          description: describeUpdate(
            (values.name as string | undefined) ?? before.name,
            changes,
            before.waivers,
            values.waivers ?? before.waivers
          ),
          changes,
        })
      )
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
        throw new BadRequestException(duplicateWords(e, input))
      throw e
    }
    return this.detail(caller, id)
  }

  /** What `data` would write over `before` (the status follows the facts unless closed), and the fields it changes. */
  private changeOf(
    before: Record<string, unknown> & { status: string },
    data: Prisma.EngagementUncheckedUpdateInput,
    fields: Fields
  ) {
    const merged = { ...before, ...data }
    const values: Prisma.EngagementUncheckedUpdateInput = {
      ...data,
      status: before.status === 'closed' ? 'closed' : this.statusFor(merged),
    }
    const changes = changesOf(loggable(before, true), loggable(values, true), fields)
    return { values, changes }
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
    const due = dueDate(period, c.reportDueDay)
    const report = await this.log.change(
      caller,
      (tx) => tx.monthlyReport.create({ data: { engagementId, period, dueDate: due } }),
      (made) => ({
        workspaceId: c.workspaceId,
        resource: 'report',
        subjectId: made.id,
        action: 'create',
        description: `Started ${monthName(period)} of ${c.name}`,
        changes: [{ field: 'Due on', after: due.toISOString().slice(0, 10) }],
      })
    )
    // A new month has no expenses; its checks are the findings this first run opens.
    const findings = await this.checks.refresh(report.id)
    return this.reportSummary({
      ...report,
      expenses: [],
      checks: findings.map((f) => ({ severity: f.severity })),
    })
  }

  async createParticipant(
    caller: Caller,
    engagementId: string,
    input: { participantId: string; displayName: string; enrollmentStatus?: string; tags?: unknown }
  ): Promise<ParticipantDto> {
    const c = await this.prisma.engagement.findFirst({
      where: { id: engagementId, ...tenantWhere(caller) },
      include: { workspace: true },
    })
    if (!c) throw new NotFoundException()
    allow(workspaceRole(caller, c.workspaceId, WRITE_ROLES))
    if (!input.participantId?.trim() || !input.displayName?.trim())
      throw new BadRequestException('participantId and displayName are required')
    const data = {
      engagementId,
      participantId: input.participantId.trim(),
      displayName: input.displayName.trim(),
      enrollmentStatus: input.enrollmentStatus === 'carryover' ? 'carryover' : 'new',
      tags: cleanTags(input.tags, c.workspace, 'participant'),
    }
    const p = await this.log.change(
      caller,
      (tx) =>
        tx.participant.create({ data, include: { documents: { include: { document: true } } } }),
      (made) => ({
        workspaceId: c.workspaceId,
        resource: 'participant',
        subjectId: made.id,
        action: 'create',
        description: `Added a participant to ${c.name}`,
        changes: changesOf(null, data, PARTICIPANT_FIELDS),
      })
    )
    return participantDto(p)
  }

  private summary(c: {
    id: string
    workspaceId: string
    kind: string
    name: string
    funder: string | null
    number: string | null
    code: string | null
    status: string
    tracks: string[]
    periodStart: Date | null
    periodEnd: Date | null
    requestedAmount: unknown
    awardAmount: unknown
    waivers: unknown
    eligibilityItems: unknown
    workspace: { name: string; featuredDemo: boolean }
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
      workspaceFeaturedDemo: c.workspace.featuredDemo,
      kind: c.kind as EngagementKind,
      name: c.name,
      funder: c.funder,
      number: c.number,
      code: c.code,
      status: c.status as EngagementStatus,
      tracks: c.tracks as EngagementTrack[],
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
    /** The latest reopening first, if any. */
    reopenings?: { reopenedAt: Date }[]
  }): ReportSummary {
    return {
      id: r.id,
      period: r.period,
      status: r.status as ReportStatus,
      dueDate: iso(r.dueDate),
      submittedAt: r.submittedAt ? iso(r.submittedAt) : null,
      lastReopenedAt: r.reopenings?.[0] ? iso(r.reopenings[0].reopenedAt) : null,
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
  tags: string[]
  documents: { purpose: string; document: Parameters<typeof documentDto>[0] }[]
}): ParticipantDto {
  return {
    id: p.id,
    participantId: p.participantId,
    displayName: p.displayName,
    enrollmentStatus: p.enrollmentStatus,
    currentStatus: p.currentStatus,
    tags: p.tags,
    documents: p.documents.map((d) => ({
      purpose: d.purpose,
      document: documentDto(d.document),
    })),
  }
}
