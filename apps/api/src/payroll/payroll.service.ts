import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import {
  PAYROLL_DOCUMENT_KINDS,
  PAYROLL_REPORT_LINES,
  personalRolesFor,
  type Role,
  type PayrollDocumentKind,
  type PayrollLineSearch,
  type PayrollUploadResult,
  type ReportDetail,
  type ReportLine,
  type StatementLinkInput,
  type StatementMark,
} from '@ad/types'
import { ChecksService } from '../checks/checks.service'
import { AccessLogService } from '../core/access-log.service'
import { tenantWhere, workspaceRole, type Caller } from '../core/caller'
import { changesOf, howMany, monthName, type Fields } from '../core/changes'
import { documentDto } from '../documents/document.dto'
import { DocumentsService, keyInWorkspace, type Uploaded } from '../documents/documents.service'
import { NothingChanged, unlessUnchanged } from '../documents/link'
import { describe } from '../documents/staged-file'
import { PrismaService } from '../prisma/prisma.service'
import { ReportsService } from '../reports/reports.service'
import { DOCUMENT_STORAGE, type DocumentStorage } from '../storage/document-storage.interface'
import { itemCopy } from './mark-pdf'
import { linesWithAmount, readStatement } from './statement-lines'

export const MAX_PAYROLL_FILES = 20
/** Statements searched for one item at most: a month has one or two accounts. */
const MAX_STATEMENTS = 10

export type PayrollTarget = 'expense' | 'wex'

/**
 * The marked line in the access log: its page and position by value; its text by name only, since a statement line
 * can carry a person's name.
 */
const MARK_FIELDS: Fields = {
  page: { label: 'Marked line: page', show: 'text' },
  position: { label: 'Marked line: position', show: 'text' },
  text: { label: 'Marked line: text' },
}

const markValues = (m: StatementMark | null | undefined) =>
  m
    ? {
        page: String(m.page),
        position: `${m.x}, ${m.y}, ${m.width} by ${m.height} points`,
        text: m.text ?? null,
      }
    : null

const isKind = (k: unknown): k is PayrollDocumentKind =>
  typeof k === 'string' && (PAYROLL_DOCUMENT_KINDS as readonly string[]).includes(k)

const round = (n: number) => Math.round(n * 100) / 100

/** A mark as the person confirmed it, checked for shape: a whole page from 1 and a box of positive size. */
export function cleanMark(input: unknown): StatementMark {
  const m = (input ?? {}) as Record<string, unknown>
  const num = (k: string) => {
    const v = m[k]
    if (typeof v !== 'number' || !Number.isFinite(v))
      throw new BadRequestException(`The mark's ${k} must be a number`)
    return v
  }
  const page = num('page')
  if (!Number.isInteger(page) || page < 1)
    throw new BadRequestException('The page must be a whole number from 1')
  const [x, y, width, height] = ['x', 'y', 'width', 'height'].map(num) as [
    number,
    number,
    number,
    number,
  ]
  if (width <= 0 || height <= 0)
    throw new BadRequestException('Draw a box with some width and height')
  const out: StatementMark = {
    page,
    x: round(x),
    y: round(y),
    width: round(width),
    height: round(height),
  }
  if (m.text != null) {
    if (typeof m.text !== 'string') throw new BadRequestException('The line text must be text')
    const text = m.text.replace(/\s+/g, ' ').trim()
    if (text.length > 300)
      throw new BadRequestException('The line text must be at most 300 characters')
    if (text) out.text = text
  }
  return out
}

const sameMark = (a: unknown, b: StatementMark) => JSON.stringify(a ?? null) === JSON.stringify(b)

/**
 * Payroll proof for a month: bank statements, payroll registers and pay stubs uploaded many at once; each payroll
 * item (a payroll expense line, a work-experience payment) linked to its bank statement as evidence of payment with
 * the line it was paid on marked. Only bank statements are ever read or marked; a pay stub or any personal document
 * is stored as uploaded and never read here. Every change is logged with it; a closed or submitted month refuses them.
 */
@Injectable()
export class PayrollService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly log: AccessLogService,
    private readonly checks: ChecksService,
    private readonly reports: ReportsService,
    private readonly documents: DocumentsService,
    @Inject(DOCUMENT_STORAGE) private readonly storage: DocumentStorage
  ) {}

  /**
   * Many payroll documents at once, to the month, each with the kind the person gave it (`kinds`, in the files'
   * order). Each is checked as any upload is (type, bytes, size; sha256 and size kept) and filed unlinked. Nothing
   * is stored when any file is refused.
   */
  async upload(
    caller: Caller,
    reportId: string,
    files: Uploaded[],
    kinds: unknown
  ): Promise<PayrollUploadResult> {
    const r = await this.reports.editable(caller, reportId)
    const list = Array.isArray(kinds) ? kinds : kinds == null ? [] : [kinds]
    if (!files.length) throw new BadRequestException('Choose at least one file')
    if (files.length > MAX_PAYROLL_FILES)
      throw new BadRequestException(`Upload at most ${MAX_PAYROLL_FILES} files at a time`)
    if (list.length !== files.length || !list.every(isKind))
      throw new BadRequestException(
        'Say for each file whether it is a timesheet, a payroll register, a pay stub or a bank statement'
      )
    const staged = []
    for (const [i, f] of files.entries())
      staged.push(
        await this.documents.stage(caller, f, {
          workspaceId: r.workspaceId!,
          engagementId: r.engagementId,
          period: r.period,
          kind: list[i] as PayrollDocumentKind,
        })
      )
    const documentIds: string[] = []
    for (const s of staged) {
      const made = await s.commit(() =>
        this.log.change(
          caller,
          (tx) => s.create(tx),
          (made) => ({
            workspaceId: made.workspaceId,
            resource: 'document',
            subjectId: made.id,
            action: 'create',
            description: `Uploaded ${describe(made)} with the month's payroll`,
          })
        )
      )
      documentIds.push(made.id)
    }
    return { uploaded: staged.length, documentIds, report: await this.reports.fresh(caller, r.id) }
  }

  /**
   * "Replace this month's payroll files": after the new zip is in, the month's earlier payroll documents (named by id,
   * every one of them this month's) are detached from their payroll items and removed, each with its own access-log
   * line. The month must be a draft. The checks run again once.
   */
  async replace(caller: Caller, reportId: string, ids: unknown): Promise<ReportDetail> {
    const r = await this.reports.editable(caller, reportId)
    const list = Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : []
    if (!list.length || list.length > 1000)
      throw new BadRequestException('Name the payroll files to replace')
    const docs = await this.prisma.document.findMany({
      where: {
        id: { in: list },
        engagementId: r.engagementId,
        period: r.period,
        kind: { in: [...PAYROLL_DOCUMENT_KINDS] },
        ...tenantWhere(caller),
      },
    })
    if (docs.length !== new Set(list).size)
      throw new BadRequestException("Only this month's payroll files can be replaced")
    for (const d of docs) await this.documents.removeReplaced(caller, d)
    await this.checks.refresh(r.id)
    return this.reports.fresh(caller, r.id)
  }

  /**
   * The payroll item and its month, open for a change by an owner or bookkeeper (a draft month). A payroll expense
   * line only: its report line is one PAYROLL_REPORT_LINES names.
   */
  private async item(caller: Caller, target: PayrollTarget, id: string) {
    if (target === 'expense') {
      const e = await this.prisma.expense.findFirst({ where: { id, ...tenantWhere(caller) } })
      if (!e) throw new NotFoundException()
      const r = await this.reports.editable(caller, e.monthlyReportId)
      if (!PAYROLL_REPORT_LINES.has(e.reportLine as ReportLine))
        throw new BadRequestException('Only payroll lines are linked to a bank statement here')
      return {
        r,
        amount: Number(e.totalCost),
        subject: `expense ${e.itemNumber}`,
        resource: 'expense' as const,
      }
    }
    if (target === 'wex') {
      const w = await this.prisma.wexPayment.findFirst({ where: { id, ...tenantWhere(caller) } })
      if (!w) throw new NotFoundException()
      const r = await this.reports.editable(caller, w.monthlyReportId)
      return {
        r,
        amount: Number(w.grossAmount),
        subject: `a work-experience payment in ${monthName(r.period)}`,
        resource: 'report' as const,
      }
    }
    throw new NotFoundException()
  }

  /** The bytes of a financial bank statement of this workspace; nothing else is ever read here. */
  private async statementBytes(d: {
    kind: string
    sensitivity: string
    storageKey: string
    workspaceId: string
    engagementId: string | null
  }): Promise<Buffer> {
    if (d.kind !== 'bank-statement' || d.sensitivity !== 'financial') throw new NotFoundException()
    if (!keyInWorkspace(d)) throw new NotFoundException()
    return this.storage.read(d.storageKey)
  }

  /**
   * A bank statement's bytes for the viewer on the month's page, through the API rather than a signed link. Any member
   * of the workspace may open a financial document; nothing personal is ever served here. Each open is one read line.
   */
  async statementFile(caller: Caller, documentId: string): Promise<Buffer> {
    const doc = await this.prisma.document.findFirst({
      where: { id: documentId, ...tenantWhere(caller) },
    })
    if (!doc) throw new NotFoundException()
    if (doc.kind !== 'bank-statement' || doc.sensitivity !== 'financial')
      throw new BadRequestException('Only a bank statement opens here')
    if (doc.contentType !== 'application/pdf')
      throw new BadRequestException('Only a PDF statement opens here')
    const bytes = await this.statementBytes(doc)
    await this.log.log(caller, {
      workspaceId: doc.workspaceId,
      resource: 'document',
      subjectId: doc.id,
      action: 'read',
      description: `Opened ${describe(doc)}`,
    })
    return bytes
  }

  /**
   * A payroll proof as its item's own copy: the file's own highlight notes removed and only this item's highlights
   * drawn (its marks, or the line marked by hand), so it stands on its own for the auditor. Any member may open a
   * financial proof; a pay stub opens to its roles (personalRolesFor). Each open is one read line.
   */
  async proofCopy(
    caller: Caller,
    target: PayrollTarget,
    id: string,
    documentId: string
  ): Promise<{ bytes: Uint8Array; contentType: string; fileName: string }> {
    const link =
      target === 'expense'
        ? await this.prisma.expenseDocument.findFirst({
            where: { expenseId: id, documentId, ...tenantWhere(caller) },
            include: { document: true, expense: true },
          })
        : await this.prisma.wexPaymentDocument.findFirst({
            where: { wexPaymentId: id, documentId, ...tenantWhere(caller) },
            include: { document: true },
          })
    if (!link) throw new NotFoundException()
    const doc = link.document
    if (!(PAYROLL_DOCUMENT_KINDS as readonly string[]).includes(doc.kind))
      throw new BadRequestException('Only a payroll proof opens here')
    if (
      doc.sensitivity === 'personal' &&
      !workspaceRole(caller, doc.workspaceId, [...personalRolesFor(doc.kind)] as Role[])
    )
      throw new ForbiddenException('This document opens to owners and auditors only')
    if (!keyInWorkspace(doc)) throw new NotFoundException()
    const saved = (Array.isArray(link.marks) ? link.marks : []) as unknown as StatementMark[]
    const marks = saved.length ? saved : link.mark ? [link.mark as unknown as StatementMark] : []
    const original = new Uint8Array(await this.storage.read(doc.storageKey))
    const bytes =
      doc.contentType === 'application/pdf' ? (await itemCopy(original, marks)).bytes : original
    const subject =
      'expense' in link ? `expense ${link.expense.itemNumber}` : 'a work-experience payment'
    await this.log.log(caller, {
      workspaceId: doc.workspaceId,
      resource: 'document',
      subjectId: doc.id,
      action: 'read',
      description: `Opened ${describe(doc)} highlighted for ${subject}`,
    })
    return { bytes, contentType: doc.contentType, fileName: doc.fileName }
  }

  /**
   * "Find the line": searches the text of the month's bank statements for the item's amount and answers each
   * statement's lines where it appears, with the page and the line's box. A statement without text (scanned) says
   * so. Only financial bank statements are read; the search is logged as a read of them. The newest statements are
   * searched first; past MAX_STATEMENTS the rest are not read, and `notSearched` says how many.
   */
  async findLines(
    caller: Caller,
    target: PayrollTarget,
    id: string
  ): Promise<PayrollLineSearch & { notSearched: number }> {
    const { r, amount, subject } = await this.item(caller, target, id)
    const where = {
      engagementId: r.engagementId,
      period: r.period,
      kind: 'bank-statement',
      sensitivity: 'financial',
      ...tenantWhere(caller),
    }
    const docs = await this.prisma.document.findMany({
      where,
      orderBy: { uploadedAt: 'desc' },
      take: MAX_STATEMENTS,
    })
    const notSearched =
      docs.length < MAX_STATEMENTS
        ? 0
        : Math.max(0, (await this.prisma.document.count({ where })) - docs.length)
    const statements: PayrollLineSearch['statements'] = []
    for (const d of docs) {
      if (d.kind !== 'bank-statement' || d.sensitivity !== 'financial') continue
      if (d.contentType !== 'application/pdf') {
        statements.push({ document: documentDto(d), pages: 0, scanned: true, lines: [] })
        continue
      }
      const text = await readStatement(await this.statementBytes(d)).catch(() => null)
      statements.push({
        document: documentDto(d),
        pages: text?.pages ?? 0,
        scanned: text ? text.scanned : true,
        lines: text ? linesWithAmount(text.lines, amount) : [],
      })
    }
    if (statements.length)
      await this.log.log(caller, {
        workspaceId: r.workspaceId!,
        resource: 'document',
        action: 'read',
        description: `Searched ${howMany(statements.length, 'bank statement')} for ${monthName(r.period)} for the line that pays ${subject}`,
      })
    return { amount, statements, notSearched }
  }

  /**
   * Links the item to a bank statement of its month as evidence of payment, with the line marked (found by its text
   * or drawn by hand). The statement must be filed under the item's month, the page must be one it has and the box
   * must sit on it. The same mark again changes nothing; a new one replaces the old, and the line says so.
   */
  async link(
    caller: Caller,
    target: PayrollTarget,
    id: string,
    input: StatementLinkInput
  ): Promise<ReportDetail> {
    const { r, subject, resource } = await this.item(caller, target, id)
    const mark = cleanMark(input?.mark)
    const doc =
      typeof input?.documentId === 'string'
        ? await this.prisma.document.findFirst({
            where: { id: input.documentId, ...tenantWhere(caller) },
          })
        : null
    if (!doc || doc.workspaceId !== r.workspaceId) throw new NotFoundException('No such document')
    if (
      doc.kind !== 'bank-statement' ||
      doc.sensitivity !== 'financial' ||
      doc.engagementId !== r.engagementId
    )
      throw new BadRequestException('Mark the line on a bank statement of this engagement')
    if (doc.period !== r.period)
      throw new BadRequestException(
        `This statement is filed under ${doc.period ? monthName(doc.period) : 'no month'}. Mark the line on a statement of ${monthName(r.period)}`
      )
    if (doc.contentType !== 'application/pdf')
      throw new BadRequestException('Only a PDF statement can be marked')
    const text = await readStatement(await this.statementBytes(doc)).catch(() => null)
    if (!text) throw new BadRequestException('This statement could not be opened')
    if (mark.page > text.pages)
      throw new BadRequestException(
        `The statement has ${text.pages} page${text.pages === 1 ? '' : 's'}`
      )
    const [x0, y0, x1, y1] = text.views[mark.page - 1] ?? [0, 0, 0, 0]
    const slack = 2
    if (
      mark.x < x0! - slack ||
      mark.y < y0! - slack ||
      mark.x + mark.width > x1! + slack ||
      mark.y + mark.height > y1! + slack
    )
      throw new BadRequestException('The box must be on the page')
    const documentId = doc.id
    const value = mark as object
    await unlessUnchanged(async () => {
      await this.log.change(
        caller,
        async (tx) => {
          if (target === 'expense') {
            const link = await tx.expenseDocument.findFirst({
              where: { expenseId: id, documentId },
            })
            if (link?.purpose === 'payment' && sameMark(link.mark, mark)) throw new NothingChanged()
            const before = (link?.mark ?? null) as StatementMark | null
            if (link)
              await tx.expenseDocument.update({
                where: { expenseId_documentId: { expenseId: id, documentId } },
                data: { purpose: 'payment', mark: value, marks: [value] },
              })
            else
              await tx.expenseDocument.create({
                data: {
                  expenseId: id,
                  documentId,
                  purpose: 'payment',
                  mark: value,
                  marks: [value],
                },
              })
            return before
          }
          const link = await tx.wexPaymentDocument.findFirst({
            where: { wexPaymentId: id, documentId },
          })
          if (link?.purpose === 'payment' && sameMark(link.mark, mark)) throw new NothingChanged()
          const before = (link?.mark ?? null) as StatementMark | null
          if (link)
            await tx.wexPaymentDocument.update({
              where: { wexPaymentId_documentId: { wexPaymentId: id, documentId } },
              data: { purpose: 'payment', mark: value, marks: [value] },
            })
          else
            await tx.wexPaymentDocument.create({
              data: {
                wexPaymentId: id,
                documentId,
                purpose: 'payment',
                mark: value,
                marks: [value],
              },
            })
          return before
        },
        (before) => ({
          workspaceId: r.workspaceId!,
          resource,
          subjectId: id,
          action: 'update',
          description: before
            ? `Changed the marked line on ${describe(doc, 'the')} for ${subject}`
            : `Linked ${describe(doc)} to ${subject} as evidence of payment and marked the line`,
          changes: changesOf(markValues(before), markValues(mark), MARK_FIELDS),
        })
      )
      await this.checks.refresh(r.id)
    })
    return this.reports.fresh(caller, r.id)
  }
}
