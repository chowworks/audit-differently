import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Prisma } from '@prisma/client'
import {
  DELETE_PHRASE,
  RETAINED_COPY_DAYS,
  type DeletionExportDto,
  type DeletionSummaryDto,
} from '@ad/types'
import { AccessLogService } from '../core/access-log.service'
import { allow, staffName, tenantWhere, workspaceRole, type Caller } from '../core/caller'
import { howMany, monthName } from '../core/changes'
import { runAsSystem } from '../core/tenant-context'
import { keyInWorkspace } from '../documents/documents.service'
import { AuditPackageService, csv, safe } from '../engagements/audit-package.service'
import { strToU8 } from 'fflate'
import {
  splitParts,
  streamPart,
  type ExportContent,
  type ExportObject,
  type PartLayout,
} from '../engagements/export-parts'
import { PrismaService } from '../prisma/prisma.service'
import { DOCUMENT_STORAGE, type DocumentStorage } from '../storage/document-storage.interface'

/** How long after the export starts the owner may still delete with it. */
const EXPORT_VALID_MS = 60 * 60 * 1000

export interface ConfirmBody {
  deletionId?: string
  confirmName?: string
  confirmPhrase?: string
}

/** One zip of an export as kept on the DeletionRecord. */
interface StoredPart extends PartLayout {
  /** Where our own copy of this part is kept. */
  key: string
  status: 'pending' | 'downloaded'
  bytes?: number
  sha256?: string
}

const storedParts = (json: unknown): StoredPart[] => (Array.isArray(json) ? json : [])

/** An export's content and which of its paths are personal records (for the access log's words). */
type Content = ExportContent & { personalPaths: Set<string> }

/** A part built and ready to send: what the response headers say, and `send`, which writes it. */
export interface PartFile {
  fileName: string
  bytes: number
  sha256: string
  send(res: Writable): Promise<void>
}

const write = (w: Writable, chunk: Uint8Array) =>
  new Promise<void>((resolve, reject) => {
    if (w.destroyed) return reject(new Error('The connection closed'))
    w.write(chunk, (err) => (err ? reject(err) : resolve()))
  })

/** Ends a stream and waits until it has finished and closed; a stream already torn down is a failure. */
const end = (w: Writable) =>
  new Promise<void>((resolve, reject) => {
    if (w.destroyed) return reject(new Error('The connection closed'))
    w.once('error', reject)
    w.once('close', () =>
      w.writableFinished ? resolve() : reject(new Error('The connection closed early'))
    )
    w.end()
  })

/**
 * Deleting an engagement, or a workspace once it has no engagement, is permanent and owner-only. The order is
 * fixed: the owner downloads a full export (we keep our own copy under `retained/` for RETAINED_COPY_DAYS, which
 * an R2 lifecycle rule expires), a DeletionRecord marks the download finished, and only then does a delete that
 * names the record, the exact name and the phrase run. The access log is written first, the stored files go
 * before the rows (a failed attempt can be repeated; the other order would strand private files nobody lists),
 * and the rows go in one transaction.
 */
@Injectable()
export class DeletionService {
  private readonly logger = new Logger(DeletionService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly log: AccessLogService,
    private readonly audit: AuditPackageService,
    @Inject(DOCUMENT_STORAGE) private readonly storage: DocumentStorage
  ) {}

  // ── Who and what ──────────────────────────────────────────────────────────

  /** The engagement, if the caller sees it (404 otherwise) and owns its workspace (403 otherwise). */
  private async ownedEngagement(caller: Caller, id: string) {
    const c = await this.prisma.engagement.findFirst({ where: { id, ...tenantWhere(caller) } })
    if (!c) throw new NotFoundException()
    allow(workspaceRole(caller, c.workspaceId, ['owner']), 'Only an owner deletes an engagement')
    return c
  }

  private async ownedWorkspace(caller: Caller, id: string) {
    if (!caller.workspaceIds.includes(id)) throw new NotFoundException()
    const w = await this.prisma.workspace.findFirst({ where: { id } })
    if (!w) throw new NotFoundException()
    allow(workspaceRole(caller, id, ['owner']), 'Only an owner deletes a workspace')
    return w
  }

  async engagementSummary(caller: Caller, id: string): Promise<DeletionSummaryDto> {
    await this.ownedEngagement(caller, id)
    const [months, participants, documents] = await Promise.all([
      this.prisma.monthlyReport.count({ where: { engagementId: id } }),
      this.prisma.participant.count({ where: { engagementId: id } }),
      this.prisma.document.count({ where: { engagementId: id } }),
    ])
    return { months, participants, documents }
  }

  async workspaceSummary(caller: Caller, id: string): Promise<DeletionSummaryDto> {
    await this.ownedWorkspace(caller, id)
    const documents = await this.prisma.document.count({
      where: { workspaceId: id, engagementId: null },
    })
    return { months: 0, participants: 0, documents, hasWorkspaceDocuments: documents > 0 }
  }

  // ── The export ────────────────────────────────────────────────────────────

  /**
   * Starts an export: works out the files, splits them into parts of at most about 1.5 GB of source data, and
   * writes the DeletionRecord that names every part. Nothing is built or sent yet, so nothing is logged here; each
   * part is built, and logged, when it is downloaded (`downloadEngagementPart`). One "Download export" click is one
   * line.
   */
  async exportEngagement(caller: Caller, id: string): Promise<DeletionExportDto> {
    const c = await this.ownedEngagement(caller, id)
    const plan = await this.audit.plan(caller, id, { complete: true })
    return this.begin(caller, {
      workspaceId: c.workspaceId,
      engagementId: id,
      subjectName: c.name,
      keyName: id,
      content: plan,
    })
  }

  async exportWorkspace(caller: Caller, id: string): Promise<DeletionExportDto> {
    const w = await this.ownedWorkspace(caller, id)
    await this.noEngagements(id)
    const content = await this.workspaceContent(caller, w)
    return this.begin(caller, {
      workspaceId: id,
      engagementId: null,
      subjectName: w.name,
      keyName: 'workspace',
      content,
    })
  }

  private async noEngagements(workspaceId: string) {
    const engagements = await this.prisma.engagement.count({ where: { workspaceId } })
    if (engagements > 0)
      throw new ConflictException('Delete the engagements first; a workspace is deleted when empty')
  }

  /** The workspace's own documents (filed to no engagement) as an export. */
  private async workspaceContent(
    caller: Caller,
    w: { id: string; name: string }
  ): Promise<Content> {
    const docs = await this.prisma.document.findMany({
      where: { workspaceId: w.id, engagementId: null },
      orderBy: { uploadedAt: 'asc' },
    })
    const objects: ExportObject[] = []
    const index: (string | number)[][] = [['File', 'Document type', 'Uploaded']]
    const seen = new Set<string>()
    const personalPaths = new Set<string>()
    const root = safe(`${w.name} - workspace records`)
    for (const d of docs) {
      if (!keyInWorkspace(d)) throw new NotFoundException()
      let path = `${root}/${safe(d.fileName)}`
      let n = 2
      while (seen.has(path))
        path = `${root}/${safe(d.fileName).replace(/(\.[^.]+)?$/, ` (${n++})$1`)}`
      seen.add(path)
      if (d.sensitivity === 'personal') personalPaths.add(path)
      objects.push([path, d.storageKey, d.size ?? 0])
      index.push([path.slice(root.length + 1), d.kind, d.uploadedAt.toISOString().slice(0, 10)])
    }
    return {
      name: `${root}.zip`,
      objects,
      text: {
        [`${root}/README.txt`]: strToU8(
          [
            `WORKSPACE RECORDS: ${w.name}`,
            `Generated ${new Date().toISOString()} by ${staffName(caller)} from Audit Differently.`,
            'The documents filed to the workspace itself, not to an engagement, as they were uploaded.',
            'This is the full copy taken before the workspace was deleted.',
            '',
          ].join('\n')
        ),
        [`${root}/Index.csv`]: strToU8(csv(index)),
      },
      personalPaths,
    }
  }

  /** Writes the DeletionRecord with its parts; the owner then downloads each part. */
  private async begin(
    caller: Caller,
    o: {
      workspaceId: string
      engagementId: string | null
      subjectName: string
      keyName: string
      content: ExportContent
    }
  ): Promise<DeletionExportDto> {
    const now = new Date()
    const stamp = now.toISOString().replace(/[:.]/g, '-')
    const layouts = splitParts(o.content)
    // The one key outside the workspace-first layout: a top-level `retained/` prefix, so one lifecycle rule on the
    // bucket expires every retained copy. It is never a Document row and nothing serves it.
    const prefix = `retained/${o.workspaceId}/${o.keyName}`
    const parts: StoredPart[] = layouts.map((l) => ({
      ...l,
      key: `${prefix}-part${l.n}-${stamp}.zip`,
      status: 'pending',
    }))
    const rec = await this.prisma.deletionRecord.create({
      data: {
        workspaceId: o.workspaceId,
        engagementId: o.engagementId,
        subjectName: o.subjectName,
        deletedById: caller.userId,
        // The column keeps its name; like the access log's actorName it holds the owner's email (staffName).
        deletedByName: staffName(caller),
        exportKey: `${prefix}-${stamp}`,
        parts: parts as unknown as Prisma.InputJsonValue,
        expiresAt: new Date(now.getTime() + RETAINED_COPY_DAYS * 24 * 60 * 60 * 1000),
      },
    })
    return {
      deletionId: rec.id,
      parts: layouts.map((l) => ({ n: l.n, fileName: l.fileName, sourceBytes: l.sourceBytes })),
    }
  }

  async downloadEngagementPart(
    caller: Caller,
    id: string,
    deletionId: string,
    n: number
  ): Promise<PartFile> {
    const c = await this.ownedEngagement(caller, id)
    const rec = await this.openRecord(c.workspaceId, id, deletionId)
    const plan = await this.audit.plan(caller, id, { complete: true })
    return this.buildPart(caller, rec, n, plan)
  }

  async downloadWorkspacePart(
    caller: Caller,
    id: string,
    deletionId: string,
    n: number
  ): Promise<PartFile> {
    const w = await this.ownedWorkspace(caller, id)
    await this.noEngagements(id)
    const rec = await this.openRecord(id, null, deletionId)
    return this.buildPart(caller, rec, n, await this.workspaceContent(caller, w))
  }

  /** The record this export belongs to, while it can still be downloaded: not deleted, within the hour. */
  private async openRecord(workspaceId: string, engagementId: string | null, deletionId: string) {
    const rec = await this.prisma.deletionRecord.findFirst({
      where: { id: deletionId, workspaceId },
    })
    if (!rec || rec.engagementId !== engagementId) throw new NotFoundException()
    if (rec.status === 'deleted')
      throw new BadRequestException('This export was already used to delete')
    if (Date.now() - rec.createdAt.getTime() > EXPORT_VALID_MS)
      throw new BadRequestException('That export is more than an hour old; start a fresh one')
    return rec
  }

  /**
   * Builds part `n` into a temporary file (so its exact size and sha256 are known before the first byte is
   * sent), keeps our own copy under `retained/`, and returns the file ready to send. A repeat download builds
   * the part again and overwrites our copy. The files must still be the ones the export was planned from.
   */
  private async buildPart(
    caller: Caller,
    rec: {
      id: string
      workspaceId: string
      engagementId: string | null
      subjectName: string
      parts: unknown
    },
    n: number,
    content: Content
  ): Promise<PartFile> {
    const parts = storedParts(rec.parts)
    const stored = Number.isInteger(n) ? parts[n - 1] : undefined
    if (!stored) throw new NotFoundException()
    const planned = new Set(parts.flatMap((p) => p.paths))
    if (planned.size !== content.objects.length || !content.objects.every((o) => planned.has(o[0])))
      throw new ConflictException(
        'The records changed after this export was prepared. Close this window and start the export again.'
      )
    // Logged before a byte is built or sent: no export leaves without its line. So the line says the download
    // started, which is true even when it then fails and is tried again (each try is its own line).
    const subject = rec.engagementId ? rec.subjectName : `the workspace ${rec.subjectName}`
    const personal = stored.paths.some((p) => content.personalPaths.has(p))
    await this.log.log(caller, {
      workspaceId: rec.workspaceId,
      resource: 'export',
      subjectId: rec.id,
      action: 'export',
      description: `Started downloading ${parts.length > 1 ? `part ${n} of ${parts.length} of ` : ''}the full export of ${subject} before deleting it: ${howMany(stored.paths.length, 'file')}${personal ? ', personal records included' : ''}`,
    })
    const dir = await mkdtemp(join(tmpdir(), 'ad-export-'))
    try {
      const file = join(dir, 'part.zip')
      const out = createWriteStream(file)
      const hash = createHash('sha256')
      let bytes = 0
      try {
        for await (const chunk of streamPart(content, parts, n, (key) => this.storage.read(key))) {
          hash.update(chunk)
          bytes += chunk.length
          await write(out, chunk)
        }
      } catch (e) {
        out.destroy()
        throw e
      }
      await end(out)
      await this.storage.putFile(stored.key, file, bytes, 'application/zip')
      const sha256 = hash.digest('hex')
      return {
        fileName: stored.fileName,
        bytes,
        sha256,
        send: (res) => this.sendPart(rec.id, n, { dir, file, bytes, sha256 }, res),
      }
    } catch (e) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
      throw e
    }
  }

  /**
   * Sends the built file. The part is 'downloaded' when the response has finished, and the record when every
   * part is; a download that fails part way leaves both as they were, which no delete accepts.
   */
  private async sendPart(
    recordId: string,
    n: number,
    built: { dir: string; file: string; bytes: number; sha256: string },
    res: Writable
  ): Promise<void> {
    try {
      await pipeline(createReadStream(built.file), res)
      await this.markDownloaded(recordId, n, built.bytes, built.sha256)
    } catch (e) {
      this.logger.error(
        `Deletion export ${recordId} part ${n} did not finish: ${(e as Error).message}`
      )
      // Cut the response short so the browser sees a failed download, never a good-looking partial zip.
      res.destroy()
    } finally {
      await rm(built.dir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  /**
   * Marks part `n` done, and the record 'downloaded' once every part is. Two parts finishing at the same moment
   * can overwrite each other's mark; that leaves one part pending, which the owner downloads again. It never
   * marks anything done that is not.
   */
  private async markDownloaded(recordId: string, n: number, bytes: number, sha256: string) {
    const rec = await this.prisma.deletionRecord.findFirst({ where: { id: recordId } })
    if (!rec) throw new Error('The deletion record is gone')
    const parts = storedParts(rec.parts).map((p) =>
      p.n === n ? { ...p, status: 'downloaded' as const, bytes, sha256 } : p
    )
    await this.prisma.deletionRecord.update({
      where: { id: recordId },
      data: {
        parts: parts as unknown as Prisma.InputJsonValue,
        ...(parts.every((p) => p.status === 'downloaded') ? { status: 'downloaded' } : {}),
      },
    })
  }

  // ── The delete ────────────────────────────────────────────────────────────

  /** The confirmation words and the finished export, checked. Returns the record to close, if one was needed. */
  private async confirm(
    workspaceId: string,
    engagementId: string | null,
    name: string,
    body: ConfirmBody,
    needRecord: boolean
  ) {
    if (body?.confirmName !== name) throw new BadRequestException('Type the name exactly as shown')
    if (body.confirmPhrase !== DELETE_PHRASE)
      throw new BadRequestException(`Type "${DELETE_PHRASE}" to confirm`)
    if (!needRecord && !body.deletionId) return null
    const rec =
      typeof body.deletionId === 'string'
        ? await this.prisma.deletionRecord.findFirst({
            where: { id: body.deletionId, workspaceId },
          })
        : null
    if (!rec || rec.engagementId !== engagementId)
      throw new BadRequestException('Download the full export for this first')
    if (rec.status !== 'downloaded')
      throw new BadRequestException(
        rec.status === 'deleted'
          ? 'This export was already used to delete'
          : 'The export did not finish downloading; download it again'
      )
    const parts = storedParts(rec.parts)
    const open = parts.find((p) => p.status !== 'downloaded')
    if (open)
      throw new BadRequestException(
        `Part ${open.n} of ${parts.length} of the export did not finish downloading; download it again`
      )
    if (Date.now() - rec.createdAt.getTime() > EXPORT_VALID_MS)
      throw new BadRequestException('That export is more than an hour old; download a fresh one')
    return rec
  }

  async deleteEngagement(caller: Caller, id: string, body: ConfirmBody): Promise<void> {
    const c = await this.ownedEngagement(caller, id)
    const rec = (await this.confirm(c.workspaceId, id, c.name, body, true))!
    const { shared, staffKept, decidedKept } = await this.sharedOnlyHere(c.workspaceId, id)
    const sharedIds = shared.map((d) => d.id)
    await this.log.log(caller, {
      workspaceId: c.workspaceId,
      resource: 'engagement',
      subjectId: id,
      action: 'delete',
      description: `Deleted the engagement ${c.name} permanently, after its full export${shared.length ? `, with ${howMany(shared.length, 'workspace payroll file')} no other engagement uses` : ''}${staffKept ? `; ${howMany(staffKept, 'workspace payroll file')} it alone linked kept, as staff payroll proof still uses ${staffKept === 1 ? 'it' : 'them'}` : ''}${decidedKept ? `; ${howMany(decidedKept, 'workspace payroll file')} it alone linked kept, as an owner marked pays on ${decidedKept === 1 ? 'it' : 'them'} not grant-funded` : ''}`,
    })
    const folder = `${c.workspaceId}/${id}/`
    await this.storage.deleteByPrefix(folder)
    // The engagement's documents go first: an engagement delete would otherwise try to unlink them, which their
    // storage-key trigger refuses. Months go before the engagement so a payment is never left pointing at a
    // participant that is already gone (WexPayment -> Participant is Restrict).
    const { gone, runs } = await this.prisma.$transaction(async (tx) => {
      // The workspace payroll files that may go, locked: a link or an upload taking one in meanwhile waits for this,
      // then finds it gone; one made first is seen below, and the file stays.
      if (sharedIds.length)
        await tx.$queryRaw`SELECT "id" FROM "Document" WHERE "id" = ANY(${sharedIds}::text[]) FOR UPDATE`
      // An upload not saved yet that holds one of this engagement's documents (a month's run) or one of those files
      // (the workspace's run) is discarded, as Discard does, each with its line: the database keeps a document while
      // an upload holds it (PayrollMatchFile -> Document, Restrict).
      const runs = await tx.payrollMatchRun.findMany({
        where: {
          workspaceId: c.workspaceId,
          OR: [
            { monthlyReport: { engagementId: id } },
            ...(sharedIds.length ? [{ files: { some: { documentId: { in: sharedIds } } } }] : []),
          ],
        },
        include: { files: true, monthlyReport: { select: { period: true } } },
      })
      if (runs.length) {
        await tx.payrollMatchRun.deleteMany({ where: { id: { in: runs.map((r) => r.id) } } })
        for (const run of runs) {
          const period = run.period ?? run.monthlyReport?.period
          await this.log.also(tx, caller, {
            workspaceId: c.workspaceId,
            resource: run.monthlyReportId ? 'report' : 'workspace',
            subjectId: run.monthlyReportId ?? c.workspaceId,
            action: 'delete',
            description: `Removed an unsaved ${run.monthlyReportId ? '' : 'workspace '}payroll match${period ? ` for ${monthName(period)}` : ''} (${howMany(run.files.filter((f) => !f.documentId).length, 'staged file')}) with the engagement ${c.name}`,
          })
        }
      }
      await tx.document.deleteMany({ where: { engagementId: id } })
      await tx.monthlyReport.deleteMany({ where: { engagementId: id } })
      // Its links went with its months; a workspace payroll file nothing links now goes too, its pays with it. One that
      // staff payroll proof (StaffPayProof) still uses stays: it is still in its month's set of payroll files. So does
      // one with a pay an owner marked not grant-funded, which would otherwise go with it unseen.
      let gone: string[] = []
      if (sharedIds.length) {
        const unlinked = await tx.document.findMany({
          where: {
            id: { in: sharedIds },
            engagementId: null,
            expenses: { none: {} },
            wexPayments: { none: {} },
            staffPayProofs: { none: {} },
            payLines: { none: { notFundedReason: { not: null } } },
          },
          select: { id: true },
        })
        gone = unlinked.map((d) => d.id)
        if (gone.length) await tx.document.deleteMany({ where: { id: { in: gone } } })
      }
      await tx.engagement.delete({ where: { id } })
      await tx.deletionRecord.update({
        where: { id: rec.id },
        data: { status: 'deleted', deletedAt: new Date() },
      })
      return { gone, runs }
    })
    // Only now, with the rows gone for good: the stored objects of the workspace files that went, and those the
    // discarded uploads staged outside this engagement's folder. A failure here is a leftover object, never a link
    // to a missing file.
    const drop = (key: string) =>
      this.storage
        .delete(key)
        .catch((e: Error) => this.logger.error(`Could not delete ${key}: ${e.message}`))
    for (const d of shared) if (gone.includes(d.id)) await drop(d.storageKey)
    for (const run of runs)
      for (const f of run.files)
        if (
          !f.documentId &&
          f.storageKey.startsWith(`${c.workspaceId}/`) &&
          !f.storageKey.startsWith(folder)
        )
          await drop(f.storageKey)
    // A file uploaded while this ran has no row now; sweep again.
    await this.storage.deleteByPrefix(folder).catch((e: Error) => this.logger.error(e.message))
  }

  /**
   * The workspace payroll files (one file proving several engagements' items, migration 20261017000500) that this
   * engagement's payroll items link and no other engagement's do: they go with it. One still linked elsewhere stays,
   * with only this engagement's links gone; the export of this engagement includes each either way (its audit package
   * files them through the links). One that staff payroll proof still uses (what the match found of a person on the
   * staff list) stays too, still one of its month's payroll files: `staffKept` counts them, for the log line. So does
   * one with a pay an owner marked not grant-funded (the owner's decision, kept with its file): `decidedKept`.
   */
  private async sharedOnlyHere(workspaceId: string, engagementId: string) {
    const docs = await this.prisma.document.findMany({
      where: {
        workspaceId,
        engagementId: null,
        OR: [
          { expenses: { some: { expense: { engagementId } } } },
          { wexPayments: { some: { wexPayment: { monthlyReport: { engagementId } } } } },
        ],
      },
      include: {
        expenses: { select: { expense: { select: { engagementId: true } } } },
        wexPayments: {
          select: { wexPayment: { select: { monthlyReport: { select: { engagementId: true } } } } },
        },
        _count: {
          select: {
            staffPayProofs: true,
            payLines: { where: { notFundedReason: { not: null } } },
          },
        },
      },
    })
    const onlyHere = docs.filter(
      (d) =>
        keyInWorkspace(d) &&
        d.expenses.every((x) => x.expense.engagementId === engagementId) &&
        d.wexPayments.every((x) => x.wexPayment.monthlyReport.engagementId === engagementId)
    )
    const usedByStaff = (d: (typeof docs)[number]) => (d._count?.staffPayProofs ?? 0) > 0
    const decided = (d: (typeof docs)[number]) => !usedByStaff(d) && (d._count?.payLines ?? 0) > 0
    return {
      shared: onlyHere.filter((d) => !usedByStaff(d) && !decided(d)),
      staffKept: onlyHere.filter(usedByStaff).length,
      decidedKept: onlyHere.filter(decided).length,
    }
  }

  async deleteWorkspace(caller: Caller, id: string, body: ConfirmBody): Promise<void> {
    const w = await this.ownedWorkspace(caller, id)
    const engagements = await this.prisma.engagement.count({ where: { workspaceId: id } })
    if (engagements > 0)
      throw new ConflictException('Delete the engagements first; a workspace is deleted when empty')
    const documents = await this.prisma.document.count({ where: { workspaceId: id } })
    const rec = await this.confirm(id, null, w.name, body, documents > 0)
    await this.log.log(caller, {
      workspaceId: id,
      resource: 'workspace',
      subjectId: id,
      action: 'delete',
      description: `Deleted the workspace ${w.name} permanently${rec ? ', after its full export' : ', with no documents to export'}`,
    })
    const folder = `${id}/`
    await this.storage.deleteByPrefix(folder)
    await this.prisma.$transaction(async (tx) => {
      // An upload not saved yet holds documents the database keeps while it does (PayrollMatchFile -> Document,
      // Restrict); it goes with the workspace, its staged objects with the folder.
      await tx.payrollMatchRun.deleteMany({ where: { workspaceId: id } })
      await tx.document.deleteMany({ where: { workspaceId: id } })
      if (rec)
        await tx.deletionRecord.update({
          where: { id: rec.id },
          data: { status: 'deleted', deletedAt: new Date() },
        })
    })
    // Trusted work, and only now that the caller is known to own this empty workspace: the policy admits nobody
    // else. Memberships and suggestions go with it; the access log has no foreign key and stays.
    await runAsSystem(() => this.prisma.workspace.delete({ where: { id } }))
    await this.storage.deleteByPrefix(folder).catch((e: Error) => this.logger.error(e.message))
  }
}
