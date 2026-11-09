import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { createHash } from 'node:crypto'
import {
  type AccountMappingDto,
  type BooksLineDto,
  type ReportLine,
  type WorkspaceExpensesDto,
  type WorkspaceExpensesSavedDto,
} from '@ad/types'
import { ChecksService } from '../checks/checks.service'
import { dueDate } from '../checks/rules'
import { AccessLogService } from '../core/access-log.service'
import { allow, workspaceRole, type Caller } from '../core/caller'
import { dollars, howMany, monthName } from '../core/changes'
import { keyInWorkspace } from '../documents/documents.service'
import { csvLines, sheetLines } from '../payroll/payroll-details'
import { programNamesIn } from '../payroll/program-names'
import { PrismaService } from '../prisma/prisma.service'
import { DOCUMENT_STORAGE, type DocumentStorage } from '../storage/document-storage.interface'
import {
  categoriesOf,
  engagementOfMapping,
  readAccountMapping,
  budgetLineOfCategory,
  type AccountMappingRead,
} from './account-mapping'
import { booksTransactions, type BooksTransaction } from './books'
import {
  SKIP,
  allocationNote,
  planBooks,
  type PlanEngagement,
  type PlanMapping,
} from './books-plan'

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null)
const CSV = 'text/csv'
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/
/** A mapping file's rows are a chart of accounts: a few hundred at most. */
const MAX_ACCOUNTS = 5000

/**
 * The month's expenses from the books (owner's decision, 2026-11-09): read from the accounting export in the month's
 * saved payroll files, routed by class and account (`books-plan.ts`), saved as expense lines of each engagement's month,
 * each marked by its books key so saving again changes it, never adds a second. Separate from the payroll match: it
 * reads the same saved file and writes only lines of its own. Owners save; owners and auditors read.
 */
@Injectable()
export class ExpensesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly log: AccessLogService,
    private readonly checks: ChecksService,
    @Inject(DOCUMENT_STORAGE) private readonly storage: DocumentStorage
  ) {}

  private owner(caller: Caller, workspaceId: string) {
    if (!caller.workspaceIds.includes(workspaceId)) throw new NotFoundException()
    allow(
      !caller.admin && workspaceRole(caller, workspaceId, ['owner']),
      "Only an owner saves the month's expenses"
    )
  }

  private reader(caller: Caller, workspaceId: string) {
    if (!workspaceRole(caller, workspaceId, ['owner', 'auditor'])) throw new NotFoundException()
  }

  private period(given: unknown): string {
    if (typeof given !== 'string' || !PERIOD.test(given))
      throw new BadRequestException('The month must be YYYY-MM')
    return given
  }

  // ── Account mappings ─────────────────────────────────────────────────────

  private async engagementsOf(workspaceId: string) {
    return this.prisma.engagement.findMany({
      where: { workspaceId },
      orderBy: { name: 'asc' },
      include: {
        budgetLines: { orderBy: { sortOrder: 'asc' } },
        monthlyReports: { select: { id: true, period: true, status: true } },
      },
    })
  }

  private mappingDto(
    row: {
      id: string
      fileName: string
      engagementId: string | null
      read: unknown
      chosen: unknown
      changedAt: Date
    },
    engagements: Awaited<ReturnType<ExpensesService['engagementsOf']>>
  ): AccountMappingDto {
    const read = row.read as AccountMappingRead
    const chosen = (row.chosen ?? {}) as Record<string, string>
    const e = engagements.find((x) => x.id === row.engagementId) ?? null
    const lines = (e?.budgetLines ?? []).map((b) => ({
      id: b.id,
      name: b.name,
      amount: Number(b.amount),
    }))
    return {
      id: row.id,
      fileName: row.fileName,
      title: read.title,
      engagementId: e?.id ?? null,
      engagementName: e?.name ?? null,
      uploadedAt: row.changedAt.toISOString(),
      categories: categoriesOf(read).map((category) => {
        const pick = chosen[category]
        const line =
          pick === SKIP
            ? null
            : pick
              ? (lines.find((l) => l.id === pick) ?? null)
              : budgetLineOfCategory(category, read, lines)
        return {
          category,
          accounts: Object.values(read.accounts).filter((c) => c === category).length,
          budgetLineId: pick === SKIP ? SKIP : (line?.id ?? null),
          budgetLineName: line?.name ?? null,
          chosen: !!pick,
        }
      }),
    }
  }

  /**
   * An account mapping file (the zip's "Account mapping" folder): read, and kept for the engagement it names (its
   * contract total and period, or its name). The engagement's mapping before is replaced; one whose engagement it does
   * not say waits for an owner to choose. The file itself is not kept.
   */
  async addMapping(
    caller: Caller,
    workspaceId: string,
    file: { buffer: Buffer; originalname: string } | undefined
  ): Promise<AccountMappingDto> {
    this.owner(caller, workspaceId)
    if (!file) throw new BadRequestException('Choose the account mapping file')
    const read = await readAccountMapping(file.buffer, file.originalname)
    const accounts = Object.keys(read.accounts).length
    if (!accounts)
      throw new BadRequestException(
        `${file.originalname}: no account numbers found. An account mapping has a column of account numbers and one of the category each bills to.`
      )
    if (accounts > MAX_ACCOUNTS) throw new BadRequestException('The file has too many accounts')
    const engagements = await this.engagementsOf(workspaceId)
    const e = engagementOfMapping(
      read,
      engagements.map((x) => ({
        id: x.id,
        name: x.name,
        number: x.number,
        code: x.code,
        periodStart: day(x.periodStart),
        periodEnd: day(x.periodEnd),
        budgets: [
          x.budgetLines.reduce((t, b) => t + Number(b.amount), 0),
          ...(x.awardAmount ? [Number(x.awardAmount)] : []),
        ],
      }))
    )
    const sha256 = createHash('sha256').update(file.buffer).digest('hex')
    const data = {
      fileName: file.originalname.slice(0, 200),
      sha256,
      read: read as unknown as Prisma.InputJsonValue,
      changedById: caller.userId,
      changedAt: new Date(),
    }
    const row = await this.log.change(
      caller,
      async (tx) => {
        const before = e
          ? await tx.accountMapping.findFirst({ where: { workspaceId, engagementId: e.id } })
          : await tx.accountMapping.findFirst({
              where: { workspaceId, sha256, engagementId: null },
            })
        return before
          ? tx.accountMapping.update({ where: { id: before.id }, data })
          : tx.accountMapping.create({
              data: { ...data, workspaceId, engagementId: e?.id ?? null, chosen: {} },
            })
      },
      (r) => ({
        workspaceId,
        resource: 'engagement',
        subjectId: r.engagementId ?? workspaceId,
        action: 'update',
        description: e
          ? `Added the account mapping for ${e.name} from a file`
          : 'Added an account mapping from a file; its engagement is to be chosen',
        changes: [
          { field: 'Accounts', after: String(accounts) },
          {
            field: 'Billable accounts',
            after: String(Object.values(read.accounts).filter(Boolean).length),
          },
          { field: 'File SHA-256', after: sha256 },
        ],
      })
    )
    return this.mappingDto(row, engagements)
  }

  /** An owner's change to a mapping: whose engagement it is, and a category's budget line (or skip, or the file's own). */
  async setMapping(
    caller: Caller,
    workspaceId: string,
    mappingId: string,
    body: { engagementId?: unknown; category?: unknown; budgetLineId?: unknown }
  ): Promise<AccountMappingDto> {
    this.owner(caller, workspaceId)
    const row = await this.prisma.accountMapping.findFirst({
      where: { id: mappingId, workspaceId },
    })
    if (!row) throw new NotFoundException()
    const engagements = await this.engagementsOf(workspaceId)
    const data: Prisma.AccountMappingUpdateInput = {
      changedById: caller.userId,
      changedAt: new Date(),
    }
    const changes: { field: string; after: string }[] = []
    let engagementId = row.engagementId
    if (body.engagementId !== undefined) {
      if (
        typeof body.engagementId !== 'string' ||
        !engagements.some((x) => x.id === body.engagementId)
      )
        throw new BadRequestException('Choose one of the workspace’s engagements')
      engagementId = body.engagementId
      data.engagement = { connect: { id: engagementId } }
      // Another category's budget lines were the old engagement's: the choices start again.
      if (engagementId !== row.engagementId) data.chosen = {}
      changes.push({
        field: 'Engagement',
        after: engagements.find((x) => x.id === engagementId)!.name,
      })
    }
    if (body.category !== undefined) {
      const read = row.read as unknown as AccountMappingRead
      if (typeof body.category !== 'string' || !categoriesOf(read).includes(body.category))
        throw new BadRequestException('Choose a category of the mapping')
      const lines = engagements.find((x) => x.id === engagementId)?.budgetLines ?? []
      const pick = body.budgetLineId
      if (
        pick !== null &&
        pick !== SKIP &&
        !(typeof pick === 'string' && lines.some((l) => l.id === pick))
      )
        throw new BadRequestException('Choose one of the engagement’s budget lines, or skip')
      const chosen = { ...((data.chosen ?? row.chosen ?? {}) as Record<string, string>) }
      if (pick === null) delete chosen[body.category]
      else chosen[body.category] = pick as string
      data.chosen = chosen
      changes.push({
        field: `Budget line for ${body.category}`.slice(0, 120),
        after:
          pick === null
            ? 'As the file says'
            : pick === SKIP
              ? 'Not billed'
              : lines.find((l) => l.id === pick)!.name,
      })
    }
    let saved
    try {
      saved = await this.log.change(
        caller,
        (tx) => tx.accountMapping.update({ where: { id: row.id }, data }),
        {
          workspaceId,
          resource: 'engagement',
          subjectId: engagementId ?? workspaceId,
          action: 'update',
          description: 'Changed an account mapping',
          changes,
        }
      )
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
        throw new ConflictException(
          'That engagement has an account mapping already: remove it first'
        )
      throw e
    }
    return this.mappingDto(saved, engagements)
  }

  async removeMapping(caller: Caller, workspaceId: string, mappingId: string): Promise<void> {
    this.owner(caller, workspaceId)
    const row = await this.prisma.accountMapping.findFirst({
      where: { id: mappingId, workspaceId },
    })
    if (!row) throw new NotFoundException()
    await this.log.change(caller, (tx) => tx.accountMapping.delete({ where: { id: row.id } }), {
      workspaceId,
      resource: 'engagement',
      subjectId: row.engagementId ?? workspaceId,
      action: 'delete',
      description: 'Removed an account mapping',
    })
  }

  // ── The month's lines ────────────────────────────────────────────────────

  /** The accounting exports among the month's saved payroll files: each payroll details file with books transactions. */
  private async booksOf(workspaceId: string, period: string) {
    const docs = (
      await this.prisma.document.findMany({
        where: { workspaceId, engagementId: null, period, kind: 'payroll-details' },
        orderBy: { fileName: 'asc' },
      })
    ).filter((d) => keyInWorkspace(d))
    const files: { id: string; fileName: string; transactions: BooksTransaction[] }[] = []
    for (const d of docs) {
      const bytes = Buffer.from(await this.storage.read(d.storageKey))
      const lines = d.contentType === CSV ? csvLines(bytes) : await sheetLines(bytes)
      const transactions = booksTransactions(lines)
      if (transactions.length) files.push({ id: d.id, fileName: d.fileName, transactions })
    }
    return files
  }

  private async planOf(workspaceId: string, period: string) {
    const [files, engagements, mappings, workspace] = await Promise.all([
      this.booksOf(workspaceId, period),
      this.engagementsOf(workspaceId),
      this.prisma.accountMapping.findMany({
        where: { workspaceId },
        orderBy: { changedAt: 'asc' },
      }),
      this.prisma.workspace.findFirst({
        where: { id: workspaceId },
        select: { programNames: true },
      }),
    ])
    // One transaction once, though two exports of the month both have it.
    const seen = new Set<string>()
    const transactions = files
      .flatMap((f) => f.transactions)
      .filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)))
    const periods = [...new Set([period, ...transactions.map((t) => t.date.slice(0, 7))])]
    const existing = await this.prisma.expense.findMany({
      where: {
        engagementId: { in: engagements.map((e) => e.id) },
        OR: [
          { monthlyReport: { period: { in: periods } } },
          { booksKey: { startsWith: `${period}:` } },
        ],
      },
      include: { monthlyReport: { select: { period: true, status: true } } },
    })
    const planEngagements: PlanEngagement[] = engagements.map((e) => ({
      id: e.id,
      name: e.name,
      periodStart: day(e.periodStart),
      periodEnd: day(e.periodEnd),
      budgetLines: e.budgetLines.map((b) => ({ id: b.id, name: b.name, amount: Number(b.amount) })),
      months: e.monthlyReports.map((m) => ({ period: m.period, status: m.status })),
    }))
    const planMappings: PlanMapping[] = mappings.map((m) => ({
      id: m.id,
      engagementId: m.engagementId,
      read: m.read as unknown as AccountMappingRead,
      chosen: (m.chosen ?? {}) as Record<string, string>,
    }))
    const lines = planBooks({
      period,
      transactions,
      programs: programNamesIn(workspace?.programNames, new Set(engagements.map((e) => e.id))),
      engagements: planEngagements,
      mappings: planMappings,
      existing: existing.map((x) => ({
        id: x.id,
        engagementId: x.engagementId,
        booksKey: x.booksKey,
        date: x.date.toISOString().slice(0, 10),
        allocatedAmount: Number(x.allocatedAmount),
        totalCost: Number(x.totalCost),
        budgetLineId: x.budgetLineId,
        allocationNote: x.allocationNote,
      })),
    })
    return { files, engagements, mappings, lines, existing }
  }

  private dto(
    caller: Caller,
    workspaceId: string,
    period: string,
    plan: Awaited<ReturnType<ExpensesService['planOf']>>
  ): WorkspaceExpensesDto {
    return {
      workspaceId,
      period,
      file: plan.files[0] ? { id: plan.files[0].id, fileName: plan.files[0].fileName } : null,
      mappings: plan.mappings.map((m) => this.mappingDto(m, plan.engagements)),
      engagements: plan.engagements.map((e) => ({
        id: e.id,
        name: e.name,
        budgetLines: e.budgetLines.map((b) => ({ id: b.id, name: b.name })),
      })),
      lines: plan.lines,
      can: { change: !caller.admin && !!workspaceRole(caller, workspaceId, ['owner']) },
    }
  }

  /** The month's books lines and where each goes. One list line. */
  async expenses(
    caller: Caller,
    workspaceId: string,
    given: unknown
  ): Promise<WorkspaceExpensesDto> {
    this.reader(caller, workspaceId)
    const period = this.period(given)
    const plan = await this.planOf(workspaceId, period)
    await this.log.log(caller, {
      workspaceId,
      resource: 'expense',
      action: 'list',
      description: `Listed the books' expenses for ${monthName(period)} (${howMany(plan.lines.length, 'line')})`,
    })
    return this.dto(caller, workspaceId, period, plan)
  }

  /**
   * Save: each line on an engagement written to its month (the month started when it has none), a line written before
   * changed where the books changed, and a line written before that the books no longer put there removed. A month
   * that is not a draft is left as it is.
   */
  async save(
    caller: Caller,
    workspaceId: string,
    given: unknown
  ): Promise<WorkspaceExpensesSavedDto> {
    this.owner(caller, workspaceId)
    const period = this.period(given)
    const plan = await this.planOf(workspaceId, period)
    const billed = plan.lines.filter((l) => l.status === 'billed')
    const toCreate = billed.filter((l) => !l.saved)
    const toUpdate = billed.filter((l) => l.saved === 'changed')
    const keys = new Set(billed.map((l) => l.key))
    const toRemove = plan.existing.filter(
      (x) =>
        x.booksKey?.startsWith(`${period}:`) &&
        !keys.has(x.booksKey) &&
        x.monthlyReport.status === 'draft'
    )
    if (!toCreate.length && !toUpdate.length && !toRemove.length)
      return {
        created: 0,
        updated: 0,
        removed: 0,
        expenses: this.dto(caller, workspaceId, period, plan),
      }
    const byKey = new Map(plan.existing.filter((x) => x.booksKey).map((x) => [x.booksKey!, x]))
    const engagementOf = new Map(plan.engagements.map((e) => [e.id, e]))
    const lineOf = (l: BooksLineDto) =>
      engagementOf.get(l.engagementId!)!.budgetLines.find((b) => b.id === l.budgetLineId)!
    const fields = (l: BooksLineDto) => ({
      date: new Date(`${l.date}T00:00:00Z`),
      vendor: l.vendor.slice(0, 200),
      memo: l.description ? l.description.slice(0, 1000) : null,
      account: l.account.slice(0, 200),
      totalCost: (l.allocation?.total ?? l.amount).toFixed(2),
      allocatedAmount: l.amount.toFixed(2),
      allocationType: l.allocation ? 'books' : 'direct',
      allocationNote: allocationNote(l),
      budgetLineId: l.budgetLineId!,
      reportLine: lineOf(l).reportLine as ReportLine,
    })
    let touched: string[]
    try {
      touched = await this.log.change(
        caller,
        async (tx) => {
          const months = new Map<string, string>()
          const monthOf = async (l: BooksLineDto) => {
            const e = engagementOf.get(l.engagementId!)!
            const p = l.date.slice(0, 7)
            const at = `${e.id}\u0000${p}`
            const known = months.get(at) ?? e.monthlyReports.find((m) => m.period === p)?.id
            if (known) {
              months.set(at, known)
              return known
            }
            const made = await tx.monthlyReport.create({
              data: { engagementId: e.id, period: p, dueDate: dueDate(p, e.reportDueDay) },
            })
            months.set(at, made.id)
            return made.id
          }
          // A month closed since the plan is not written to.
          const locked = await tx.monthlyReport.findFirst({
            where: {
              engagementId: { in: [...new Set(billed.map((l) => l.engagementId!))] },
              period: { in: [...new Set(billed.map((l) => l.date.slice(0, 7)))] },
              status: { not: 'draft' },
            },
          })
          if (
            locked &&
            billed.some(
              (l) => l.engagementId === locked.engagementId && l.date.startsWith(locked.period)
            )
          )
            throw new ConflictException(
              `${monthName(locked.period)} changed meanwhile. Open the expenses again`
            )
          const taken = new Set(
            (
              await tx.expense.findMany({
                where: { engagementId: { in: [...engagementOf.keys()] } },
                select: { engagementId: true, itemNumber: true, reportLine: true },
              })
            ).map((x) => `${x.engagementId}\u0000${x.itemNumber}\u0000${x.reportLine}`)
          )
          const ids: string[] = []
          for (const x of toRemove) {
            await tx.expense.delete({ where: { id: x.id } })
            ids.push(x.monthlyReportId)
          }
          for (const l of toUpdate) {
            const x = byKey.get(l.key)!
            await tx.expense.update({ where: { id: x.id }, data: fields(l) })
            ids.push(x.monthlyReportId)
          }
          for (const l of toCreate) {
            const f = fields(l)
            const root = `QB-${l.transactionId}`.slice(0, 36)
            let itemNumber = root
            for (
              let k = 2;
              taken.has(`${l.engagementId}\u0000${itemNumber}\u0000${f.reportLine}`);
              k++
            )
              itemNumber = `${root}-${k}`
            taken.add(`${l.engagementId}\u0000${itemNumber}\u0000${f.reportLine}`)
            const monthlyReportId = await monthOf(l)
            await tx.expense.create({
              data: {
                ...f,
                engagementId: l.engagementId!,
                monthlyReportId,
                itemNumber,
                booksKey: l.key,
                createdById: caller.userId,
              },
            })
            ids.push(monthlyReportId)
          }
          return [...new Set(ids)]
        },
        {
          workspaceId,
          resource: 'expense',
          action: 'create',
          description: `Saved the books' expenses for ${monthName(period)}: ${howMany(toCreate.length, 'line')} added, ${howMany(toUpdate.length, 'line')} changed, ${howMany(toRemove.length, 'line')} removed`,
          changes: [
            { field: 'Added', after: String(toCreate.length) },
            { field: 'Changed', after: String(toUpdate.length) },
            { field: 'Removed', after: String(toRemove.length) },
            {
              field: 'Total on engagements',
              after: dollars(billed.reduce((t, l) => t + l.amount, 0)),
            },
          ],
        },
        { timeout: 30_000 }
      )
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
        throw new ConflictException('These expenses were saved a moment ago. Open them again')
      throw e
    }
    for (const id of touched) await this.checks.refresh(id)
    return {
      created: toCreate.length,
      updated: toUpdate.length,
      removed: toRemove.length,
      expenses: this.dto(caller, workspaceId, period, await this.planOf(workspaceId, period)),
    }
  }
}
