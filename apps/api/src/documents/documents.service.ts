import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import { createHash, randomUUID } from 'node:crypto'

/** Where an object is filed: by workspace, then by engagement (or 'workspace' for none), then by month or 'general'. */
export function objectFolder(doc: {
  workspaceId: string
  engagementId?: string | null
  period?: string | null
}): string {
  return `${doc.workspaceId}/${doc.engagementId ?? 'workspace'}/${doc.period ?? 'general'}/`
}

/**
 * Every object lives under its workspace and engagement (the database enforces the key on write, migrations
 * 20261011000600 and ..0700); a row that says otherwise is tampered or broken, and nothing is served from it.
 */
export function keyInWorkspace(doc: {
  storageKey: string
  workspaceId: string
  engagementId?: string | null
}): boolean {
  return doc.storageKey.startsWith(`${doc.workspaceId}/${doc.engagementId ?? 'workspace'}/`)
}
import {
  ALLOWED_UPLOAD_TYPES,
  DOCUMENT_KIND_LABELS,
  DOCUMENT_KINDS,
  DOCUMENT_SENSITIVITY,
  MONTH_PROOF_KINDS,
  personalRolesFor,
  WRITE_ROLES,
  type DocumentDto,
  type DocumentKind,
  type DocumentPurpose,
  type Role,
} from '@ad/types'
import { AccessLogService } from '../core/access-log.service'
import { allow, tenantWhere, workspaceRole, type Caller } from '../core/caller'
import { howMany, monthName } from '../core/changes'
import { ServiceFailureLog } from '../core/service-failure-log'
import { EngagementsService } from '../engagements/engagements.service'
import { ParticipantsService } from '../participants/participants.service'
import { PrismaService } from '../prisma/prisma.service'
import { dayWords } from '../reports/reopenings'
import { refuseLocked, ReportsService } from '../reports/reports.service'
import { DOCUMENT_STORAGE, type DocumentStorage } from '../storage/document-storage.interface'
import { documentDto, type UploadResult } from './document.dto'
import { describe, StagedFile } from './staged-file'

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

/** The first bytes each allowed type starts with; Office files are zip archives. */
const SIGNATURES: Record<string, Buffer[]> = {
  'application/pdf': [Buffer.from('%PDF-')],
  'image/png': [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  'image/jpeg': [Buffer.from([0xff, 0xd8, 0xff])],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': [Buffer.from('PK\x03\x04')],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': [
    Buffer.from('PK\x03\x04'),
  ],
}

/** Whether the bytes begin the way files of `mimetype` do; the browser's claim alone is never trusted. */
export function looksLike(buffer: Buffer, mimetype: string): boolean {
  const starts = SIGNATURES[mimetype]
  if (!starts) return false
  return starts.some(
    (sig) => buffer.length >= sig.length && buffer.subarray(0, sig.length).equals(sig)
  )
}

/**
 * The fields of POST /documents. Beside where the file is filed, at most one of: `attachTo` with `attachId` and
 * `purpose` (put it in a record's proof slot), `replaces` (put it in place of an unattached document), or
 * `clearsWaiver` (the engagement's reason this kind was missing goes). Each is one transaction with one line.
 */
export interface UploadBody {
  workspaceId: string
  kind: DocumentKind
  period?: string
  engagementId?: string
  attachTo?: string
  attachId?: string
  purpose?: string
  replaces?: string
  clearsWaiver?: string
}

/** Why the attach list was opened, to word its line. It picks the words only: the list is always logged. */
export interface ListContext {
  for?: string
  id?: string
}

export type Uploaded = { originalname: string; mimetype: string; size: number; buffer: Buffer }

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly log: AccessLogService,
    @Inject(DOCUMENT_STORAGE) private readonly storage: DocumentStorage,
    private readonly reports: ReportsService,
    private readonly participants: ParticipantsService,
    private readonly engagements: EngagementsService,
    private readonly failures: ServiceFailureLog
  ) {}

  /** Checks an upload (who, what kind, which bytes, where) and readies it; nothing is stored yet. */
  async stage(caller: Caller, file: Uploaded, body: UploadBody): Promise<StagedFile> {
    if (!caller.workspaceIds.includes(body.workspaceId))
      throw new NotFoundException('No such workspace')
    allow(
      workspaceRole(caller, body.workspaceId, WRITE_ROLES),
      'Only an owner or bookkeeper uploads'
    )
    if (!DOCUMENT_KINDS.includes(body.kind))
      throw new BadRequestException('kind is not one of the allowed values')
    const ext = ALLOWED_UPLOAD_TYPES[file.mimetype]
    if (ext && !looksLike(file.buffer, file.mimetype))
      throw new BadRequestException(`The file does not look like a ${ext}`)
    if (!ext)
      throw new BadRequestException(
        `Uploads must be one of: ${Object.values(ALLOWED_UPLOAD_TYPES).join(', ')}`
      )
    if (file.size > MAX_UPLOAD_BYTES) throw new BadRequestException('Uploads are limited to 25 MB')
    if (body.period && !/^\d{4}-\d{2}$/.test(body.period))
      throw new BadRequestException('period must be YYYY-MM')
    if (body.engagementId) {
      const c = await this.prisma.engagement.findFirst({
        where: { id: body.engagementId, workspaceId: body.workspaceId },
      })
      if (!c) throw new BadRequestException('engagementId is not an engagement of this workspace')
    }
    const where = {
      workspaceId: body.workspaceId,
      engagementId: body.engagementId || null,
      period: body.period || null,
    }
    return new StagedFile(
      this.storage,
      {
        ...where,
        kind: body.kind,
        sensitivity: DOCUMENT_SENSITIVITY[body.kind],
        fileName: file.originalname.replace(/[^\w.() -]+/g, '_').slice(0, 200),
        contentType: file.mimetype,
        size: file.size,
        sha256: createHash('sha256').update(file.buffer).digest('hex'),
        storageKey: `${objectFolder(where)}${randomUUID()}.${ext}`,
        uploadedById: caller.userId,
      },
      file.buffer,
      () => void this.failures.record('upload', 'POST /api/documents')
    )
  }

  /**
   * One upload, one transaction, one line: the file alone, or the file and what it is for (a record's proof, the
   * replacement of an unattached document, or the end of a "no such document" reason). A refused request stores
   * nothing and logs nothing; a failed save deletes the stored object again.
   */
  async upload(caller: Caller, file: Uploaded, body: UploadBody): Promise<UploadResult> {
    const staged = await this.stage(caller, file, body)
    const chosen = [body.attachTo, body.replaces, body.clearsWaiver].filter(Boolean).length
    if (chosen > 1)
      throw new BadRequestException('An upload attaches, replaces or clears a reason, not more')
    if (body.attachTo) {
      if (!body.attachId || !body.purpose)
        throw new BadRequestException('attachTo needs attachId and purpose')
      const purpose = body.purpose
      if (body.attachTo === 'expense') {
        const report = await this.reports.attachToExpense(
          caller,
          body.attachId,
          purpose as DocumentPurpose,
          staged
        )
        return { ...documentDto(staged.row!), report }
      }
      if (body.attachTo === 'wex') {
        const report = await this.reports.attachToWex(
          caller,
          body.attachId,
          purpose as DocumentPurpose,
          staged
        )
        return { ...documentDto(staged.row!), report }
      }
      if (body.attachTo === 'participant') {
        const engagementId = await this.participants.attach(caller, body.attachId, purpose, staged)
        // The engagement as its page now shows it, unlogged: an upload is a change, not the page being opened.
        const engagement = await this.engagements.detail(caller, engagementId)
        return { ...documentDto(staged.row!), engagement }
      }
      throw new BadRequestException('attachTo must be expense, wex or participant')
    }
    // Attaching checks the record's month itself (`ReportsService.editable`); a file filed alone under a month does here.
    await this.refuseLockedMonth(staged.data)
    if (body.replaces) return documentDto(await this.replace(caller, staged, body.replaces))
    if (body.clearsWaiver === 'true')
      return documentDto(await this.uploadClearingWaiver(caller, staged))
    if (body.clearsWaiver) throw new BadRequestException('clearsWaiver must be true')
    const doc = await staged.commit(() =>
      this.log.change(
        caller,
        (tx) => staged.create(tx),
        (made) => ({
          workspaceId: made.workspaceId,
          resource: 'document',
          subjectId: made.id,
          action: 'create',
          description: `Uploaded ${describe(made)}`,
        })
      )
    )
    return documentDto(doc)
  }

  /** "Replace": the new file takes the place of one that is attached to nothing; the old row and object go. */
  private async replace(caller: Caller, staged: StagedFile, oldId: string) {
    const old = await this.prisma.document.findFirst({
      where: { id: oldId, ...tenantWhere(caller) },
    })
    if (!old || old.workspaceId !== staged.data.workspaceId) throw new NotFoundException()
    // Refused before anything is stored: an attached file is detached where it is used first.
    await this.assertUnattached(this.prisma, oldId)
    await this.refuseLockedMonth(old)
    await this.refuseSubmittedSigned(old)
    if (!keyInWorkspace(old)) throw new NotFoundException()
    const made = await staged.commit(() =>
      this.log.change(
        caller,
        async (tx) => {
          await this.assertUnattached(tx, oldId)
          const doc = await staged.create(tx)
          await tx.document.delete({ where: { id: oldId } })
          return doc
        },
        (doc) => ({
          workspaceId: doc.workspaceId,
          resource: 'document',
          subjectId: doc.id,
          action: 'update',
          description: `Replaced ${describe(doc, 'the')}`,
        })
      )
    )
    await this.dropStored(caller, old)
    return made
  }

  /** A file on hand for a record the engagement said was missing: the upload and the reason's removal, together. */
  private async uploadClearingWaiver(caller: Caller, staged: StagedFile) {
    const engagementId = staged.data.engagementId
    if (!engagementId) throw new BadRequestException('clearsWaiver needs an engagementId')
    const kind = staged.data.kind
    const { doc } = await staged.commit(() =>
      this.log.change(
        caller,
        async (tx) => {
          const doc = await staged.create(tx)
          const e = await tx.engagement.findFirst({ where: { id: engagementId } })
          const waivers = { ...((e?.waivers ?? {}) as Record<string, string>) }
          const had = !!waivers[kind]
          if (had) {
            delete waivers[kind]
            await tx.engagement.update({ where: { id: engagementId }, data: { waivers } })
          }
          return { doc, had }
        },
        ({ doc, had }) => ({
          workspaceId: doc.workspaceId,
          resource: 'document',
          subjectId: doc.id,
          action: 'create',
          description: had
            ? `Uploaded ${describe(doc, 'the')} and removed the reason it was missing`
            : `Uploaded ${describe(doc)}`,
          // The reason as the engagement's details name it (ENGAGEMENT_FIELDS), never its words.
          changes: had ? [{ field: `No ${DOCUMENT_KIND_LABELS[kind]} (reason)` }] : undefined,
        })
      )
    )
    return doc
  }

  /**
   * A month's ledger proof (MONTH_PROOF_KINDS) filed under a month is added, replaced or removed only while that month
   * is a draft. The signed report, and any file with no month or no month's report yet, are never held back.
   */
  private async refuseLockedMonth(doc: {
    engagementId?: string | null
    period?: string | null
    kind: string
  }): Promise<void> {
    if (!doc.engagementId || !doc.period) return
    if (!(MONTH_PROOF_KINDS as readonly string[]).includes(doc.kind)) return
    const month = await this.prisma.monthlyReport.findFirst({
      where: { engagementId: doc.engagementId, period: doc.period },
      select: { status: true, period: true },
    })
    if (month) refuseLocked(month)
  }

  /**
   * The signed copy that went to the funder is never replaced or removed: one a reopening kept (ReportReopening), or
   * the one on file when the submitted month was submitted. The corrected copy is attached beside it.
   */
  private async refuseSubmittedSigned(doc: {
    id: string
    workspaceId: string
    engagementId?: string | null
    period?: string | null
    kind: string
    uploadedAt: Date
  }): Promise<void> {
    if (doc.kind !== 'signed-report' || !doc.engagementId || !doc.period) return
    const kept = await this.prisma.reportReopening.findFirst({
      where: { workspaceId: doc.workspaceId, signedDocumentId: doc.id },
      orderBy: { reopenedAt: 'asc' },
      select: { submittedAt: true },
    })
    let submittedAt = kept?.submittedAt
    if (!submittedAt) {
      const month = await this.prisma.monthlyReport.findFirst({
        where: { engagementId: doc.engagementId, period: doc.period },
        select: { status: true, submittedAt: true },
      })
      if (month?.status === 'submitted' && month.submittedAt && doc.uploadedAt <= month.submittedAt)
        submittedAt = month.submittedAt
    }
    if (submittedAt)
      throw new ConflictException(
        `This is the signed copy that was submitted on ${dayWords(submittedAt)}; attach the corrected one alongside it`
      )
  }

  private async assertUnattached(
    db: Pick<Prisma.TransactionClient, 'document'>,
    id: string
  ): Promise<void> {
    const d = await db.document.findFirst({
      where: { id },
      include: { _count: { select: { expenses: true, participants: true, wexPayments: true } } },
    })
    if (!d) throw new NotFoundException()
    const uses = d._count.expenses + d._count.participants + d._count.wexPayments
    if (uses > 0)
      throw new ConflictException(
        `This document is attached to ${uses} record${uses === 1 ? '' : 's'}; detach it there first`
      )
  }

  /**
   * After a removal committed, the stored object goes too. If storage refuses, the person's request still stands:
   * the leftover is written to the server log and the access log, by document id and key, so it can be found.
   */
  private async dropStored(
    caller: Caller,
    doc: { id: string; workspaceId: string; kind: string; storageKey: string }
  ): Promise<void> {
    try {
      await this.storage.delete(doc.storageKey)
    } catch (e) {
      this.logger.error(
        `Document ${doc.id}: its file ${doc.storageKey} could not be deleted from storage: ${(e as Error).message}`
      )
      await this.log
        .log(caller, {
          workspaceId: doc.workspaceId,
          resource: 'document',
          subjectId: doc.id,
          action: 'delete',
          description: `The file of a removed ${DOCUMENT_KIND_LABELS[doc.kind as DocumentKind] ?? 'document'} could not be deleted from storage`,
        })
        .catch((err: unknown) =>
          this.logger.error(
            `Document ${doc.id}: the access log line for its leftover file failed: ${(err as Error).message}`
          )
        )
    }
  }

  /**
   * The workspace's documents, for picking proof. `context` (why the list was opened) only words the line; the
   * list is logged whatever it says.
   */
  async list(
    caller: Caller,
    workspaceId: string,
    context: ListContext = {}
  ): Promise<DocumentDto[]> {
    if (!caller.workspaceIds.includes(workspaceId)) throw new NotFoundException('No such workspace')
    const docs = await this.prisma.document.findMany({
      where: { AND: [{ workspaceId }, tenantWhere(caller)] },
      orderBy: { uploadedAt: 'desc' },
      take: 300,
    })
    const listed = howMany(docs.length, 'document')
    await this.log.log(caller, {
      workspaceId,
      resource: 'document',
      action: 'list',
      description: `Listed ${listed}${await this.listedFor(caller, workspaceId, context)}`,
    })
    return docs.map(documentDto)
  }

  /** " to choose proof for expense 1001", or " of the workspace" when the context names no record of this workspace. */
  private async listedFor(caller: Caller, workspaceId: string, context: ListContext) {
    const everything = ' of the workspace'
    const id = typeof context.id === 'string' ? context.id : ''
    if (!id) return everything
    const where = { id, AND: [{ workspaceId }, tenantWhere(caller)] }
    if (context.for === 'expense') {
      const e = await this.prisma.expense.findFirst({ where, select: { itemNumber: true } })
      if (e) return ` to choose proof for expense ${e.itemNumber}`
    }
    if (context.for === 'wex') {
      const w = await this.prisma.wexPayment.findFirst({
        where,
        select: { monthlyReport: { select: { period: true } } },
      })
      if (w)
        return ` to choose proof for a work-experience payment in ${monthName(w.monthlyReport.period)}`
    }
    return everything
  }

  /** Removes a document that is attached to nothing: the row and the file. */
  async remove(caller: Caller, id: string): Promise<void> {
    const doc = await this.prisma.document.findFirst({
      where: { id, ...tenantWhere(caller) },
      include: { _count: { select: { expenses: true, participants: true, wexPayments: true } } },
    })
    if (!doc) throw new NotFoundException()
    allow(
      workspaceRole(caller, doc.workspaceId, WRITE_ROLES),
      'Only an owner or bookkeeper removes'
    )
    const uses = doc._count.expenses + doc._count.participants + doc._count.wexPayments
    if (uses > 0)
      throw new ConflictException(
        `This document is attached to ${uses} record${uses === 1 ? '' : 's'}; detach it there first`
      )
    // A row whose key says another workspace is tampered or broken: nothing is deleted and nothing logged.
    if (!keyInWorkspace(doc)) throw new NotFoundException()
    await this.refuseLockedMonth(doc)
    await this.refuseSubmittedSigned(doc)
    await this.log.change(caller, (tx) => tx.document.delete({ where: { id } }), {
      workspaceId: doc.workspaceId,
      resource: 'document',
      subjectId: doc.id,
      action: 'delete',
      description: `Removed ${describe(doc)}`,
    })
    await this.dropStored(caller, doc)
  }

  /**
   * Removes a month's payroll document even while it proves payroll items, for "Replace this month's payroll files":
   * its links to those items go in the same transaction as the row and its access-log line, then the file. The
   * month must be a draft (the caller checked) and the document one of the month's payroll documents.
   */
  async removeReplaced(caller: Caller, doc: Prisma.DocumentGetPayload<object>): Promise<void> {
    allow(
      workspaceRole(caller, doc.workspaceId, WRITE_ROLES),
      'Only an owner or bookkeeper replaces payroll files'
    )
    if (!keyInWorkspace(doc)) throw new NotFoundException()
    await this.refuseLockedMonth(doc)
    await this.refuseSubmittedSigned(doc)
    await this.log.change(
      caller,
      async (tx) => {
        await tx.expenseDocument.deleteMany({ where: { documentId: doc.id } })
        await tx.wexPaymentDocument.deleteMany({ where: { documentId: doc.id } })
        return tx.document.delete({ where: { id: doc.id } })
      },
      {
        workspaceId: doc.workspaceId,
        resource: 'document',
        subjectId: doc.id,
        action: 'delete',
        description: `Removed ${describe(doc)} when replacing the month's payroll files`,
      }
    )
    await this.dropStored(caller, doc)
  }

  /**
   * A short-lived link to the file. Personal documents: shorter, fewer roles, download only and logged as such, except
   * a pay stub, which opens in the browser like the other payroll files (owner's decision, 2026-10-16).
   */
  async url(caller: Caller, id: string): Promise<{ url: string; expiresInSeconds: number }> {
    const doc = await this.prisma.document.findFirst({ where: { id, ...tenantWhere(caller) } })
    if (!doc) throw new NotFoundException()
    const personal = doc.sensitivity === 'personal'
    if (personal) {
      const roles = [...personalRolesFor(doc.kind)] as Role[]
      if (!workspaceRole(caller, doc.workspaceId, roles))
        throw new ForbiddenException(
          'Personal documents are open to owners and auditors only (pay stubs to bookkeepers too)'
        )
    }
    const expiresInSeconds = personal ? 60 : 120
    const download = personal && doc.kind !== 'paystub'
    if (!keyInWorkspace(doc)) throw new NotFoundException()
    const url = await this.storage.getSignedUrl(
      doc.storageKey,
      expiresInSeconds,
      download ? { downloadName: doc.fileName } : { inlineName: doc.fileName }
    )
    await this.log.log(caller, {
      workspaceId: doc.workspaceId,
      resource: 'document',
      subjectId: doc.id,
      action: 'read',
      description: `${download ? 'Downloaded' : 'Opened'} ${describe(doc)}`,
    })
    return { url, expiresInSeconds }
  }
}
