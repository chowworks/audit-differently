import { carryRename } from '../aliases/rename'
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import {
  PAYROLL_BUDGET_KINDS,
  PAYROLL_BUDGET_KIND_LABELS,
  aliasKey,
  payrollHolder,
  REPORT_LINES,
  REPORT_LINE_LABELS,
  WRITE_ROLES,
  type BudgetChange,
  type BudgetLineInput,
  type PayrollBudgetKind,
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
  payroll: { label: 'Payroll from the match on this line', show: 'text' },
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

/** The payroll kinds ticked on a line: known kinds only, each once, in their own order. */
function payrollOf(given: unknown): PayrollBudgetKind[] {
  if (!Array.isArray(given)) throw new BadRequestException('Say which payroll this line holds')
  const bad = given.filter((k) => !(PAYROLL_BUDGET_KINDS as readonly unknown[]).includes(k))
  if (bad.length) throw new BadRequestException('Choose payroll this line can hold')
  return PAYROLL_BUDGET_KINDS.filter((k) => given.includes(k))
}

/** The payroll kinds as the access log shows them: their screen words. */
const payrollWords = (kinds: PayrollBudgetKind[]) =>
  kinds.length ? kinds.map((k) => PAYROLL_BUDGET_KIND_LABELS[k]).join(', ') : 'None'

/** The books' payroll rows a change moved to the line, in the log line's words; those left on a locked month too. */
function movedWords(rows: { moved: number; stayed: number }, line: string): string {
  const n = (k: number) => `${k} imported payroll ${k === 1 ? 'row' : 'rows'}`
  return [
    rows.moved ? `; moved ${n(rows.moved)} to ${line}` : '',
    rows.stayed
      ? `; ${n(rows.stayed)} on a closed or submitted month stayed where ${rows.stayed === 1 ? 'it was' : 'they were'}`
      : '',
  ].join('')
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
 * The first month of an engagement with participant payments, or null: participant pay counts on its line in that month
 * and in every later month's spending to date, so those are the months a move of participant pay changes.
 */
export async function firstParticipantPay(
  db: Pick<Prisma.TransactionClient, 'monthlyReport'>,
  engagementId: string
): Promise<string | null> {
  const m = await db.monthlyReport.findFirst({
    where: { engagementId, wexPayments: { some: {} } },
    orderBy: { period: 'asc' },
    select: { period: true },
  })
  return m?.period ?? null
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
    // Asked for by the payroll page: these kinds on this line, as the engagement's own entries of the rollup.
    const asked = input && 'payroll' in input ? payrollOf(input.payroll) : []
    await this.refuseTaken(engagementId, values.name)
    const sortOrder = await this.prisma.budgetLine.count({ where: { engagementId } })
    let backed: Sent = []
    let rows = { moved: 0, stayed: 0 }
    let payroll: PayrollBudgetKind[] = []
    await this.log.change(
      caller,
      async (tx) => {
        await this.ownEntries(tx, caller, c, values.name, asked)
        const row = await tx.budgetLine.create({
          data: { engagementId, sortOrder, ...values, payroll: [] },
        })
        backed = await this.backToDraft(tx, caller, c)
        // The payroll rollup says, by name, which payroll the new line holds (#138).
        rows = (await this.applyRollup(tx, caller, c, false)).rows
        payroll = await this.payrollOn(tx, row.id)
        return row
      },
      () => ({
        workspaceId: c.workspaceId,
        resource: 'engagement',
        subjectId: c.id,
        action: 'create',
        description: `Added ${values.name} to the approved budget of ${c.name}${movedWords(rows, values.name)}`,
        changes: changesOf(
          null,
          { ...values, ...(payroll.length ? { payroll: payrollWords(payroll) } : {}) },
          BUDGET_LINE_FIELDS
        ),
      })
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
    const asked = input && 'payroll' in input ? payrollOf(input.payroll) : []
    const had = line.payroll as PayrollBudgetKind[]
    const changes = changesOf(line, values, BUDGET_LINE_FIELDS)
    if (changes.length === 0 && asked.every((k) => had.includes(k)))
      return { ...(await this.engagements.detail(caller, c.id)), backToDraft: [] }
    let backed: Sent = []
    let rows = { moved: 0, stayed: 0 }
    let carried = 0
    let payroll = had
    await this.log.change(
      caller,
      async (tx) => {
        // The QuickBooks names and the payroll rollup's entries that point at its old name follow it (#132, #138).
        if (values.name)
          carried = await carryRename(tx, {
            workspaceId: c.workspaceId,
            engagementId,
            from: line.name,
            to: values.name,
            changedById: caller.userId,
          })
        const row = await tx.budgetLine.update({ where: { id: line.id }, data: values })
        await this.ownEntries(tx, caller, c, values.name ?? line.name, asked)
        backed = await this.backToDraft(tx, caller, c)
        rows = (await this.applyRollup(tx, caller, c, false)).rows
        payroll = await this.payrollOn(tx, line.id)
        return row
      },
      () => ({
        workspaceId: c.workspaceId,
        resource: 'engagement',
        subjectId: c.id,
        action: 'update',
        description: `Changed ${label} on the approved budget of ${c.name}${movedWords(rows, values.name ?? label)}`,
        changes: [
          ...changes,
          ...(payrollWords(payroll) !== payrollWords(had)
            ? changesOf(
                { payroll: payrollWords(had) },
                { payroll: payrollWords(payroll) },
                BUDGET_LINE_FIELDS
              )
            : []),
          ...(carried
            ? [{ field: 'QuickBooks names moved to the new name', after: String(carried) }]
            : []),
        ],
      })
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

  /**
   * Every kind of payroll onto the line the payroll rollup says (#138), on `tx`: each line's ticks follow the list, and
   * the books' payroll rows of a kind that moved follow its new line, on draft months only (a locked month keeps its
   * rows, and the match's lines keep theirs). With `sendBack` (the rollup's own save; a budget change has reopened every
   * month already), only the months whose numbers change go back to draft (owner's decision, 2026-11-27): participant
   * pay counts on the line that holds it as each month is read, so moving it reopens the locked months from the first
   * one with participant payments (`participantPayReopens`); staff pay and taxes reopen nothing.
   */
  async applyRollup(
    tx: Prisma.TransactionClient,
    caller: Caller,
    c: { id: string; name: string; workspaceId: string },
    sendBack: boolean
  ): Promise<{ changed: boolean; rows: { moved: number; stayed: number }; backed: Sent }> {
    const [entries, lines] = await Promise.all([
      tx.lineAlias.findMany({
        where: {
          workspaceId: c.workspaceId,
          list: 'payroll',
          OR: [{ engagementId: null }, { engagementId: c.id }],
        },
        select: { name: true, engagementId: true, budgetLineName: true, unallowable: true },
      }),
      tx.budgetLine.findMany({
        where: { engagementId: c.id },
        orderBy: { sortOrder: 'asc' },
        select: { id: true, name: true, reportLine: true, payroll: true },
      }),
    ])
    const list = entries.flatMap((e) =>
      (PAYROLL_BUDGET_KINDS as readonly string[]).includes(e.name)
        ? [
            {
              kind: e.name as PayrollBudgetKind,
              engagementId: e.engagementId,
              budgetLineName: e.unallowable ? null : e.budgetLineName,
            },
          ]
        : []
    )
    const want = new Map(lines.map((l) => [l.id, [] as PayrollBudgetKind[]]))
    const arrived: { lineId: string; kind: PayrollBudgetKind }[] = []
    for (const kind of PAYROLL_BUDGET_KINDS) {
      const holder = payrollHolder(kind, c.id, list, lines)
      if (!holder) continue
      want.get(holder.id)!.push(kind)
      if (!holder.payroll.includes(kind)) arrived.push({ lineId: holder.id, kind })
    }
    const movedKinds = new Set<PayrollBudgetKind>()
    for (const kind of PAYROLL_BUDGET_KINDS) {
      const before = lines.find((l) => l.payroll.includes(kind))?.id ?? null
      const after = [...want].find(([, kinds]) => kinds.includes(kind))?.[0] ?? null
      if (before !== after) movedKinds.add(kind)
    }
    const differs = lines.filter(
      (l) =>
        want.get(l.id)!.join() !== PAYROLL_BUDGET_KINDS.filter((k) => l.payroll.includes(k)).join()
    )
    const rows = { moved: 0, stayed: 0 }
    if (!differs.length) return { changed: false, rows, backed: [] }
    for (const l of differs)
      await tx.budgetLine.update({ where: { id: l.id }, data: { payroll: want.get(l.id)! } })
    const from = movedKinds.has('participant-pay') ? await firstParticipantPay(tx, c.id) : null
    const backed = sendBack && from ? await this.backToDraft(tx, caller, c, from) : []
    for (const a of arrived) {
      const r = await this.moveBooksPayroll(tx, c.id, a.lineId, [a.kind])
      rows.moved += r.moved
      rows.stayed += r.stayed
    }
    return { changed: true, rows, backed }
  }

  /** The kinds asked for on a line (the payroll page) kept as this engagement's own entries of the rollup. */
  private async ownEntries(
    tx: Prisma.TransactionClient,
    caller: Caller,
    c: { id: string; workspaceId: string },
    lineName: string,
    kinds: PayrollBudgetKind[]
  ) {
    for (const kind of kinds) {
      const data = {
        name: kind,
        key: aliasKey(kind),
        budgetLineName: lineName,
        unallowable: false,
        changedById: caller.userId,
        changedAt: new Date(),
      }
      const had = await tx.lineAlias.findFirst({
        where: { workspaceId: c.workspaceId, list: 'payroll', engagementId: c.id, name: kind },
        select: { id: true },
      })
      if (had) await tx.lineAlias.update({ where: { id: had.id }, data })
      else
        await tx.lineAlias.create({
          data: { ...data, workspaceId: c.workspaceId, engagementId: c.id, list: 'payroll' },
        })
    }
  }

  private async payrollOn(tx: Prisma.TransactionClient, lineId: string) {
    const l = await tx.budgetLine.findFirst({ where: { id: lineId }, select: { payroll: true } })
    return (l?.payroll ?? []) as PayrollBudgetKind[]
  }

  /**
   * The books' payroll rows (imported, kept for payroll reconciliation) of the kinds a line now takes follow it, so the
   * old line shows no spending that is no longer its own and a re-import finds them where they belong. Runs after the
   * change put every closed and submitted month back to draft, so a month still locked (a closing approved meanwhile)
   * keeps its rows, which are counted for the log line.
   */
  private async moveBooksPayroll(
    tx: Prisma.TransactionClient,
    engagementId: string,
    lineId: string,
    kinds: PayrollBudgetKind[]
  ) {
    if (!kinds.length) return { moved: 0, stayed: 0 }
    const where = {
      engagementId,
      payrollKind: { in: kinds },
      OR: [{ budgetLineId: null }, { budgetLineId: { not: lineId } }],
    }
    const { count: moved } = await tx.expense.updateMany({
      where: { ...where, monthlyReport: { status: 'draft' } },
      data: { budgetLineId: lineId },
    })
    const stayed = await tx.expense.count({ where })
    return { moved, stayed }
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
    c: { id: string; name: string; workspaceId: string },
    /** Only this month and later (the payroll rollup's own save). */
    from?: string
  ): Promise<Sent> {
    const locked = await tx.monthlyReport.findMany({
      where: {
        engagementId: c.id,
        status: { in: ['closed', 'submitted'] },
        ...(from ? { period: { gte: from } } : {}),
      },
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
    await this.recheck(engagementId)
    return { ...(await this.engagements.detail(caller, engagementId)), backToDraft: sent }
  }

  /** Every month of the engagement checked again (a budget change, or the payroll rollup's). */
  async recheck(engagementId: string) {
    const reports = await this.prisma.monthlyReport.findMany({
      where: { engagementId },
      select: { id: true },
    })
    for (const r of reports) await this.checks.refresh(r.id)
  }
}
