import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { createHash } from 'node:crypto'
import {
  IMPORT_FIELD_LABELS,
  IMPORT_FIELDS,
  IMPORT_SKIP,
  REPORT_STATUS_LABELS,
  WRITE_ROLES,
  type BudgetOption,
  type ImportCategories,
  type ImportColumns,
  type ImportFileDto,
  type ImportMappingDto,
  type ImportPreviewDto,
  type ImportRequest,
  type ImportResultDto,
  type ImportRowDto,
  type ImportSuggestionDto,
  type ReportLine,
  type ReportStatus,
  PAYROLL_BUDGET_KIND_LABELS,
  type ImportPayrollRowDto,
  type PayrollBudgetKind,
} from '@ad/types'
import { payrollRowKind } from '../reports/report-lines'
import { ChecksService } from '../checks/checks.service'
import { dueDate } from '../checks/rules'
import { AccessLogService } from '../core/access-log.service'
import { allow, tenantWhere, workspaceRole, type Caller } from '../core/caller'
import { dollars, howMany, monthName } from '../core/changes'
import { EngagementsService } from '../engagements/engagements.service'
import { PrismaService } from '../prisma/prisma.service'
import { ReportsService } from '../reports/reports.service'
import { aiConfigured, aiGuessColumns } from './ai-guess'
import {
  cleanCategories,
  cleanColumns,
  cleanLines,
  matchItem,
  fingerprintsOf,
  guessColumns,
  transactionsOf,
  type Transaction,
} from './mapping'
import { headerKey, readTable, type Table } from './table'

/** The file as the controller hands it over (multer's memory storage). */
export type ImportFile = { originalname: string; buffer: Buffer }

/** A row that will become an expense line. */
type Ready = Transaction & {
  date: string
  amount: number
  period: string
  itemNumber: string
  reportLine: ReportLine
  budgetLineId: string
  fingerprint: string
  /** A payroll transaction's kind: kept for payroll reconciliation, counted only until the match covers it. */
  payrollKind?: PayrollBudgetKind | null
}

/** A line imported before whose payroll choice this import changes. */
type Update = ImportRowDto & {
  expenseId: string
  payrollKind: PayrollBudgetKind | null
  budgetLineId: string
  change: string
}

type Engagement = NonNullable<Awaited<ReturnType<ImportsService['find']>>>

const isoDate = (d: Date) => d.toISOString().slice(0, 10)
const sameHeaders = (a: string[], b: string[]) =>
  a.length === b.length && a.map(headerKey).sort().join('\n') === b.map(headerKey).sort().join('\n')

/**
 * Importing transactions from a file the team exports (a QuickBooks report, or another CSV or Excel file) into an
 * engagement's ledger. The file is read in memory on each call and never stored: read it (columns and a first guess
 * at the mapping), preview it through the mapping the person confirmed, then import it. Each row becomes an expense
 * line in the month of its date, through the same checks as a typed one. Owners and bookkeepers only.
 */
/**
 * A payroll row of an accounting export: salaries, payroll taxes, employee benefits or work-experience pay, by its
 * account or category. Payroll fees and workers' compensation are bills, not pay, and are imported.
 */
export const isPayrollRow = (t: Pick<Transaction, 'accountText' | 'category'>) =>
  /\bsalar|\bwages?\b|payroll tax|employee benefit|work experience|\bwex\b/i.test(
    `${t.accountText} ${t.category}`
  )

/** A books' payroll transaction's kind (report-lines.ts) as the budget line ticks name it. */
const PAYROLL_KIND_OF = {
  staffPay: 'staff-pay',
  staffTaxes: 'staff-taxes',
  participantPay: 'participant-pay',
  participantTaxes: 'participant-taxes',
} as const satisfies Record<ReturnType<typeof payrollRowKind>, PayrollBudgetKind>

/** The person's answers on "Payroll transactions confirmation": yes or no, by line in the file. */
function cleanPayroll(given: unknown): Record<string, boolean> {
  if (!given || typeof given !== 'object' || Array.isArray(given)) return {}
  return Object.fromEntries(
    Object.entries(given as Record<string, unknown>).filter(
      (e): e is [string, boolean] => /^\d+$/.test(e[0]) && typeof e[1] === 'boolean'
    )
  )
}

@Injectable()
export class ImportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly checks: ChecksService,
    private readonly log: AccessLogService,
    private readonly engagements: EngagementsService,
    private readonly reports: ReportsService
  ) {}

  private find(caller: Caller, engagementId: string) {
    return this.prisma.engagement.findFirst({
      where: { id: engagementId, ...tenantWhere(caller) },
      include: {
        workspace: true,
        budgetLines: true,
        monthlyReports: { select: { id: true, period: true, status: true } },
      },
    })
  }

  /** The engagement, if the caller may import into it: another workspace's is a 404, an auditor's a 403. */
  private async writable(caller: Caller, engagementId: string): Promise<Engagement> {
    const c = await this.find(caller, engagementId)
    if (!c) throw new NotFoundException()
    allow(
      workspaceRole(caller, c.workspaceId, WRITE_ROLES),
      'Only an owner or bookkeeper imports transactions'
    )
    return c
  }

  /**
   * The engagement's budget lines a category may map to (`key` is the line's id), payroll lines left out: an import is
   * money paid out to vendors, as Add expense is; payroll goes through Add payroll.
   */
  private options(c: Engagement): BudgetOption[] {
    return [...c.budgetLines]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((b) => ({ key: b.id, label: b.name, reportLine: b.reportLine as ReportLine }))
  }

  /**
   * A saved mapping names budget lines by their name, so it carries to another engagement whose lines are named the
   * same. Anything else is left for the person to choose.
   */
  private lineFor(c: Engagement, saved: string): string | null {
    if (saved === IMPORT_SKIP) return IMPORT_SKIP
    return this.options(c).find((o) => o.label.toLowerCase() === saved.toLowerCase())?.key ?? null
  }

  /** Step 1: the file's columns, a few rows, the saved mappings, and the first guess at the mapping. */
  async read(caller: Caller, engagementId: string, file: ImportFile): Promise<ImportFileDto> {
    const c = await this.writable(caller, engagementId)
    const table = await readTable(file.buffer, file.originalname)
    const saved = await this.prisma.importMapping.findMany({
      where: { workspaceId: c.workspaceId },
      orderBy: { updatedAt: 'desc' },
    })
    // A saved mapping may come from another engagement: its category choices for budget lines this one does not have
    // are left out, so those categories wait for the person in step 3 instead of refusing the import.
    const mappings: ImportMappingDto[] = saved.map((m) => ({
      id: m.id,
      name: m.name,
      headers: m.headers,
      columns: m.columns as ImportColumns,
      categories: Object.fromEntries(
        Object.entries(m.categories as ImportCategories)
          .map(([from, to]) => [from, this.lineFor(c, to)] as const)
          .filter((e): e is readonly [string, string] => e[1] !== null)
      ),
      matches: sameHeaders(m.headers, table.headers),
    }))
    const match = mappings.find((m) => m.matches)
    // By rules only: AI is asked only when the person presses "Suggest the mapping with AI" (suggest below).
    return {
      fileName: file.originalname,
      headers: table.headers,
      sample: table.rows.slice(0, 5).map((r) => r.cells),
      rowCount: table.rows.length,
      guess: match ? match.columns : guessColumns(table),
      guessedBy: match ? 'saved' : 'headers',
      aiAvailable: aiConfigured() && table.headerFound,
      mappings,
      mappingId: match?.id ?? null,
      budgetOptions: this.options(c),
    }
  }

  /**
   * "Suggest the mapping with AI", pressed by the person on the Columns step: the file's column names (never a row) go
   * to the model, and its answer fills the selects for the person to check. Refused when the file has no row of column
   * names (a row that may be a transaction is never sent); null when the server has no key or the model had nothing.
   */
  async suggest(
    caller: Caller,
    engagementId: string,
    file: ImportFile
  ): Promise<ImportSuggestionDto> {
    await this.writable(caller, engagementId)
    const table = await readTable(file.buffer, file.originalname)
    if (!table.headerFound)
      throw new BadRequestException('This file has no row of column names for AI to read')
    return { columns: await aiGuessColumns(table.headers) }
  }

  /** Steps 2 to 4: the file through the mapping, row by row: where each goes, or why it stays out. */
  async preview(
    caller: Caller,
    engagementId: string,
    file: ImportFile,
    request: unknown
  ): Promise<ImportPreviewDto> {
    const c = await this.writable(caller, engagementId)
    const table = await readTable(file.buffer, file.originalname)
    return (await this.plan(c, table, request)).preview
  }

  /**
   * Step 5: imports the rows the preview said are ready, in one transaction with one line in the access log: the
   * months they need are started as drafts, and every row becomes an expense line (all of it charged to this program,
   * a direct cost). The checks of each month touched then run again.
   */
  async import(
    caller: Caller,
    engagementId: string,
    file: ImportFile,
    request: unknown
  ): Promise<ImportResultDto> {
    const c = await this.writable(caller, engagementId)
    const table = await readTable(file.buffer, file.originalname)
    const { preview, ready, updates, columns, categories } = await this.plan(c, table, request)
    const req = (request ?? {}) as ImportRequest
    const reportId = typeof req.reportId === 'string' ? req.reportId : null
    if (reportId && !c.monthlyReports.some((m) => m.id === reportId)) throw new NotFoundException()
    if (ready.length === 0 && updates.length === 0)
      throw new BadRequestException('Nothing to import: every row is listed under Not imported')
    if (req.saveAs != null) await this.save(caller, c, req.saveAs, table, columns, categories)

    // Never the file's name (it may name a person): the SHA-256 below identifies the file.
    const source = /\.xlsx$/i.test(file.originalname) ? 'an Excel file' : 'a CSV file'
    // The person's yes to AI, on record: only when they asked and this server could have asked the model.
    const withAi = req.aiSuggested === true && aiConfigured() ? ', columns suggested with AI' : ''
    const total = ready.reduce((t, r) => t + r.amount, 0)
    const started = preview.months.filter((m) => m.isNew).map((m) => m.period)
    let touched: string[]
    try {
      touched = await this.log.change(
        caller,
        async (tx) => {
          const ids = new Map(c.monthlyReports.map((m) => [m.period, m.id]))
          // A month closed since the preview is not written to.
          const locked = await tx.monthlyReport.findFirst({
            where: {
              engagementId: c.id,
              period: { in: preview.months.map((m) => m.period) },
              status: { not: 'draft' },
            },
          })
          if (locked)
            throw new ConflictException(
              `${monthName(locked.period)} changed since the preview. Preview the file again`
            )
          for (const period of started) {
            const made = await tx.monthlyReport.create({
              data: { engagementId: c.id, period, dueDate: dueDate(period, c.reportDueDay) },
            })
            ids.set(period, made.id)
          }
          // Lines imported before whose payroll choice changed: that line, not a second one.
          for (const u of updates)
            await tx.expense.update({
              where: { id: u.expenseId },
              data: { payrollKind: u.payrollKind, budgetLineId: u.budgetLineId },
            })
          if (ready.length)
            await tx.expense.createMany({
              data: ready.map((r) => ({
                engagementId: c.id,
                monthlyReportId: ids.get(r.period)!,
                itemNumber: r.itemNumber,
                date: new Date(`${r.date}T00:00:00Z`),
                vendor: r.vendor,
                memo: r.memo || null,
                account: r.account,
                totalCost: r.amount.toFixed(2),
                allocatedAmount: r.amount.toFixed(2),
                allocationType: 'direct',
                budgetLineId: r.budgetLineId,
                reportLine: r.reportLine,
                importFingerprint: r.fingerprint,
                payrollKind: r.payrollKind ?? null,
                createdById: caller.userId,
              })),
            })
          return [
            ...preview.months.map((m) => ids.get(m.period)!),
            ...updates.map((u) => ids.get(u.period!)).filter((id): id is string => !!id),
          ]
        },
        {
          workspaceId: c.workspaceId,
          resource: 'expense',
          subjectId: c.id,
          action: 'create',
          description: `Imported ${howMany(ready.length, 'transaction')} into ${c.name} from ${source}: ${howMany(preview.months.length, 'month')}${updates.length ? `, ${howMany(updates.length, 'line')} imported before changed (payroll or expense)` : ''}${withAi}`,
          // Counts and totals, not every row: each line is on its month's page.
          changes: [
            { field: 'Transactions', after: String(ready.length) },
            { field: 'Total', after: total.toFixed(2) },
            ...preview.months.map((m) => ({
              field: monthName(m.period),
              after: `${howMany(m.rows, 'transaction')}, ${dollars(m.total)}${m.isNew ? ' (month started)' : ''}`,
            })),
            ...(ready.some((r) => r.payrollKind)
              ? [
                  {
                    field: 'Payroll transactions',
                    after: String(ready.filter((r) => r.payrollKind).length),
                  },
                ]
              : []),
            { field: 'Not imported', after: String(preview.notImported.length) },
            { field: 'File size (bytes)', after: String(file.buffer.length) },
            {
              field: 'File SHA-256',
              after: createHash('sha256').update(file.buffer).digest('hex'),
            },
          ],
        }
      )
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
        throw new ConflictException(
          'Some of these rows were imported a moment ago. Preview the file again'
        )
      throw e
    }
    for (const id of new Set(touched)) await this.checks.refresh(id)
    return {
      imported: ready.length,
      updated: updates.length,
      total: Math.round(total * 100) / 100,
      months: preview.months,
      notImported: preview.notImported.length,
      engagement: await this.engagements.detail(caller, c.id),
      report: reportId ? await this.reports.fresh(caller, reportId) : null,
    }
  }

  /** Saves the mapping on the workspace under `name`, or changes the one of that name: one line either way. */
  private async save(
    caller: Caller,
    c: Engagement,
    given: unknown,
    table: Table,
    columns: ImportColumns,
    categories: ImportCategories
  ) {
    const name = typeof given === 'string' ? given.trim() : ''
    if (!name) throw new BadRequestException('Name the mapping to save it')
    if (name.length > 60) throw new BadRequestException('Keep the mapping name under 60 characters')
    // Saved by the budget lines' names, not this engagement's ids, so the mapping carries to another engagement.
    const names = new Map(this.options(c).map((o) => [o.key, o.label]))
    const byName = Object.fromEntries(
      Object.entries(categories).map(([from, to]) => [from, names.get(to) ?? to])
    )
    const data = {
      headers: table.headers,
      columns: columns as Prisma.InputJsonValue,
      categories: byName as Prisma.InputJsonValue,
    }
    const columnWords = IMPORT_FIELDS.filter((f) => columns[f])
      .map((f) => `${IMPORT_FIELD_LABELS[f]}: ${columns[f]}`)
      .join(', ')
    await this.log.change(
      caller,
      async (tx) => {
        const before = await tx.importMapping.findFirst({
          where: { workspaceId: c.workspaceId, name },
        })
        const row = before
          ? await tx.importMapping.update({ where: { id: before.id }, data })
          : await tx.importMapping.create({
              data: { workspaceId: c.workspaceId, name, createdById: caller.userId, ...data },
            })
        return { ...row, updated: !!before }
      },
      (row) => ({
        workspaceId: c.workspaceId,
        resource: 'workspace',
        subjectId: row.id,
        action: row.updated ? 'update' : 'create',
        description: `${row.updated ? 'Changed' : 'Saved'} the import mapping ${name}`,
        changes: [
          { field: 'Columns', after: columnWords.slice(0, 1000) },
          {
            field: 'Categories',
            after: `${howMany(Object.keys(categories).length, 'category', 'categories')} mapped`,
          },
        ],
      })
    )
  }

  /** The file through the mapping: each row ready (with its month, item number and report line) or left out, and why. */
  private async plan(c: Engagement, table: Table, request: unknown) {
    if (!c.periodStart || !c.periodEnd)
      throw new BadRequestException('Set the contract period (step 4) before importing')
    const req = (request ?? {}) as Partial<ImportRequest>
    const columns = cleanColumns(req.columns, table.headers)
    const items = new Map(this.options(c).map((i) => [i.key, i]))
    const categories = cleanCategories(req.categories, new Set(items.keys()))
    const lines = cleanLines(req.lines, new Set(items.keys()))
    const start = isoDate(c.periodStart)
    const end = isoDate(c.periodEnd)
    const months = new Map(c.monthlyReports.map((m) => [m.period, m]))
    const existing = await this.prisma.expense.findMany({
      where: { engagementId: c.id },
      select: {
        id: true,
        itemNumber: true,
        reportLine: true,
        importFingerprint: true,
        payrollKind: true,
      },
    })
    const imported = new Map(
      existing.filter((e) => e.importFingerprint).map((e) => [e.importFingerprint!, e])
    )
    const taken = new Set(existing.map((e) => `${e.itemNumber}\u0000${e.reportLine}`))
    const numbers = new Set(existing.map((e) => e.itemNumber))
    let next = 1

    const ready: Ready[] = []
    const notImported: ImportRowDto[] = []
    const payroll: ImportPayrollRowDto[] = []
    const updates: Update[] = []
    const payrollAnswers = cleanPayroll(req.payroll)
    const assignable: ImportPreviewDto['assignable'] = []
    const byCategory = new Map<string, { rows: number; total: number }>()
    const dto = (t: Transaction, extra: Partial<ImportRowDto>): ImportRowDto => ({
      line: t.line,
      date: t.date,
      vendor: t.vendor,
      memo: t.memo,
      amount: t.amount,
      category: t.category,
      period: t.date ? t.date.slice(0, 7) : null,
      ...extra,
    })

    const transactions = transactionsOf(table, columns)
    const prints = fingerprintsOf(transactions)
    for (const [i, t] of transactions.entries()) {
      const out = (reason: string) => notImported.push(dto(t, { reason }))
      if (!t.date && !t.vendor) {
        out('A heading or total line, not a transaction')
        continue
      }
      // "Payroll transactions confirmation": a payroll row (by its account or category, or the person's answer) goes to
      // the budget line ticked for its kind, marked payroll; the rest are matched to budget lines by category.
      const found = isPayrollRow(t)
      const asked = payrollAnswers[String(t.line)]
      const isPayroll = asked ?? found
      const kind =
        PAYROLL_KIND_OF[payrollRowKind({ account: t.accountText, memo: `${t.memo} ${t.category}` })]
      const payrollLine = c.budgetLines.find((b) => (b.payroll ?? []).includes(kind)) ?? null
      if (found || asked !== undefined)
        payroll.push({
          ...dto(t, {}),
          account: t.account,
          found,
          included: isPayroll,
          kind,
          budgetLineName: payrollLine?.name ?? null,
        })
      if (!isPayroll) {
        const seen = byCategory.get(t.category) ?? { rows: 0, total: 0 }
        byCategory.set(t.category, { rows: seen.rows + 1, total: seen.total + (t.amount ?? 0) })
      }
      if (!t.date) {
        out('No date this import can read')
        continue
      }
      if (t.amountUnreadable) {
        out(
          'The amount cannot be read: write it like 1,234.50 (no comma after the dot, at most two decimals)'
        )
        continue
      }
      if (t.amount == null || t.amount === 0) {
        out('No amount')
        continue
      }
      if (t.amount < 0) {
        out('A negative amount (a refund or credit): enter it by hand if it belongs')
        continue
      }
      if (t.amount >= 1e10) {
        out('The amount is too large')
        continue
      }
      if (!t.vendor) {
        out('No payee or vendor')
        continue
      }
      if (t.date < start || t.date > end) {
        out(`Outside the contract period (${start} to ${end})`)
        continue
      }
      const period = t.date.slice(0, 7)
      const month = months.get(period)
      if (month && month.status !== 'draft') {
        out(
          month.status === 'closed'
            ? `The month-end closing of ${monthName(period)} is approved; send it back to add lines`
            : `${monthName(period)} is ${REPORT_STATUS_LABELS[month.status as ReportStatus] ?? month.status}; only a draft month takes new lines`
        )
        continue
      }
      const fingerprint = prints[i]!
      // Imported before: skipped, unless its payroll choice is different now, which changes that line (the person's
      // re-import is how a choice is corrected, owner's decision, 2026-10-20).
      const before = imported.get(fingerprint)
      const wanted = isPayroll ? kind : null
      if (before && (before.payrollKind ?? null) === wanted) {
        out('Already imported')
        continue
      }
      if (isPayroll && !payrollLine) {
        out(`Payroll: no budget line has "${PAYROLL_BUDGET_KIND_LABELS[kind]}" ticked`)
        continue
      }
      const target = isPayroll ? payrollLine!.id : (lines[String(t.line)] ?? categories[t.category])
      if (!isPayroll)
        assignable.push({
          ...dto(t, {}),
          budgetItem: target && target !== IMPORT_SKIP ? target : null,
        })
      if (!target) {
        out(`Choose a budget line for ${t.category ? `"${t.category}"` : 'rows with no category'}`)
        continue
      }
      if (target === IMPORT_SKIP) {
        out('Skipped: its category is set to skip')
        continue
      }
      const reportLine = isPayroll
        ? (payrollLine!.reportLine as ReportLine)
        : items.get(target)!.reportLine
      const budgetLineId = target
      if (before) {
        updates.push({
          ...dto(t, { itemNumber: before.itemNumber }),
          expenseId: before.id,
          payrollKind: wanted,
          budgetLineId,
          change: wanted
            ? `Now payroll (${PAYROLL_BUDGET_KIND_LABELS[wanted]}), kept for payroll reconciliation`
            : 'Now an expense, not payroll',
        })
        continue
      }
      let itemNumber: string
      if (t.reference) {
        itemNumber = t.reference
        for (let k = 2; taken.has(`${itemNumber}\u0000${reportLine}`); k++)
          itemNumber = `${t.reference.slice(0, 35)}-${k}`
      } else {
        while (numbers.has(`IMP-${next}`)) next++
        itemNumber = `IMP-${next}`
      }
      taken.add(`${itemNumber}\u0000${reportLine}`)
      numbers.add(itemNumber)
      ready.push({
        ...t,
        date: t.date,
        amount: t.amount,
        period,
        itemNumber,
        reportLine,
        budgetLineId,
        fingerprint,
        payrollKind: isPayroll ? kind : null,
      })
    }

    const perMonth = new Map<string, { rows: number; total: number }>()
    for (const r of ready) {
      const m = perMonth.get(r.period) ?? { rows: 0, total: 0 }
      perMonth.set(r.period, { rows: m.rows + 1, total: m.total + r.amount })
    }
    const round = (n: number) => Math.round(n * 100) / 100
    const preview: ImportPreviewDto = {
      categories: [...byCategory]
        .map(([value, s]) => ({
          value,
          rows: s.rows,
          total: round(s.total),
          match: columns.category ? matchItem(value, [...items.values()]) : null,
        }))
        .sort((a, b) => a.value.localeCompare(b.value)),
      months: [...perMonth]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([period, s]) => ({
          period,
          isNew: !months.has(period),
          rows: s.rows,
          total: round(s.total),
        })),
      rows: ready.map((r) =>
        dto(r, { period: r.period, itemNumber: r.itemNumber, reportLine: r.reportLine })
      ),
      notImported,
      payroll,
      updates: updates.map((u) => ({
        line: u.line,
        date: u.date,
        vendor: u.vendor,
        memo: u.memo,
        amount: u.amount,
        category: u.category,
        period: u.period,
        itemNumber: u.itemNumber,
        change: u.change,
      })),
      assignable,
    }
    return { preview, ready, updates, columns, categories }
  }
}
