import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import {
  RECEIPT_KINDS,
  RECEIPT_READ_BY_LABELS,
  WRITE_ROLES,
  type ReceiptInput,
  type ReceiptKind,
  type ReceiptUploadResult,
  type ReportDetail,
} from '@ad/types'
import { ChecksService } from '../checks/checks.service'
import { AccessLogService } from '../core/access-log.service'
import { allow, staffName, tenantWhere, workspaceRole, type Caller } from '../core/caller'
import { changesOf, type Fields } from '../core/changes'
import { MatchStatsService } from '../core/match-stats.service'
import { DocumentsService, type Uploaded } from '../documents/documents.service'
import { NothingChanged, unlessUnchanged } from '../documents/link'
import { describe, type StagedFile } from '../documents/staged-file'
import { PrismaService } from '../prisma/prisma.service'
import { ReportsService } from '../reports/reports.service'
import { onlyStrong } from './match'
import { readReceipt, type ReceiptRead } from './read-receipt'
import { expenseFacts, needsInvoice, receiptDto, receiptFacts } from './receipt.dto'

/** Receipts are PDFs or photos; the bytes are sniffed as for any upload. */
export const RECEIPT_TYPES = ['application/pdf', 'image/png', 'image/jpeg']
export const MAX_RECEIPTS = 20
export const MAX_RECEIPT_BYTES = 10 * 1024 * 1024

/** What was read from a receipt, in the access log: a business receipt's amount, date and vendor by value. */
const RECEIPT_FIELDS: Fields = {
  receiptAmount: { label: 'Amount', show: 'money' },
  receiptDate: { label: 'Date', show: 'date' },
  receiptVendor: { label: 'Vendor', show: 'text' },
  receiptReadBy: { label: 'Read', show: 'text', labels: RECEIPT_READ_BY_LABELS },
}
const DISMISSED_FIELDS: Fields = {
  receiptDismissed: {
    label: 'Not for this grant',
    show: 'text',
    labels: { true: 'yes', false: 'no' },
  },
}

/** How many receipts are read at once: each read may wait up to 15 seconds on Claude. */
const READ_AT_ONCE = 4

/** `fn` over `items`, at most `limit` at a time, the results in the items' order. */
async function inBatches<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>) {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i]!, i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/** The end of a receipt's line when AI read it, so the yes that sent it is on record: ", read with AI". */
export const readWithAi = (read: ReceiptRead) => (read.readBy === 'ai' ? ', read with AI' : '')

const isReceiptKind = (k: string): k is ReceiptKind =>
  (RECEIPT_KINDS as readonly string[]).includes(k)
const dateOf = (iso: string) => new Date(`${iso}T00:00:00Z`)

/**
 * Receipts uploaded to a month, read for their amount, date and vendor, and matched to its expenses as their invoice
 * proof (an ExpenseDocument link with purpose 'invoice', as attaching by hand). Only financial receipts and invoices;
 * a personal document is never read, listed or matched here. Every change is logged with it; a closed or submitted
 * month refuses them all.
 */
@Injectable()
export class ReceiptsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly log: AccessLogService,
    private readonly checks: ChecksService,
    private readonly reports: ReportsService,
    private readonly documents: DocumentsService,
    private readonly stats: MatchStatsService
  ) {}

  /**
   * Many receipts at once, to the month: each checked as any upload is (type, bytes, size; sha256 and size kept),
   * then read, stored with its own line, and matched automatically when it has one strong candidate. Nothing is stored
   * when any file is refused. Read by the PDF's text rules, and by AI only when the person ticked the box (`withAi`);
   * the line of a receipt AI read says so.
   */
  async upload(
    caller: Caller,
    reportId: string,
    files: Uploaded[],
    kind = 'receipt',
    withAi = false
  ): Promise<ReceiptUploadResult> {
    const startedAt = new Date()
    const r = await this.reports.editable(caller, reportId)
    if (!isReceiptKind(kind)) throw new BadRequestException('kind must be receipt or invoice')
    if (!Array.isArray(files) || !files.length)
      throw new BadRequestException('Choose at least one file')
    if (files.length > MAX_RECEIPTS)
      throw new BadRequestException(`Upload at most ${MAX_RECEIPTS} receipts at a time`)
    for (const f of files) {
      if (!RECEIPT_TYPES.includes(f.mimetype))
        throw new BadRequestException('Receipts must be PDF, PNG or JPG files')
      if (f.size > MAX_RECEIPT_BYTES)
        throw new BadRequestException('Receipts are limited to 10 MB each')
    }
    const body = {
      workspaceId: r.workspaceId!,
      engagementId: r.engagementId,
      period: r.period,
      kind,
    }
    const staged = []
    let matched = 0
    let filed = 0
    let unread = 0
    let readMs: number | null = null
    // Matching statistics: one row for the upload, written once it ends, done or failed (a refused file included).
    const stat = (outcome: 'done' | 'failed') =>
      this.stats.record({
        workspaceId: r.workspaceId!,
        feature: 'receipts',
        startedById: caller.userId,
        startedByEmail: staffName(caller),
        startedAt,
        outcome,
        fileCount: files.length,
        totalBytes: files.reduce((n, f) => n + f.size, 0),
        readMs,
        items: filed,
        matched,
        missing: filed - matched,
        failed: unread,
      })
    try {
      for (const f of files) staged.push(await this.documents.stage(caller, f, body))
      const readFrom = Date.now()
      const reads = await inBatches(staged, READ_AT_ONCE, (s, i) =>
        readReceipt(
          {
            buffer: files[i]!.buffer,
            contentType: s.data.contentType,
            sensitivity: s.data.sensitivity,
          },
          withAi
        )
      )
      readMs = Date.now() - readFrom
      unread = reads.filter((x) => x.amount == null).length
      for (const [i, s] of staged.entries()) {
        const read = reads[i]!
        const doc = await this.store(
          caller,
          s,
          read,
          (made) => `Uploaded ${describe(made)} to match${readWithAi(read)}`
        )
        filed++
        if (await this.autoMatch(caller, doc.id)) matched++
      }
    } catch (e) {
      await stat('failed')
      throw e
    }
    await stat('done')
    return { uploaded: staged.length, matched, report: await this.reports.fresh(caller, r.id) }
  }

  /**
   * One receipt filed into a draft month by something other than the month's upload button (an emailed receipt): the
   * same checks as an upload (role, type, sniffed bytes, size; sha256 and size kept), what was already read from it,
   * its own line worded by `description`, and `alsoInTx` in that same transaction (the emailed receipt's queue row), so
   * the document and what records it are kept together or not at all. Then matched automatically, as an upload is.
   */
  async fileOne(
    caller: Caller,
    reportId: string,
    file: Uploaded,
    read: ReceiptRead,
    description: (made: { kind: string; sensitivity: string; period: string | null }) => string,
    alsoInTx?: (tx: Prisma.TransactionClient, documentId: string) => Promise<unknown>
  ): Promise<{ documentId: string; matched: boolean }> {
    const r = await this.reports.editable(caller, reportId)
    if (!RECEIPT_TYPES.includes(file.mimetype))
      throw new BadRequestException('Receipts must be PDF, PNG or JPG files')
    if (file.size > MAX_RECEIPT_BYTES)
      throw new BadRequestException('Receipts are limited to 10 MB each')
    const s = await this.documents.stage(caller, file, {
      workspaceId: r.workspaceId!,
      engagementId: r.engagementId,
      period: r.period,
      kind: 'receipt',
    })
    const doc = await this.store(caller, s, read, description, alsoInTx)
    return { documentId: doc.id, matched: !!(await this.autoMatch(caller, doc.id)) }
  }

  /** Stores a staged receipt with what was read from it, and its line, in one transaction. */
  private async store(
    caller: Caller,
    s: StagedFile,
    read: ReceiptRead,
    description: (made: { kind: string; sensitivity: string; period: string | null }) => string,
    alsoInTx?: (tx: Prisma.TransactionClient, documentId: string) => Promise<unknown>
  ) {
    Object.assign(s.data, {
      receiptAmount: read.amount == null ? null : read.amount.toFixed(2),
      receiptDate: read.date ? dateOf(read.date) : null,
      receiptVendor: read.vendor,
      receiptReadBy: read.readBy,
    })
    return s.commit(() =>
      this.log.change(
        caller,
        async (tx) => {
          const made = await s.create(tx)
          if (alsoInTx) await alsoInTx(tx, made.id)
          return made
        },
        (made) => ({
          workspaceId: made.workspaceId,
          resource: 'document',
          subjectId: made.id,
          action: 'create',
          description: description(made),
          changes: changesOf(null, made, RECEIPT_FIELDS),
        })
      )
    )
  }

  /**
   * Matches a receipt without a person when exactly one expense of its month is a strong candidate: the exact amount,
   * dates within 3 days, and no invoice proof yet. Logged as an automatic match. Nothing happens (null) for a receipt
   * already matched or dismissed, with nothing read, in a locked month, or with no single strong candidate. Called
   * after each upload and by anything that files a receipt later (email); it needs only the caller and the id.
   */
  async autoMatch(
    caller: Caller,
    documentId: string
  ): Promise<{ expenseId: string; itemNumber: string } | null> {
    const doc = await this.prisma.document.findFirst({
      where: { id: documentId, ...tenantWhere(caller) },
      include: { _count: { select: { expenses: true } } },
    })
    if (!doc) throw new NotFoundException()
    allow(
      workspaceRole(caller, doc.workspaceId, WRITE_ROLES),
      'Only an owner or bookkeeper matches'
    )
    if (doc.sensitivity !== 'financial' || !isReceiptKind(doc.kind)) return null
    if (doc.receiptDismissed || doc._count.expenses > 0 || doc.receiptAmount == null) return null
    if (!doc.engagementId || !doc.period) return null
    const month = await this.prisma.monthlyReport.findFirst({
      where: { engagementId: doc.engagementId, period: doc.period, ...tenantWhere(caller) },
      include: { expenses: { include: { documents: true } } },
    })
    if (!month || month.status !== 'draft') return null
    const open = month.expenses.filter(needsInvoice)
    const expenseId = onlyStrong(receiptFacts(receiptDto(doc)), open.map(expenseFacts))
    const e = open.find((x) => x.id === expenseId)
    if (!e) return null
    try {
      await this.log.change(
        caller,
        async (tx) => {
          // As it stands now: another upload or a person may have matched either one meanwhile. The expense's row is
          // locked first, so two receipts matched at once cannot both become its invoice proof.
          await tx.$queryRaw`SELECT "id" FROM "Expense" WHERE "id" = ${e.id} FOR UPDATE`
          if (await tx.expenseDocument.findFirst({ where: { documentId } }))
            throw new NothingChanged()
          if (
            await tx.expenseDocument.findFirst({ where: { expenseId: e.id, purpose: 'invoice' } })
          )
            throw new NothingChanged()
          return tx.expenseDocument.create({
            data: { expenseId: e.id, documentId, purpose: 'invoice' },
          })
        },
        {
          workspaceId: doc.workspaceId,
          resource: 'expense',
          subjectId: e.id,
          action: 'update',
          description: `Matched ${describe(doc)} to expense ${e.itemNumber} automatically`,
        }
      )
    } catch (err) {
      if (err instanceof NothingChanged) return null
      throw err
    }
    await this.checks.refresh(month.id)
    return { expenseId: e.id, itemNumber: e.itemNumber }
  }

  /** A receipt of the caller's workspace and the month it is filed in, open for a change by an owner or bookkeeper. */
  private async changeable(caller: Caller, documentId: string) {
    const doc = await this.prisma.document.findFirst({
      where: { id: documentId, ...tenantWhere(caller) },
    })
    if (!doc) throw new NotFoundException()
    allow(
      workspaceRole(caller, doc.workspaceId, WRITE_ROLES),
      'Only an owner or bookkeeper matches receipts'
    )
    if (doc.sensitivity !== 'financial' || !isReceiptKind(doc.kind))
      throw new BadRequestException('Only receipts and invoices are matched here')
    const month =
      doc.engagementId && doc.period
        ? await this.prisma.monthlyReport.findFirst({
            where: { engagementId: doc.engagementId, period: doc.period, ...tenantWhere(caller) },
            select: { id: true },
          })
        : null
    if (!month) throw new BadRequestException('This receipt is not filed in a month')
    const r = await this.reports.editable(caller, month.id)
    return { doc, r }
  }

  /** Confirms a match: the receipt becomes the expense's invoice proof, as attaching it by hand does. */
  async match(caller: Caller, documentId: string, expenseId: string): Promise<ReportDetail> {
    const { doc, r } = await this.changeable(caller, documentId)
    const e = r.expenses.find((x) => x.id === expenseId)
    if (!e) throw new NotFoundException('No such expense in this month')
    if (doc.receiptDismissed)
      throw new ConflictException('This receipt is marked not for this grant; bring it back first')
    await unlessUnchanged(async () => {
      await this.log.change(
        caller,
        async (tx) => {
          const link = await tx.expenseDocument.findFirst({ where: { expenseId, documentId } })
          if (link?.purpose === 'invoice') throw new NothingChanged()
          if (link)
            return tx.expenseDocument.update({
              where: { expenseId_documentId: { expenseId, documentId } },
              data: { purpose: 'invoice' },
            })
          return tx.expenseDocument.create({ data: { expenseId, documentId, purpose: 'invoice' } })
        },
        {
          workspaceId: doc.workspaceId,
          resource: 'expense',
          subjectId: expenseId,
          action: 'update',
          description: `Matched ${describe(doc)} to expense ${e.itemNumber}`,
        }
      )
      await this.checks.refresh(r.id)
    })
    return this.reports.fresh(caller, r.id)
  }

  /** Undoes a match: the receipt is no longer the expense's proof and is back among the unmatched. */
  async unmatch(caller: Caller, documentId: string, expenseId: string): Promise<ReportDetail> {
    const { doc, r } = await this.changeable(caller, documentId)
    const e = r.expenses.find((x) => x.id === expenseId)
    if (!e) throw new NotFoundException('No such expense in this month')
    await unlessUnchanged(async () => {
      await this.log.change(
        caller,
        async (tx) => {
          // Only the match: the same document attached as another proof (a payment, say) stays.
          const where = { expenseId, documentId, purpose: 'invoice' }
          const link = await tx.expenseDocument.findFirst({ where })
          if (!link) throw new NothingChanged()
          await tx.expenseDocument.deleteMany({ where })
          return link
        },
        {
          workspaceId: doc.workspaceId,
          resource: 'expense',
          subjectId: expenseId,
          action: 'update',
          description: `Unmatched ${describe(doc)} from expense ${e.itemNumber}`,
        }
      )
      await this.checks.refresh(r.id)
    })
    return this.reports.fresh(caller, r.id)
  }

  /** "Not for this grant": the receipt leaves the unmatched list, or (`dismissed` false) comes back to it. */
  async dismiss(caller: Caller, documentId: string, dismissed: boolean): Promise<ReportDetail> {
    if (typeof dismissed !== 'boolean')
      throw new BadRequestException('dismissed must be true or false')
    const { doc, r } = await this.changeable(caller, documentId)
    if (doc.receiptDismissed !== dismissed) {
      if (dismissed && (await this.prisma.expenseDocument.findFirst({ where: { documentId } })))
        throw new ConflictException('This receipt is matched to an expense; unmatch it first')
      const data = { receiptDismissed: dismissed }
      await this.log.change(caller, (tx) => tx.document.update({ where: { id: doc.id }, data }), {
        workspaceId: doc.workspaceId,
        resource: 'document',
        subjectId: doc.id,
        action: 'update',
        description: dismissed
          ? `Marked ${describe(doc)} as not for this grant`
          : `Brought back ${describe(doc)} to match`,
        changes: changesOf(doc, data, DISMISSED_FIELDS),
      })
    }
    return this.reports.fresh(caller, r.id)
  }

  /** The amount, date and vendor as the person types or corrects them; they are then the person's, not what was read. */
  async edit(caller: Caller, documentId: string, input: ReceiptInput): Promise<ReportDetail> {
    const { doc, r } = await this.changeable(caller, documentId)
    const amount =
      input?.amount == null || (input.amount as unknown) === '' ? null : Number(input.amount)
    if (amount != null && (!Number.isFinite(amount) || amount < 0 || amount >= 1e10))
      throw new BadRequestException('The amount must be a positive amount under $10,000,000,000')
    const date = input?.date || null
    if (
      date &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(date) || dateOf(date).toISOString().slice(0, 10) !== date)
    )
      throw new BadRequestException('The date must be a date, YYYY-MM-DD')
    const vendor = typeof input?.vendor === 'string' ? input.vendor.trim() || null : null
    if (vendor && vendor.length > 200)
      throw new BadRequestException('The vendor must be at most 200 characters')
    const data = {
      receiptAmount: amount == null ? null : amount.toFixed(2),
      receiptDate: date ? dateOf(date) : null,
      receiptVendor: vendor,
    }
    const changes = changesOf(doc, data, RECEIPT_FIELDS)
    if (changes.length) {
      const saved = { ...data, receiptReadBy: 'person' }
      await this.log.change(
        caller,
        (tx) => tx.document.update({ where: { id: doc.id }, data: saved }),
        {
          workspaceId: doc.workspaceId,
          resource: 'document',
          subjectId: doc.id,
          action: 'update',
          description: `Changed the amount, date or vendor of ${describe(doc)}`,
          changes,
        }
      )
    }
    return this.reports.fresh(caller, r.id)
  }
}
