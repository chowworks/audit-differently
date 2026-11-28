import { createHash, randomUUID } from 'node:crypto'
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common'
import {
  PAYROLL_BUDGET_KINDS,
  payrollPlace,
  REPORT_LINE_LABELS,
  WRITE_ROLES,
  type BudgetChange,
  type BudgetFileDto,
  type BudgetFileRow,
  type BudgetFileVersionDto,
  type BudgetUploadChange,
  type PayrollBudgetKind,
  type ReportLine,
} from '@ad/types'
import type { Prisma } from '@prisma/client'
import { ChecksService } from '../checks/checks.service'
import { AccessLogService, type LogEntry } from '../core/access-log.service'
import { allow, tenantWhere, workspaceRole, type Caller } from '../core/caller'
import { changesOf, type Fields } from '../core/changes'
import { PrismaService } from '../prisma/prisma.service'
import { backToDraft, BECAUSE } from '../reports/back-to-draft'
import { DOCUMENT_STORAGE, type DocumentStorage } from '../storage/document-storage.interface'
import { budgetFile, readBudgetFile } from './budget-file'
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
type Values = { name: string; reportLine: ReportLine; amount: string; narrative: string | null }

const CONTENT_TYPES = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
} as const

/** An uploaded file as the controller passes it. */
export interface BudgetUpload {
  buffer: Buffer
  originalname: string
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
 * line it rolls up to, its approved amount and a note. Every expense is spent against one of them. The budget comes
 * from an Excel file only (GitHub issue #98; owner's decisions, 2026-11-27): owners and bookkeepers download the
 * template with the current lines, upload it filled in, and the file replaces the whole budget. Each file saved is kept
 * as the budget history, to download again; the auditor sees neither the files nor the upload (owner's rule,
 * 2026-11-27). The month checks compare spending with these lines, so every change runs them again.
 */
@Injectable()
export class BudgetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly engagements: EngagementsService,
    private readonly checks: ChecksService,
    private readonly log: AccessLogService,
    @Inject(DOCUMENT_STORAGE) private readonly storage: DocumentStorage
  ) {}

  /** The template: a header row and the engagement's current lines, to fill in or edit. */
  async template(caller: Caller, engagementId: string): Promise<{ name: string; bytes: Buffer }> {
    const c = await this.writable(caller, engagementId)
    const lines = await this.prisma.budgetLine.findMany({
      where: { engagementId },
      orderBy: { sortOrder: 'asc' },
    })
    return { name: `${c.name} - budget.xlsx`, bytes: await budgetFile(lines) }
  }

  /** An uploaded budget file, read and checked against the budget: what Save would do, and every problem. */
  async readFile(caller: Caller, engagementId: string, file: BudgetUpload): Promise<BudgetFileDto> {
    const c = await this.writable(caller, engagementId)
    return (await this.check(c.id, file)).dto
  }

  /**
   * Saves an uploaded budget file: it replaces the whole budget, all or nothing (owner's decisions, 2026-11-27). The
   * file is read and checked again, and refused whole with every problem if it has any. A line of the same name is
   * changed in place, never removed and added again (CLAUDE.md, "A budget line's name is its key"); a new name is
   * added; a line the file leaves out is removed, and one with spending refuses the file. A line's payroll from the
   * match is left as it is (#132 moves it off the budget line). The file is kept as the budget history. A change puts
   * every closed and submitted month back to draft, as any budget change does; a file that changes nothing writes
   * nothing.
   */
  async upload(
    caller: Caller,
    engagementId: string,
    file: BudgetUpload
  ): Promise<BudgetUploadChange> {
    const c = await this.writable(caller, engagementId)
    const plan = await this.check(c.id, file)
    const { problems } = plan.dto
    if (problems.length)
      throw new BadRequestException({
        message: `The file has ${problems.length} ${problems.length === 1 ? 'problem' : 'problems'}: correct the file and upload it again`,
        problems,
      })
    const counts = {
      added: plan.create.length,
      changed: plan.update.length,
      removed: plan.remove.length,
    }
    if (counts.added + counts.changed + counts.removed === 0)
      return { ...(await this.engagements.detail(caller, c.id)), backToDraft: [], ...counts }

    const ext = /\.csv$/i.test(file.originalname) ? 'csv' : 'xlsx'
    const storageKey = `${c.workspaceId}/${c.id}/general/${randomUUID()}.${ext}`
    await this.storage.upload(storageKey, file.buffer, CONTENT_TYPES[ext])
    let backed: Sent = []
    try {
      await this.log.change(
        caller,
        async (tx) => {
          const lines: LogEntry[] = []
          const entry = (
            action: LogEntry['action'],
            description: string,
            changes: LogEntry['changes']
          ) =>
            lines.push({
              workspaceId: c.workspaceId,
              resource: 'engagement',
              subjectId: c.id,
              action,
              description,
              changes,
            })
          for (const r of plan.remove) {
            await tx.budgetLine.delete({ where: { id: r.id } })
            entry(
              'delete',
              `Removed ${r.name} from the approved budget of ${c.name}`,
              changesOf(r, null, BUDGET_LINE_FIELDS)
            )
          }
          for (const { had, values } of plan.update) {
            await tx.budgetLine.update({ where: { id: had.id }, data: values })
            entry(
              'update',
              `Changed ${had.name} on the approved budget of ${c.name}`,
              changesOf(had, values, BUDGET_LINE_FIELDS)
            )
          }
          for (const [i, values] of plan.create.entries()) {
            await tx.budgetLine.create({
              data: { engagementId: c.id, sortOrder: plan.existing.length + i, ...values },
            })
            entry(
              'create',
              `Added ${values.name} to the approved budget of ${c.name}`,
              changesOf(null, values, BUDGET_LINE_FIELDS)
            )
          }
          await tx.budgetFile.create({
            data: {
              engagementId: c.id,
              fileName: file.originalname.slice(0, 255) || `budget.${ext}`,
              contentType: CONTENT_TYPES[ext],
              size: file.buffer.length,
              sha256: createHash('sha256').update(file.buffer).digest('hex'),
              storageKey,
              lineCount: plan.dto.rows.length,
              uploadedById: caller.userId,
              uploadedByEmail: caller.email ?? caller.displayName,
            },
          })
          backed = await this.backToDraft(tx, caller, c)
          // Each kind of payroll onto the line Map Payroll Budget Line Items says (#142): a new line takes its payroll
          // from the list, and one the file removed gives its payroll up.
          await this.applyRollup(tx, caller, c, false)
          await this.log.alsoMany(tx, caller, lines)
          return { workspaceId: c.workspaceId }
        },
        {
          workspaceId: c.workspaceId,
          resource: 'engagement',
          subjectId: c.id,
          action: 'update',
          description:
            `Uploaded a budget file to ${c.name}, replacing its approved budget: ` +
            `${counts.added} added, ${counts.changed} changed, ${counts.removed} removed`,
        },
        { timeout: 30_000 }
      )
    } catch (e) {
      // Nothing was saved: the stored file goes too.
      await this.storage.delete(storageKey).catch(() => undefined)
      throw e
    }
    return { ...(await this.done(caller, c.id, backed)), ...counts }
  }

  /** The budget history: every budget file saved, newest first; the newest is the current budget's. */
  async history(caller: Caller, engagementId: string): Promise<BudgetFileVersionDto[]> {
    const c = await this.writable(caller, engagementId)
    const files = await this.prisma.budgetFile.findMany({
      where: { engagementId: c.id },
      orderBy: { uploadedAt: 'desc' },
    })
    return files.map((f, i) => ({
      id: f.id,
      fileName: f.fileName,
      uploadedAt: f.uploadedAt.toISOString(),
      uploadedByEmail: f.uploadedByEmail,
      lineCount: f.lineCount,
      current: i === 0,
    }))
  }

  /** A budget file of the history, as it was uploaded, to view or download. Logged. */
  async historyFile(
    caller: Caller,
    engagementId: string,
    fileId: string
  ): Promise<{ name: string; contentType: string; bytes: Buffer }> {
    const c = await this.writable(caller, engagementId)
    const f = await this.prisma.budgetFile.findFirst({
      where: { id: fileId, engagementId: c.id, ...tenantWhere(caller) },
    })
    if (!f) throw new NotFoundException()
    const bytes = await this.storage.read(f.storageKey)
    await this.log.log(caller, {
      workspaceId: c.workspaceId,
      resource: 'engagement',
      subjectId: c.id,
      action: 'read',
      description: `Opened the budget file ${f.fileName} of ${c.name}, uploaded ${f.uploadedAt.toISOString().slice(0, 10)}`,
    })
    return { name: f.fileName, contentType: f.contentType, bytes }
  }

  /**
   * An uploaded file read and checked against the engagement's budget: each line with what Save does with it, the
   * lines Save removes, every problem in the file's order, and the writes Save makes.
   */
  private async check(engagementId: string, file: BudgetUpload) {
    const read = await readBudgetFile(file.buffer, file.originalname)
    const existing = await this.prisma.budgetLine.findMany({
      where: { engagementId },
      include: { _count: { select: { expenses: true } } },
      orderBy: { sortOrder: 'asc' },
    })
    const byName = new Map(existing.map((e) => [e.name.toLowerCase(), e]))
    const problems = [...read.problems]
    const rows: BudgetFileRow[] = []
    const create: Values[] = []
    const update: { had: (typeof existing)[number]; values: Values }[] = []
    for (const r of read.rows) {
      const values: Values = {
        name: r.name,
        reportLine: r.reportLine,
        amount: r.amount.toFixed(2),
        narrative: r.narrative,
      }
      const had = byName.get(r.name.toLowerCase())
      if (!had) {
        create.push(values)
        rows.push({ ...r, action: 'new' })
      } else if (had._count.expenses > 0 && had.reportLine !== r.reportLine)
        problems.push({
          row: r.row,
          reason: `${had.name} has spending, so it keeps the monthly report line ${REPORT_LINE_LABELS[had.reportLine as ReportLine]}`,
        })
      else {
        const changed = changesOf(had, values, BUDGET_LINE_FIELDS).length > 0
        if (changed) update.push({ had, values })
        rows.push({ ...r, action: changed ? 'change' : 'same' })
      }
    }
    const left = existing.filter((e) => !read.names.has(e.name.toLowerCase()))
    for (const e of left.filter((l) => l._count.expenses > 0))
      problems.push({ row: null, reason: `${e.name} has spending, so it must stay in the file` })
    const remove = left.filter((l) => l._count.expenses === 0)
    problems.sort((a, b) => (a.row ?? Infinity) - (b.row ?? Infinity))
    return {
      dto: { rows, removed: remove.map((e) => e.name), problems },
      create,
      update,
      remove,
      existing,
    }
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
    const { list, lines } = await this.rollupOf(tx, c)
    const want = new Map(lines.map((l) => [l.id, [] as PayrollBudgetKind[]]))
    const arrived: { lineId: string; kind: PayrollBudgetKind }[] = []
    for (const kind of PAYROLL_BUDGET_KINDS) {
      const holder = payrollPlace(kind, c.id, list, lines).line
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

  /** The payroll entries of an engagement (the workspace's and its own) and its lines, on `tx`. */
  private async rollupOf(tx: Prisma.TransactionClient, c: { id: string; workspaceId: string }) {
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
    return { list, lines }
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
