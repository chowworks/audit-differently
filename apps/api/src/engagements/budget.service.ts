import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import {
  REPORT_LINES,
  REPORT_LINE_LABELS,
  WRITE_ROLES,
  type BudgetChange,
  type BudgetLineInput,
  type ReportLine,
} from '@ad/types'
import type { Prisma } from '@prisma/client'
import { ChecksService } from '../checks/checks.service'
import { AccessLogService } from '../core/access-log.service'
import { allow, tenantWhere, workspaceRole, type Caller } from '../core/caller'
import { changesOf, type Fields } from '../core/changes'
import { PrismaService } from '../prisma/prisma.service'
import { backToDraft, BECAUSE } from '../reports/back-to-draft'
import { EngagementsService } from './engagements.service'

/** A budget line in the access log: its name, form line and amount by value, the note (free text) by name alone. */
export const BUDGET_LINE_FIELDS: Fields = {
  name: { label: 'Name', show: 'text' },
  reportLine: { label: 'Rolls up to', show: 'text', labels: REPORT_LINE_LABELS },
  amount: { label: 'Amount', show: 'money' },
  narrative: { label: 'Note' },
}

type Sent = BudgetChange['backToDraft']

/** An amount as the budget section enters it: blank is $0 until the contract says. */
function amountOf(given: unknown): string {
  if (given == null || given === '') return '0.00'
  const n = Number(given)
  if (!Number.isFinite(n) || n < 0) throw new BadRequestException('The amount must be $0 or more')
  if (n >= 1e10) throw new BadRequestException('The amount must be under $10,000,000,000')
  return n.toFixed(2)
}

function narrativeOf(given: unknown): string | null {
  const text = typeof given === 'string' ? given.trim() : ''
  if (text.length > 2000) throw new BadRequestException('Keep the note under 2,000 characters')
  return text || null
}

function nameOf(given: unknown): string {
  const name = typeof given === 'string' ? given.trim().replace(/\s+/g, ' ') : ''
  if (!name) throw new BadRequestException('Name the budget line as the approved budget does')
  if (name.length > 120) throw new BadRequestException('Keep the name under 120 characters')
  return name
}

function reportLineOf(given: unknown): ReportLine {
  if (!REPORT_LINES.includes(given as ReportLine))
    throw new BadRequestException("Choose the line of the funder's monthly form it rolls up to")
  return given as ReportLine
}

/**
 * The approved budget of an engagement (step 4): its budget lines as the contract names them, each with the funder form
 * line it rolls up to, its approved amount and a note. Every expense is spent against one of them. Owners and bookkeepers add, change and remove lines; an auditor reads them
 * on the engagement page. The month checks compare spending with these lines, so every change runs them again.
 */
@Injectable()
export class BudgetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly engagements: EngagementsService,
    private readonly checks: ChecksService,
    private readonly log: AccessLogService
  ) {}

  async add(caller: Caller, engagementId: string, input: BudgetLineInput): Promise<BudgetChange> {
    const c = await this.writable(caller, engagementId)
    const values = {
      name: nameOf(input?.name),
      reportLine: reportLineOf(input?.reportLine),
      amount: amountOf(input?.amount),
      narrative: narrativeOf(input?.narrative),
    }
    await this.refuseTaken(engagementId, values.name)
    const sortOrder = await this.prisma.budgetLine.count({ where: { engagementId } })
    let backed: Sent = []
    await this.log.change(
      caller,
      async (tx) => {
        const row = await tx.budgetLine.create({
          data: { engagementId, sortOrder, ...values },
        })
        backed = await this.backToDraft(tx, caller, c)
        return row
      },
      {
        workspaceId: c.workspaceId,
        resource: 'engagement',
        subjectId: c.id,
        action: 'create',
        description: `Added ${values.name} to the approved budget of ${c.name}`,
        changes: changesOf(null, values, BUDGET_LINE_FIELDS),
      }
    )
    return this.done(caller, c.id, backed)
  }

  async update(
    caller: Caller,
    engagementId: string,
    lineId: string,
    input: BudgetLineInput
  ): Promise<BudgetChange> {
    const { c, line, label, hasSpending } = await this.line(caller, engagementId, lineId)
    const values: {
      name?: string
      reportLine?: ReportLine
      amount?: string
      narrative?: string | null
    } = {}
    if (input && 'name' in input) {
      values.name = nameOf(input.name)
      if (values.name.toLowerCase() !== line.name.toLowerCase())
        await this.refuseTaken(engagementId, values.name)
    }
    if (input && 'reportLine' in input) {
      values.reportLine = reportLineOf(input.reportLine)
      if (values.reportLine !== line.reportLine && hasSpending)
        throw new ConflictException(
          `${label} has spending, so it keeps the line it rolls up to: add a new line instead`
        )
    }
    if (input && 'amount' in input) values.amount = amountOf(input.amount)
    if (input && 'narrative' in input) values.narrative = narrativeOf(input.narrative)
    const changes = changesOf(line, values, BUDGET_LINE_FIELDS)
    if (changes.length === 0)
      return { ...(await this.engagements.detail(caller, c.id)), backToDraft: [] }
    let backed: Sent = []
    await this.log.change(
      caller,
      async (tx) => {
        const row = await tx.budgetLine.update({ where: { id: line.id }, data: values })
        backed = await this.backToDraft(tx, caller, c)
        return row
      },
      {
        workspaceId: c.workspaceId,
        resource: 'engagement',
        subjectId: c.id,
        action: 'update',
        description: `Changed ${label} on the approved budget of ${c.name}`,
        changes,
      }
    )
    return this.done(caller, c.id, backed)
  }

  async remove(caller: Caller, engagementId: string, lineId: string): Promise<BudgetChange> {
    const { c, line, label, hasSpending } = await this.line(caller, engagementId, lineId)
    if (hasSpending)
      throw new ConflictException(
        `${label} has spending against it: move those expenses to another line first`
      )
    let backed: Sent = []
    await this.log.change(
      caller,
      async (tx) => {
        const row = await tx.budgetLine.delete({ where: { id: line.id } })
        backed = await this.backToDraft(tx, caller, c)
        return row
      },
      {
        workspaceId: c.workspaceId,
        resource: 'engagement',
        subjectId: c.id,
        action: 'delete',
        description: `Removed ${label} from the approved budget of ${c.name}`,
        changes: changesOf(line, null, BUDGET_LINE_FIELDS),
      }
    )
    return this.done(caller, c.id, backed)
  }

  /** The engagement, if the caller may change its budget: another workspace's is a 404, an auditor's a 403. */
  private async writable(caller: Caller, engagementId: string) {
    const c = await this.prisma.engagement.findFirst({
      where: { id: engagementId, ...tenantWhere(caller) },
      include: { workspace: true },
    })
    if (!c) throw new NotFoundException()
    allow(
      workspaceRole(caller, c.workspaceId, WRITE_ROLES),
      'Only an owner or bookkeeper changes the budget'
    )
    return c
  }

  private async line(caller: Caller, engagementId: string, lineId: string) {
    const c = await this.writable(caller, engagementId)
    const line = await this.prisma.budgetLine.findFirst({
      where: { id: lineId, engagementId, ...tenantWhere(caller) },
    })
    if (!line) throw new NotFoundException()
    const hasSpending = (await this.prisma.expense.count({ where: { budgetLineId: line.id } })) > 0
    return { c, line, label: line.name, hasSpending }
  }

  /** A name is the engagement's once, whatever its case (the database's unique index says the same). */
  private async refuseTaken(engagementId: string, name: string) {
    const lines = await this.prisma.budgetLine.findMany({
      where: { engagementId },
      select: { name: true },
    })
    if (lines.some((l) => l.name.toLowerCase() === name.toLowerCase()))
      throw new BadRequestException(`${name} is already on the budget`)
  }

  /**
   * Every closed or submitted month was closed against the budget as it stood, so a budget change puts each one back
   * to draft in the change's own transaction (the owner's decisions, 2026-10-16): a closed month sent back, a
   * submitted one reopened with its history kept, one line per month in the person's name. Drafts are untouched.
   */
  private async backToDraft(
    tx: Prisma.TransactionClient,
    caller: Caller,
    c: { id: string; name: string; workspaceId: string }
  ): Promise<Sent> {
    const locked = await tx.monthlyReport.findMany({
      where: { engagementId: c.id, status: { in: ['closed', 'submitted'] } },
      select: { id: true },
      orderBy: { period: 'asc' },
    })
    const sent: Sent = []
    for (const m of locked) {
      const { entry, ...month } = await backToDraft(tx, caller, m.id, c, BECAUSE.budget)
      await this.log.also(tx, caller, entry)
      sent.push(month)
    }
    return sent
  }

  /**
   * Every month's checks compare spending with the budget, so a change re-checks every month. Answers with the page's
   * data and the months it put back to draft.
   */
  private async done(caller: Caller, engagementId: string, sent: Sent): Promise<BudgetChange> {
    const reports = await this.prisma.monthlyReport.findMany({
      where: { engagementId },
      select: { id: true },
    })
    for (const r of reports) await this.checks.refresh(r.id)
    return { ...(await this.engagements.detail(caller, engagementId)), backToDraft: sent }
  }
}
