import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { createHash } from 'node:crypto'
import {
  RECEIPT_KINDS,
  type AccountMappingDto,
  type BooksBillInput,
  type BooksBillSaved,
  type BooksLineDto,
  type BooksPaymentInput,
  type BooksSplitDto,
  type LoggedChange,
  type StatementMark,
  type ReportLine,
  type WorkspaceExpensesDto,
  type WorkspaceExpensesSavedDto,
} from '@ad/types'
import { ChecksService } from '../checks/checks.service'
import { dueDate } from '../checks/rules'
import { AccessLogService } from '../core/access-log.service'
import { allow, workspaceRole, type Caller } from '../core/caller'
import { changesOf, dollars, howMany, monthName, type Fields } from '../core/changes'
import { DocumentsService, keyInWorkspace, type Uploaded } from '../documents/documents.service'
import { describe } from '../documents/staged-file'
import { readReceipt } from '../receipts/read-receipt'
import { isCardStatement } from '../payroll/card-statement'
import { csvLines, sheetLines } from '../payroll/payroll-details'
import { readStatement } from '../payroll/statement-lines'
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
import type { PlanStatement } from './books-payments'
import type { PlanBillChoice } from './books-receipts'
import { ExpenseMatchingService } from './expense-matching.service'
import {
  SKIP,
  allocationNote,
  planBooks,
  savedBills,
  type PlanEngagement,
  type PlanMapping,
} from './books-plan'

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null)
const CSV = 'text/csv'
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
/** The payroll details files an accounting export can be: the sheets. */
const SHEET_TYPES = [XLSX, CSV]
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/
/** A mapping file's rows are a chart of accounts: a few hundred at most. */
const MAX_ACCOUNTS = 5000
/** Receipts are PDFs or photos, as the month's receipts are (receipts.service.ts). */
const RECEIPT_TYPES = ['application/pdf', 'image/png', 'image/jpeg']
export const MAX_BOOKS_RECEIPTS = 20
const MAX_RECEIPT_BYTES = 10 * 1024 * 1024
/** How many receipts are read at once. */
const READ_AT_ONCE = 4

/** What was read from a receipt, in the access log, by value. */
const RECEIPT_FIELDS: Fields = {
  receiptAmount: { label: 'Amount', show: 'money' },
  receiptDate: { label: 'Date', show: 'date' },
  receiptVendor: { label: 'Vendor', show: 'text' },
}

/** A check the database keeps (a trigger's or a constraint's, SQLSTATE 23514) refused the change. */
const isCheckViolation = (e: unknown) =>
  (e instanceof Prisma.PrismaClientKnownRequestError &&
    (e.meta as { code?: unknown } | undefined)?.code === '23514') ||
  ((e instanceof Prisma.PrismaClientKnownRequestError ||
    e instanceof Prisma.PrismaClientUnknownRequestError) &&
    /\b23514\b/.test(e.message))

/**
 * The database's refusal of a Save, in plain words (review fix, 2026-11-12): a 409 the owner can act on, never a
 * 500. Only the books key's own conflict says the expenses were saved a moment ago; an item number taken meanwhile
 * or a month started meanwhile asks for Save again. A month's lock goes on to `MonthLockedFilter` as it is.
 */
export function saveRefusal(e: unknown): unknown {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
    const target = e.meta?.target
    const on = Array.isArray(target) ? target.join(',') : String(target ?? '')
    if (on.includes('booksKey'))
      return new ConflictException('These expenses were saved a moment ago. Open them again')
    if (on.includes('itemNumber'))
      return new ConflictException('An item number Save chose was taken meanwhile. Save again')
    return new ConflictException('The month changed meanwhile. Open the expenses again')
  }
  if (isCheckViolation(e))
    return new ConflictException(
      "The database refused a line as the books have it now (a budget line that is not its engagement's, say). Open the expenses again, and check the account mappings"
    )
  return e
}

/**
 * The month's expenses from the books (owner's decision, 2026-11-09): read from the accounting export in the month's
 * saved payroll files, routed by class and account (`books-plan.ts`), saved as expense lines of each engagement's month,
 * each marked by its books key so saving again changes it, never adds a second. Separate from the payroll match: it
 * reads the same saved file and writes only lines of its own. Owners save; owners and auditors read.
 */
@Injectable()
export class ExpensesService {
  private readonly logger = new Logger(ExpensesService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly log: AccessLogService,
    private readonly checks: ChecksService,
    private readonly documents: DocumentsService,
    private readonly matching: ExpenseMatchingService,
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

  /**
   * The accounting exports among the month's saved payroll files: each payroll details sheet (xlsx or csv) with books
   * transactions. Payroll details are PDFs too (a pay register, say): those are payroll's, not read here. A sheet that
   * can't be read is left out and named in `unread` (review fix, 2026-11-12), so one bad file leaves the rest.
   */
  private async booksOf(workspaceId: string, period: string) {
    const docs = (
      await this.prisma.document.findMany({
        where: {
          workspaceId,
          engagementId: null,
          period,
          kind: 'payroll-details',
          contentType: { in: SHEET_TYPES },
        },
        orderBy: { fileName: 'asc' },
      })
    ).filter((d) => keyInWorkspace(d))
    const files: { id: string; fileName: string; transactions: BooksTransaction[] }[] = []
    const unread: string[] = []
    for (const d of docs) {
      try {
        const bytes = Buffer.from(await this.storage.read(d.storageKey))
        const lines = d.contentType === CSV ? csvLines(bytes) : await sheetLines(bytes)
        const transactions = booksTransactions(lines)
        if (transactions.length) files.push({ id: d.id, fileName: d.fileName, transactions })
      } catch (e) {
        // The error's kind only: a parser's message can quote the file.
        this.logger.warn(
          `Could not read payroll details ${d.id} for the books (${(e as Error)?.name ?? 'error'})`
        )
        unread.push(d.fileName)
      }
    }
    return { files, unread }
  }

  private async planOf(workspaceId: string, period: string) {
    const [
      { files, unread },
      engagements,
      mappings,
      workspace,
      receipts,
      choices,
      statements,
      matching,
    ] = await Promise.all([
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
      this.receiptsOf(workspaceId, period),
      this.prisma.booksBill.findMany({ where: { workspaceId, period } }),
      this.statementsOf(workspaceId, period),
      this.matching.current(),
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
        booksBills: (x.booksBills ?? null) as BooksBillSaved[] | null,
        booksSplit: (x.booksSplit ?? null) as BooksSplitDto | null,
      })),
      receipts: receipts.map((d) => ({
        id: d.id,
        fileName: d.fileName,
        amount: d.receiptAmount == null ? null : Number(d.receiptAmount),
        date: day(d.receiptDate),
        vendor: d.receiptVendor,
      })),
      choices: choices.map((c): PlanBillChoice => ({
        transactionId: c.transactionId,
        documentId: c.documentId,
        payment:
          c.paymentDocumentId && c.paymentLine
            ? {
                documentId: c.paymentDocumentId,
                ...(c.paymentLine as { page: number; text: string }),
              }
            : null,
        dropped: c.dropped,
      })),
      statements,
      matching,
    })
    return { files, unread, engagements, mappings, lines, existing, receipts, statements }
  }

  /**
   * The statements the bills' payments are found on (owner's decision, 2026-11-12): the month's bank and card
   * statements saved with its payroll (the zip's "Bank & card statements" folder), each read by its own text, never AI,
   * and once though saved twice. A card's is told from a bank's as payroll tells them (`isCardStatement`). A file that
   * can't be read is left out, and its bills show no payment.
   */
  private async statementsOf(workspaceId: string, period: string): Promise<PlanStatement[]> {
    const docs = (
      await this.prisma.document.findMany({
        where: { workspaceId, period, kind: 'bank-statement', contentType: 'application/pdf' },
        orderBy: [{ engagementId: { sort: 'asc', nulls: 'first' } }, { fileName: 'asc' }],
      })
    ).filter((d) => keyInWorkspace(d))
    const seen = new Set<string>()
    const out: PlanStatement[] = []
    for (const d of docs) {
      if (seen.has(d.sha256)) continue
      seen.add(d.sha256)
      try {
        const { lines } = await readStatement(Buffer.from(await this.storage.read(d.storageKey)))
        out.push({ id: d.id, fileName: d.fileName, card: isCardStatement(lines), lines })
      } catch (e) {
        this.logger.warn(`Could not read statement ${d.id} for the bills: ${(e as Error).message}`)
      }
    }
    return out
  }

  /**
   * The receipts the books' bills are matched to (owner's decision, 2026-11-12): the month's financial receipts and
   * invoices, the workspace's own (the zip's "Receipts" folder) and those filed to an engagement's month (emailed, or
   * uploaded there), but not one dismissed or already the proof of a line that is not from the books.
   */
  private async receiptsOf(workspaceId: string, period: string) {
    const docs = await this.prisma.document.findMany({
      where: {
        workspaceId,
        period,
        sensitivity: 'financial',
        kind: { in: [...RECEIPT_KINDS] },
        receiptDismissed: false,
        NOT: { expenses: { some: { purpose: 'invoice', expense: { booksKey: null } } } },
      },
      orderBy: [{ fileName: 'asc' }, { id: 'asc' }],
    })
    return docs.filter((d) => keyInWorkspace(d))
  }

  /**
   * The lines Save wrote before that the books no longer bill there, on a month still a draft: what Save removes, and
   * what the page lists before it does (review fix, 2026-11-12). A month no longer a draft keeps its lines.
   */
  private removable(plan: Awaited<ReturnType<ExpensesService['planOf']>>, period: string) {
    const keys = new Set(plan.lines.filter((l) => l.status === 'billed').map((l) => l.key))
    return plan.existing.filter(
      (x) =>
        x.booksKey?.startsWith(`${period}:`) &&
        !keys.has(x.booksKey) &&
        x.monthlyReport.status === 'draft'
    )
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
      receipts: plan.receipts.map((d) => ({
        documentId: d.id,
        fileName: d.fileName,
        amount: d.receiptAmount == null ? null : Number(d.receiptAmount),
        date: day(d.receiptDate),
        vendor: d.receiptVendor,
        transactionIds: [
          ...new Set(
            plan.lines.flatMap((l) =>
              l.bills.filter((b) => b.receipt?.documentId === d.id).map((b) => b.transactionId)
            )
          ),
        ],
      })),
      toRemove: this.removable(plan, period).map((x) => ({
        id: x.id,
        itemNumber: x.itemNumber,
        vendor: x.vendor,
        amount: Number(x.allocatedAmount),
      })),
      unread: plan.unread,
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
    const byKey = new Map(plan.existing.filter((x) => x.booksKey).map((x) => [x.booksKey!, x]))
    // A line the books now put on another engagement (its program relinked) or in another month (a new export dates
    // it otherwise) is not changed in place, for its row is the other engagement's or month's: it is removed and
    // written afresh, a person's own proofs on it kept (review fix, 2026-11-12).
    const moves = (l: BooksLineDto) => {
      const x = byKey.get(l.key)!
      return x.engagementId !== l.engagementId || x.monthlyReport.period !== l.date.slice(0, 7)
    }
    const changed = billed.filter((l) => l.saved === 'changed')
    const moved = changed.filter(moves)
    const movedRows = moved.map((l) => byKey.get(l.key)!)
    const added = billed.filter((l) => !l.saved)
    const toUpdate = changed.filter((l) => !moves(l))
    const toCreate = [...added, ...moved]
    const toRemove = this.removable(plan, period)
    // A line on a month no longer a draft stays there, as a closed month's lines do: Save moves it nowhere.
    const stuck = movedRows.find((x) => x.monthlyReport.status !== 'draft')
    if (stuck) {
      const e = plan.engagements.find((x) => x.id === stuck.engagementId)
      throw new ConflictException(
        `The books moved line ${stuck.itemNumber} out of ${monthName(stuck.monthlyReport.period)}${e ? ` of ${e.name}` : ''}, which is no longer a draft. Send that month back to a draft to save the expenses`
      )
    }
    if (!toCreate.length && !toUpdate.length && !toRemove.length)
      return {
        created: 0,
        updated: 0,
        removed: 0,
        expenses: this.dto(caller, workspaceId, period, plan),
      }
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
      booksBills: savedBills(l) as unknown as Prisma.InputJsonValue,
      booksSplit: l.split ? (l.split as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
    })
    // The export a transaction is read from (the first, though two exports of the month both have it), and its rows.
    const exportOf = new Map<string, { documentId: string }>()
    for (const f of plan.files)
      for (const t of f.transactions)
        if (!exportOf.has(t.id)) exportOf.set(t.id, { documentId: f.id })
    // The proofs a person attached to a line (`byMatch` false): Save never changes or removes them (review fix,
    // 2026-11-12), as the payroll match never does.
    const personsOf = async (tx: Prisma.TransactionClient, expenseId: string) =>
      new Set(
        (
          await tx.expenseDocument.findMany({
            where: { expenseId, byMatch: false },
            select: { documentId: true },
          })
        ).map((d) => d.documentId)
      )
    // An allocated line's export is its allocation worksheet (owner's decision, 2026-11-12): the rows that charge the
    // shared cost to every program highlighted, its copy opening with the note of them. One the line no longer has goes.
    const linkSplit = async (tx: Prisma.TransactionClient, expenseId: string, l: BooksLineDto) => {
      const from = l.split ? exportOf.get(l.split.transactionId) : undefined
      await tx.expenseDocument.deleteMany({
        where: {
          expenseId,
          purpose: 'allocation',
          byMatch: true,
          document: { kind: 'payroll-details' },
          ...(from ? { documentId: { not: from.documentId } } : {}),
        },
      })
      if (!from || !l.split) return
      if ((await personsOf(tx, expenseId)).has(from.documentId)) return
      // The rows' highlights are drawn from the split itself (BooksSplitDto.at), so the link carries none.
      const data = { purpose: 'allocation', mark: Prisma.DbNull, marks: [], byMatch: true }
      await tx.expenseDocument.upsert({
        where: { expenseId_documentId: { expenseId, documentId: from.documentId } },
        create: { expenseId, documentId: from.documentId, ...data },
        update: data,
      })
    }
    // Each bill's receipt is the line's invoice proof; a receipt Save linked before that no longer proves a bill goes.
    const receiptsOfLine = (l: BooksLineDto) =>
      new Set(l.bills.flatMap((b) => (b.receipt ? [b.receipt.documentId] : [])))
    const linkReceipts = async (
      tx: Prisma.TransactionClient,
      expenseId: string,
      l: BooksLineDto,
      before: BooksBillSaved[] | null
    ) => {
      const want = receiptsOfLine(l)
      const gone = (before ?? [])
        .flatMap((b) => (b.documentId ? [b.documentId] : []))
        .filter((id) => !want.has(id))
      if (gone.length)
        await tx.expenseDocument.deleteMany({
          where: { expenseId, purpose: 'invoice', byMatch: true, documentId: { in: gone } },
        })
      // A receipt a person linked already stays their link (the duplicate is skipped).
      if (want.size)
        await tx.expenseDocument.createMany({
          data: [...want].map((documentId) => ({
            expenseId,
            documentId,
            purpose: 'invoice',
            byMatch: true,
          })),
          skipDuplicates: true,
        })
    }
    // Each bill's payment is the line's proof of payment, its statement linked with the lines marked on it; a statement
    // Save linked before that no longer pays a bill goes.
    const linkPayments = async (
      tx: Prisma.TransactionClient,
      expenseId: string,
      l: BooksLineDto,
      before: BooksBillSaved[] | null
    ) => {
      const want = new Map<string, StatementMark[]>()
      for (const b of l.bills)
        if (b.payment) {
          const { page, x, y, width, height } = b.payment.line
          want.set(b.payment.documentId, [
            ...(want.get(b.payment.documentId) ?? []),
            { page, x, y, width, height },
          ])
        }
      const gone = (before ?? [])
        .flatMap((b) => (b.payment ? [b.payment.documentId] : []))
        .filter((id) => !want.has(id))
      if (gone.length)
        await tx.expenseDocument.deleteMany({
          where: { expenseId, purpose: 'payment', byMatch: true, documentId: { in: gone } },
        })
      const persons = want.size ? await personsOf(tx, expenseId) : new Set<string>()
      for (const [documentId, marks] of want) {
        if (persons.has(documentId)) continue
        const data = {
          purpose: 'payment',
          mark: marks[0]! as unknown as Prisma.InputJsonValue,
          marks: marks.slice(0, 20) as unknown as Prisma.InputJsonValue,
          byMatch: true,
        }
        await tx.expenseDocument.upsert({
          where: { expenseId_documentId: { expenseId, documentId } },
          create: { expenseId, documentId, ...data },
          update: data,
        })
      }
    }
    const at = (engagementId: string, itemNumber: string, reportLine: string) =>
      `${engagementId}\u0000${itemNumber}\u0000${reportLine}`
    let touched: string[]
    try {
      touched = await this.log.change(
        caller,
        async (tx) => {
          // Every month the save writes to or removes from, read here: one closed or submitted since the plan was read
          // refuses the save, so no line of it is lost (review fix, 2026-11-12).
          const pairs = new Map(
            billed.map((l) => [
              `${l.engagementId}\u0000${l.date.slice(0, 7)}`,
              { engagementId: l.engagementId!, period: l.date.slice(0, 7) },
            ])
          )
          const rowMonths = [...new Set([...toRemove, ...movedRows].map((x) => x.monthlyReportId))]
          const reports = await tx.monthlyReport.findMany({
            where: {
              OR: [...pairs.values(), ...(rowMonths.length ? [{ id: { in: rowMonths } }] : [])],
            },
            select: { id: true, engagementId: true, period: true, status: true },
          })
          const locked = reports.find((m) => m.status !== 'draft')
          if (locked)
            throw new ConflictException(
              `${monthName(locked.period)} changed meanwhile. Open the expenses again`
            )
          const months = new Map(reports.map((m) => [`${m.engagementId}\u0000${m.period}`, m.id]))
          const monthOf = async (l: BooksLineDto) => {
            const e = engagementOf.get(l.engagementId!)!
            const p = l.date.slice(0, 7)
            const known = months.get(`${e.id}\u0000${p}`)
            if (known) return known
            const made = await tx.monthlyReport.create({
              data: { engagementId: e.id, period: p, dueDate: dueDate(p, e.reportDueDay) },
            })
            months.set(`${e.id}\u0000${p}`, made.id)
            return made.id
          }
          const taken = new Set(
            (
              await tx.expense.findMany({
                where: { engagementId: { in: [...engagementOf.keys()] } },
                select: { engagementId: true, itemNumber: true, reportLine: true },
              })
            ).map((x) => at(x.engagementId, x.itemNumber, x.reportLine))
          )
          // A line's item number: `QB-` and its transaction, with -2, -3… after it while another line of the engagement
          // and report line has it. `keep` is a line's own number, kept while it is free.
          const numberFor = (l: BooksLineDto, reportLine: string, keep?: string) => {
            if (keep && !taken.has(at(l.engagementId!, keep, reportLine))) return keep
            const root = `QB-${l.transactionId}`.slice(0, 36)
            let itemNumber = root
            for (let k = 2; taken.has(at(l.engagementId!, itemNumber, reportLine)); k++)
              itemNumber = `${root}-${k}`
            return itemNumber
          }
          // A person's proofs on a moved line, kept for the line written afresh.
          const carried = new Map<string, Prisma.ExpenseDocumentCreateManyInput[]>()
          for (const x of movedRows)
            carried.set(
              x.booksKey!,
              (
                await tx.expenseDocument.findMany({ where: { expenseId: x.id, byMatch: false } })
              ).map((d) => ({
                expenseId: '',
                documentId: d.documentId,
                purpose: d.purpose,
                mark: (d.mark ?? Prisma.DbNull) as Prisma.InputJsonValue,
                marks: d.marks as Prisma.InputJsonValue,
                payRun: d.payRun,
                byMatch: false,
              }))
            )
          const ids: string[] = []
          // Removed first: a moved line's books key and item number are free again before it is written afresh.
          for (const x of [...toRemove, ...movedRows]) {
            await tx.expense.delete({ where: { id: x.id } })
            taken.delete(at(x.engagementId, x.itemNumber, x.reportLine))
            ids.push(x.monthlyReportId)
          }
          for (const l of toUpdate) {
            const x = byKey.get(l.key)!
            const f = fields(l)
            // A category mapped to a budget line of another report line: item numbers are the engagement's per report
            // line, so its own is kept when free there and another chosen as a new line's is when not (review fix,
            // 2026-11-12).
            const itemNumber =
              f.reportLine === x.reportLine
                ? x.itemNumber
                : numberFor(l, f.reportLine, x.itemNumber)
            taken.delete(at(x.engagementId, x.itemNumber, x.reportLine))
            taken.add(at(x.engagementId, itemNumber, f.reportLine))
            await tx.expense.update({ where: { id: x.id }, data: { ...f, itemNumber } })
            await linkReceipts(tx, x.id, l, (x.booksBills ?? null) as BooksBillSaved[] | null)
            await linkPayments(tx, x.id, l, (x.booksBills ?? null) as BooksBillSaved[] | null)
            await linkSplit(tx, x.id, l)
            ids.push(x.monthlyReportId)
          }
          for (const l of toCreate) {
            const f = fields(l)
            const itemNumber = numberFor(l, f.reportLine)
            taken.add(at(l.engagementId!, itemNumber, f.reportLine))
            const monthlyReportId = await monthOf(l)
            const made = await tx.expense.create({
              data: {
                ...f,
                engagementId: l.engagementId!,
                monthlyReportId,
                itemNumber,
                booksKey: l.key,
                createdById: caller.userId,
              },
            })
            const kept = carried.get(l.key) ?? []
            if (kept.length)
              await tx.expenseDocument.createMany({
                data: kept.map((d) => ({ ...d, expenseId: made.id })),
                skipDuplicates: true,
              })
            await linkReceipts(tx, made.id, l, null)
            await linkPayments(tx, made.id, l, null)
            await linkSplit(tx, made.id, l)
            ids.push(monthlyReportId)
          }
          return [...new Set(ids)]
        },
        {
          workspaceId,
          resource: 'expense',
          action: 'create',
          description: `Saved the books' expenses for ${monthName(period)}: ${howMany(added.length, 'line')} added, ${howMany(changed.length, 'line')} changed, ${howMany(toRemove.length, 'line')} removed`,
          changes: [
            { field: 'Added', after: String(added.length) },
            { field: 'Changed', after: String(changed.length) },
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
      throw saveRefusal(e)
    }
    for (const id of touched) await this.checks.refresh(id)
    return {
      created: added.length,
      updated: changed.length,
      removed: toRemove.length,
      expenses: this.dto(caller, workspaceId, period, await this.planOf(workspaceId, period)),
    }
  }

  // ── The bills' receipts (owner's decision, 2026-11-12) ────────────────────

  /**
   * Receipts for the month's bills (the zip's "Receipts" folder, or one bill's "Attach receipt"): each checked as any
   * upload is, read by the PDF's own text (never AI), and kept as a receipt of the workspace's month, filed to no
   * engagement, one line each. Given `transactionId`, the one receipt is that bill's, by the owner's word. A file the
   * month has already (the same contents) is not kept twice. Nothing is billed until Save.
   */
  async addReceipts(
    caller: Caller,
    workspaceId: string,
    given: unknown,
    files: Uploaded[] | undefined,
    transactionId?: unknown
  ): Promise<WorkspaceExpensesDto> {
    this.owner(caller, workspaceId)
    const period = this.period(given)
    if (!Array.isArray(files) || !files.length)
      throw new BadRequestException('Choose at least one receipt')
    if (files.length > MAX_BOOKS_RECEIPTS)
      throw new BadRequestException(`Send at most ${MAX_BOOKS_RECEIPTS} receipts at a time`)
    const bill = transactionId == null || transactionId === '' ? null : transactionId
    if (bill !== null && (typeof bill !== 'string' || bill.length > 100))
      throw new BadRequestException('Name the bill by its transaction')
    if (bill !== null && files.length !== 1)
      throw new BadRequestException('Choose one receipt for the bill')
    if (
      bill !== null &&
      !(await this.planOf(workspaceId, period)).lines.some((l) =>
        l.bills.some((b) => b.transactionId === bill)
      )
    )
      throw new NotFoundException('No such bill among the month’s lines')
    for (const f of files) {
      if (!RECEIPT_TYPES.includes(f.mimetype))
        throw new BadRequestException(`${f.originalname}: receipts must be PDF, PNG or JPG files`)
      if (f.size > MAX_RECEIPT_BYTES)
        throw new BadRequestException(`${f.originalname}: receipts are limited to 10 MB each`)
    }
    const have = await this.prisma.document.findMany({
      where: { workspaceId, engagementId: null, period, kind: { in: [...RECEIPT_KINDS] } },
      select: { id: true, sha256: true },
    })
    const shaOf = (f: Uploaded) => createHash('sha256').update(f.buffer).digest('hex')
    const known = new Map(have.map((d) => [d.sha256, d.id]))
    const ids: string[] = []
    const fresh: Uploaded[] = []
    for (const f of files) {
      const id = known.get(shaOf(f))
      if (id) ids.push(id)
      else if (!fresh.some((o) => shaOf(o) === shaOf(f))) fresh.push(f)
    }
    const staged = []
    for (const f of fresh)
      staged.push(await this.documents.stage(caller, f, { workspaceId, period, kind: 'receipt' }))
    const reads: Awaited<ReturnType<typeof readReceipt>>[] = []
    for (let i = 0; i < staged.length; i += READ_AT_ONCE)
      reads.push(
        ...(await Promise.all(
          staged.slice(i, i + READ_AT_ONCE).map((s, j) =>
            readReceipt(
              {
                buffer: fresh[i + j]!.buffer,
                contentType: s.data.contentType,
                sensitivity: s.data.sensitivity,
              },
              false
            )
          )
        ))
      )
    for (const [i, s] of staged.entries()) {
      const read = reads[i]!
      Object.assign(s.data, {
        receiptAmount: read.amount == null ? null : read.amount.toFixed(2),
        receiptDate: read.date ? new Date(`${read.date}T00:00:00Z`) : null,
        receiptVendor: read.vendor,
        receiptReadBy: read.readBy,
      })
      const made = await s.commit(() =>
        this.log.change(
          caller,
          (tx) => s.create(tx),
          (d) => ({
            workspaceId,
            resource: 'document',
            subjectId: d.id,
            action: 'create',
            description: `Uploaded ${describe(d)} for the books' bills`,
            changes: changesOf(null, d, RECEIPT_FIELDS),
          })
        )
      )
      ids.push(made.id)
    }
    if (bill !== null)
      await this.choose(caller, workspaceId, period, bill, { documentId: ids[0]!, dropped: false })
    return this.dto(caller, workspaceId, period, await this.planOf(workspaceId, period))
  }

  /**
   * An owner's word on one bill: the receipt that proves it (`documentId`; null: as matched), or dropped for want of
   * one (its share comes off the lines that bill it at the next Save), or neither again.
   */
  async setBill(
    caller: Caller,
    workspaceId: string,
    input: BooksBillInput
  ): Promise<WorkspaceExpensesDto> {
    this.owner(caller, workspaceId)
    const period = this.period(input?.period)
    const bill = input?.transactionId
    if (typeof bill !== 'string' || !bill || bill.length > 100)
      throw new BadRequestException('Name the bill by its transaction')
    const dropped = input.dropped ?? false
    if (typeof dropped !== 'boolean') throw new BadRequestException('dropped must be true or false')
    const documentId = input.documentId ?? null
    if (documentId !== null && typeof documentId !== 'string')
      throw new BadRequestException('Choose one of the month’s receipts')
    if (dropped && documentId) throw new BadRequestException('A bill with a receipt is not dropped')
    const plan = await this.planOf(workspaceId, period)
    if (!plan.lines.some((l) => l.bills.some((b) => b.transactionId === bill)))
      throw new NotFoundException('No such bill among the month’s lines')
    if (documentId && !plan.receipts.some((d) => d.id === documentId))
      throw new BadRequestException('Choose one of the month’s receipts')
    await this.choose(caller, workspaceId, period, bill, { documentId, dropped })
    return this.dto(caller, workspaceId, period, await this.planOf(workspaceId, period))
  }

  /**
   * One of the month's receipts as uploaded, to view on the Expense matching step (owner's decision, 2026-11-13: each
   * bill's receipt opens from its row, as payroll's proofs do). Owners and auditors. Logged.
   */
  async receiptFile(
    caller: Caller,
    workspaceId: string,
    period: unknown,
    documentId: string
  ): Promise<{ bytes: Uint8Array; contentType: string; fileName: string }> {
    this.reader(caller, workspaceId)
    const p = this.period(period)
    const doc = await this.prisma.document.findFirst({
      where: {
        id: documentId,
        workspaceId,
        period: p,
        sensitivity: 'financial',
        kind: { in: [...RECEIPT_KINDS] },
      },
    })
    if (!doc || !keyInWorkspace(doc)) throw new NotFoundException()
    const bytes = await this.storage.read(doc.storageKey)
    await this.log.log(caller, {
      workspaceId,
      resource: 'document',
      subjectId: doc.id,
      action: 'read',
      description: `Opened the receipt ${doc.fileName} from the books' expenses for ${monthName(p)}`,
    })
    return { bytes: new Uint8Array(bytes), contentType: doc.contentType, fileName: doc.fileName }
  }

  /**
   * An owner's word on one bill's payment: the line of the month's statements that paid it (one of the bill's
   * choices), or null to match it again. A dropped bill has none.
   */
  async setPayment(
    caller: Caller,
    workspaceId: string,
    input: BooksPaymentInput
  ): Promise<WorkspaceExpensesDto> {
    this.owner(caller, workspaceId)
    const period = this.period(input?.period)
    const bill = input?.transactionId
    if (typeof bill !== 'string' || !bill || bill.length > 100)
      throw new BadRequestException('Name the bill by its transaction')
    const given = input.payment ?? null
    if (
      given !== null &&
      (typeof given !== 'object' ||
        typeof given.documentId !== 'string' ||
        typeof given.text !== 'string' ||
        given.text.length > 2000 ||
        !Number.isInteger(given.page))
    )
      throw new BadRequestException('Choose one of the statement lines')
    const plan = await this.planOf(workspaceId, period)
    const found = plan.lines.flatMap((l) => l.bills).find((b) => b.transactionId === bill)
    if (!found) throw new NotFoundException('No such bill among the month’s lines')
    if (given && found.dropped) throw new BadRequestException('A dropped bill has no payment')
    if (
      given &&
      !found.paymentChoices.some(
        (p) =>
          p.documentId === given.documentId &&
          p.line.page === given.page &&
          p.line.text === given.text
      ) &&
      !(
        found.payment?.documentId === given.documentId &&
        found.payment.line.page === given.page &&
        found.payment.line.text === given.text
      )
    )
      throw new BadRequestException('Choose one of the statement lines')
    await this.choose(caller, workspaceId, period, bill, {
      payment: given ? { documentId: given.documentId, page: given.page, text: given.text } : null,
    })
    return this.dto(caller, workspaceId, period, await this.planOf(workspaceId, period))
  }

  /**
   * Keeps an owner's word on a bill: what `change` gives (its receipt, its payment, dropped), the rest as it was. A
   * dropped bill keeps neither its receipt nor its payment; a bill back to as matched keeps no row.
   */
  private async choose(
    caller: Caller,
    workspaceId: string,
    period: string,
    transactionId: string,
    change: {
      documentId?: string | null
      dropped?: boolean
      payment?: { documentId: string; page: number; text: string } | null
    }
  ) {
    const where = { workspaceId_period_transactionId: { workspaceId, period, transactionId } }
    const before = await this.prisma.booksBill.findUnique({ where })
    const dropped = change.dropped ?? before?.dropped ?? false
    const documentId = dropped
      ? null
      : change.documentId !== undefined
        ? change.documentId
        : (before?.documentId ?? null)
    const was =
      before?.paymentDocumentId && before.paymentLine
        ? {
            documentId: before.paymentDocumentId,
            ...(before.paymentLine as { page: number; text: string }),
          }
        : null
    const payment = dropped ? null : change.payment !== undefined ? change.payment : was
    const same = (a: typeof payment, b: typeof payment) =>
      (!a && !b) ||
      (!!a && !!b && a.documentId === b.documentId && a.page === b.page && a.text === b.text)
    if (
      (before?.documentId ?? null) === documentId &&
      (before?.dropped ?? false) === dropped &&
      same(was, payment)
    )
      return
    const data = {
      documentId,
      dropped,
      paymentDocumentId: payment?.documentId ?? null,
      paymentLine: payment
        ? ({ page: payment.page, text: payment.text } as Prisma.InputJsonValue)
        : Prisma.DbNull,
      changedById: caller.userId,
      changedAt: new Date(),
    }
    const what = `bill ${transactionId} of the books for ${monthName(period)}`
    // What the owner's word changed, field by field (review fix, 2026-11-12). The receipt and statement by id; the
    // statement's line as the statement prints it.
    const changes: LoggedChange[] = []
    if ((before?.documentId ?? null) !== documentId)
      changes.push({ field: 'Receipt', before: before?.documentId ?? null, after: documentId })
    if (!same(was, payment))
      changes.push(
        {
          field: 'Payment statement',
          before: was?.documentId ?? null,
          after: payment?.documentId ?? null,
        },
        {
          field: 'Payment line',
          before: was ? was.text.slice(0, 200) : null,
          after: payment ? payment.text.slice(0, 200) : null,
        }
      )
    if ((before?.dropped ?? false) !== dropped)
      changes.push({
        field: 'Dropped',
        before: before?.dropped ? 'Yes' : 'No',
        after: dropped ? 'Yes' : 'No',
      })
    await this.log.change(
      caller,
      async (tx) => {
        if (documentId === null && !dropped && !payment) {
          await tx.booksBill.deleteMany({ where: { workspaceId, period, transactionId } })
          return { id: before?.id ?? null }
        }
        const row = await tx.booksBill.upsert({
          where,
          create: { ...data, workspaceId, period, transactionId },
          update: data,
        })
        return { id: row.id }
      },
      (row) => ({
        workspaceId,
        resource: 'expense',
        subjectId: row.id,
        action: 'update',
        changes,
        description:
          change.dropped === true
            ? `Dropped ${what} for want of its receipt or payment`
            : change.payment !== undefined
              ? change.payment
                ? `Chose the payment of ${what}`
                : `Left the payment of ${what} to be matched again`
              : documentId
                ? `Chose the receipt of ${what}`
                : `Left ${what} to be matched again`,
      })
    )
  }
}
