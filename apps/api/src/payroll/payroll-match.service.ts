import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import {
  DOCUMENT_SENSITIVITY,
  PAYROLL_DOCUMENT_KINDS,
  PAYROLL_REPORT_LINES,
  PAYROLL_SLOT_KIND,
  type PayrollDocumentKind,
  type PayrollMatchFileDto,
  type PayrollMatchProgress,
  type PayrollMatchRunDto,
  type PayrollMatchSaveInput,
  type PayrollSlot,
  type ReportDetail,
  type ReportLine,
  type StatementLine,
} from '@ad/types'
import { ChecksService } from '../checks/checks.service'
import { AccessLogService, type Actor } from '../core/access-log.service'
import { staffName, tenantWhere, type Caller } from '../core/caller'
import { howMany, monthName } from '../core/changes'
import { MatchStatsService, type MatchRun } from '../core/match-stats.service'
import { DocumentsService, keyInWorkspace, type Uploaded } from '../documents/documents.service'
import { describe } from '../documents/staged-file'
import { PrismaService } from '../prisma/prisma.service'
import { ReportsService } from '../reports/reports.service'
import { DOCUMENT_STORAGE, type DocumentStorage } from '../storage/document-storage.interface'
import { matchSlot, slotsOf, type ProofFile, type ProofItem } from './match-proof'
import { cleanMark, MAX_PAYROLL_FILES } from './payroll.service'
import { HighlightSettingsService } from './highlight-settings.service'
import { PayrollMatchWorker, storageName } from './payroll-match.worker'
import type { PageItem } from './statement-lines'
import { itemCopy } from './mark-pdf'

/** A file of the run as the matcher reads it: its lines and its text runs. */
const proofFile = (f: {
  id: string
  kind: string
  fileName: string
  lines: unknown
  items: unknown
}): ProofFile => ({
  id: f.id,
  kind: f.kind as PayrollDocumentKind,
  fileName: f.fileName,
  lines: f.lines as StatementLine[],
  items: f.items as PageItem[],
})

/** A run not saved within this long is removed, its staged files with it. */
export const RUN_HOURS = 24
/** Files one run holds at most: the zip's limit in the wizard. */
export const MAX_RUN_FILES = 200

const PURPOSE: Record<PayrollSlot, string> = {
  timesheet: 'timesheet',
  register: 'register',
  stub: 'payment',
  bank: 'payment',
}
const SLOT_WORDS: Record<PayrollSlot, string> = {
  timesheet: 'timesheet',
  register: 'payroll register',
  stub: 'evidence of payment',
  bank: 'evidence of payment',
}

const isKind = (k: unknown): k is PayrollDocumentKind =>
  typeof k === 'string' && (PAYROLL_DOCUMENT_KINDS as readonly string[]).includes(k)
const day = (d: Date) => d.toISOString().slice(0, 10)

type RunRow = Prisma.PayrollMatchRunGetPayload<{ include: { files: true } }>

/**
 * "Match payroll & timecards" on the server. The zip's files are staged into a run as they arrive (20 at a time), and
 * each PDF is read once for its text, line by line with each line's box; a scanned file has none and is matched by
 * hand. The matches are worked out from those lines whenever the run is fetched (`match-proof.ts`), so nothing about a
 * match is stored until Save. Save files the staged files as the month's documents and links each item to its proof
 * with the line marked, in one transaction; discard, or RUN_HOURS without a Save, removes the run and its staged
 * objects. A run is its starter's alone: an owner or bookkeeper, on a draft month.
 */
@Injectable()
export class PayrollMatchService {
  private readonly logger = new Logger(PayrollMatchService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly log: AccessLogService,
    private readonly checks: ChecksService,
    private readonly reports: ReportsService,
    private readonly documents: DocumentsService,
    private readonly worker: PayrollMatchWorker,
    private readonly highlights: HighlightSettingsService,
    @Inject(DOCUMENT_STORAGE) private readonly storage: DocumentStorage,
    private readonly stats: MatchStatsService
  ) {}

  /**
   * The caller's own unsaved run of the month, for the wizard to pick up where it was (the job keeps reading while it
   * is closed), or null. Opening it is one read line, as `get`.
   */
  async latest(caller: Caller, reportId: string): Promise<PayrollMatchRunDto | null> {
    const r = await this.reports.editable(caller, reportId)
    const run = await this.prisma.payrollMatchRun.findFirst({
      where: {
        monthlyReportId: r.id,
        createdById: caller.userId,
        createdAt: { gte: new Date(Date.now() - RUN_HOURS * 3_600_000) },
        ...tenantWhere(caller),
      },
      orderBy: { createdAt: 'desc' },
    })
    return run ? this.get(caller, run.id) : null
  }

  /** How far the job is: the counts alone, nothing read from a file, so polling it writes no line. */
  async progress(caller: Caller, runId: string): Promise<PayrollMatchProgress> {
    const { run } = await this.open(caller, runId)
    const count = (s: string) => run.files.filter((f) => f.status === s).length
    return { total: run.files.length, read: count('read'), failed: count('failed') }
  }

  /**
   * A new run for the month. Without `replace`, the month's payroll documents already on file join it, read the same
   * way, so they are matched too. The caller's earlier runs of the month, and every run past RUN_HOURS in their
   * workspaces, go first.
   */
  async start(caller: Caller, reportId: string, replace: boolean): Promise<PayrollMatchRunDto> {
    const r = await this.reports.editable(caller, reportId)
    await this.sweep(caller, r.id)
    const run = await this.log.change(
      caller,
      (tx) =>
        tx.payrollMatchRun.create({
          data: { monthlyReportId: r.id, createdById: caller.userId, replace: !!replace },
        }),
      (made) => ({
        workspaceId: made.workspaceId!,
        resource: 'report',
        subjectId: r.id,
        action: 'create',
        description: `Started matching payroll for ${monthName(r.period)}${replace ? ", replacing the month's payroll files" : ''}`,
      })
    )
    if (!replace) {
      const docs = await this.prisma.document.findMany({
        where: {
          engagementId: r.engagementId,
          period: r.period,
          kind: { in: [...PAYROLL_DOCUMENT_KINDS] },
          ...tenantWhere(caller),
        },
        take: MAX_RUN_FILES,
      })
      for (const d of docs) {
        if (!keyInWorkspace(d)) continue
        // Read by the job (payroll-match.worker.ts), as a staged file is.
        await this.prisma.payrollMatchFile.create({
          data: {
            runId: run.id,
            documentId: d.id,
            kind: d.kind,
            sensitivity: d.sensitivity,
            fileName: d.fileName,
            contentType: d.contentType,
            size: d.size,
            sha256: d.sha256,
            storageKey: d.storageKey,
            storage: storageName(),
          },
        })
      }
      if (docs.length) {
        await this.log.log(caller, {
          workspaceId: r.workspaceId!,
          resource: 'document',
          action: 'read',
          description: `Sent ${howMany(docs.length, 'payroll file')} for ${monthName(r.period)} to be read and matched`,
        })
        this.worker.kick()
      }
    }
    return this.dto(await this.load(caller, run.id))
  }

  /** The run, its starter's own, on a month still open for changes. */
  private async open(caller: Caller, runId: string) {
    const run = await this.load(caller, runId)
    if (run.createdById !== caller.userId) throw new NotFoundException()
    const r = await this.reports.editable(caller, run.monthlyReportId)
    if (run.createdAt.getTime() < Date.now() - RUN_HOURS * 3_600_000)
      throw new BadRequestException('This match was left for over a day. Upload the zip again.')
    return { run, r }
  }

  private async load(caller: Caller, runId: string): Promise<RunRow> {
    const run = await this.prisma.payrollMatchRun.findFirst({
      where: { id: runId, ...tenantWhere(caller) },
      include: { files: { orderBy: [{ kind: 'asc' }, { fileName: 'asc' }] } },
    })
    if (!run) throw new NotFoundException()
    return run
  }

  /**
   * Files from the zip, 20 at a time, each with the kind its folder gave it. Each is checked as any upload is (type,
   * bytes, size; sha256 kept) and stored under the month's own keys; the job reads it (payroll-match.worker.ts). Not a
   * document yet.
   */
  async add(
    caller: Caller,
    runId: string,
    files: Uploaded[],
    kinds: unknown
  ): Promise<PayrollMatchRunDto> {
    const { run, r } = await this.open(caller, runId)
    const list = Array.isArray(kinds) ? kinds : kinds == null ? [] : [kinds]
    if (!Array.isArray(files) || !files.length)
      throw new BadRequestException('Choose at least one file')
    if (files.length > MAX_PAYROLL_FILES)
      throw new BadRequestException(`Send at most ${MAX_PAYROLL_FILES} files at a time`)
    if (run.files.length + files.length > MAX_RUN_FILES)
      throw new BadRequestException(`A payroll zip holds at most ${MAX_RUN_FILES} files`)
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
    for (const s of staged)
      await s.commit(() =>
        this.prisma.payrollMatchFile.create({
          data: {
            runId: run.id,
            kind: s.data.kind,
            sensitivity: s.data.sensitivity,
            fileName: s.data.fileName,
            contentType: s.data.contentType,
            size: s.data.size,
            sha256: s.data.sha256,
            storageKey: s.data.storageKey,
            storage: storageName(),
          },
        })
      )
    this.worker.kick()
    await this.log.log(caller, {
      workspaceId: r.workspaceId!,
      resource: 'document',
      action: 'create',
      description: `Sent ${howMany(staged.length, 'payroll file')} for ${monthName(r.period)} to be read and matched`,
    })
    return this.dto(await this.load(caller, run.id))
  }

  /** The run as the wizard shows it, opened again (a reload): one read line. */
  async get(caller: Caller, runId: string): Promise<PayrollMatchRunDto> {
    const { run, r } = await this.open(caller, runId)
    await this.log.log(caller, {
      workspaceId: r.workspaceId!,
      resource: 'document',
      action: 'read',
      description: `Opened the payroll match for ${monthName(r.period)} (${howMany(run.files.length, 'file')})`,
    })
    return this.dto(run)
  }

  /** One file's bytes, for the viewer: every payroll file opens there, a pay stub too. Logged. */
  async file(caller: Caller, runId: string, fileId: string) {
    const { run, r } = await this.open(caller, runId)
    const f = run.files.find((x) => x.id === fileId)
    if (!f || !f.storageKey.startsWith(`${r.workspaceId}/`)) throw new NotFoundException()
    const bytes = await this.storage.read(f.storageKey)
    await this.log.log(caller, {
      workspaceId: r.workspaceId!,
      resource: 'document',
      subjectId: f.documentId,
      action: 'read',
      description: `Opened ${describe({ ...f, period: r.period })} while matching payroll`,
    })
    return { bytes, contentType: f.contentType, fileName: f.fileName }
  }

  /**
   * One item's own copy of a file of the run: the file's own highlight notes removed and only this item's highlights
   * drawn, as Show displays it and as Save will keep it. Not a PDF: the file as uploaded. Logged.
   */
  async copy(
    caller: Caller,
    runId: string,
    fileId: string,
    target: string,
    id: string,
    slot: string
  ): Promise<{ bytes: Uint8Array; contentType: string; fileName: string }> {
    const { run, r } = await this.open(caller, runId)
    const f = run.files.find((x) => x.id === fileId)
    if (!f || !f.storageKey.startsWith(`${r.workspaceId}/`)) throw new NotFoundException()
    const item = (await this.items(r.id)).find((i) => i.target === target && i.id === id)
    if (!item || !slotsOf(item.proof).includes(slot as PayrollSlot)) throw new NotFoundException()
    const highlight = await this.highlights.current()
    const match = matchSlot(
      item.proof,
      slot as PayrollSlot,
      [
        {
          id: f.id,
          kind: f.kind as PayrollDocumentKind,
          fileName: f.fileName,
          lines: f.lines as unknown as StatementLine[],
          items: f.items as unknown as PageItem[],
        },
      ],
      highlight[PAYROLL_SLOT_KIND[slot as PayrollSlot]]
    )
    const c = match.candidates[0]
    const marks = c?.marks.length ? c.marks : c?.mark ? [c.mark] : []
    const original = new Uint8Array(await this.storage.read(f.storageKey))
    const bytes =
      f.contentType === 'application/pdf' ? (await itemCopy(original, marks)).bytes : original
    await this.log.log(caller, {
      workspaceId: r.workspaceId!,
      resource: 'document',
      subjectId: f.documentId,
      action: 'read',
      description: `Opened ${describe({ ...f, period: r.period })} highlighted for ${item.subject} while matching payroll`,
    })
    return { bytes, contentType: f.contentType, fileName: f.fileName }
  }

  /**
   * Save: in one transaction, every staged file becomes one of the month's documents (each with its line), each
   * chosen proof is linked to its item with its line marked (each with its line), and the run goes. Then, for a run
   * that replaces, the month's earlier payroll documents are removed, and the checks run again once.
   */
  async save(caller: Caller, runId: string, input: PayrollMatchSaveInput): Promise<ReportDetail> {
    const { run, r } = await this.open(caller, runId)
    if (run.files.some((f) => f.status === 'waiting' || f.status === 'reading'))
      throw new BadRequestException('The files are still being read. Save once they are done.')
    const items = new Map((await this.items(r.id)).map((i) => [`${i.target}-${i.id}`, i]))
    const links = Array.isArray(input?.links) ? input.links : []
    const highlight = await this.highlights.current()
    if (links.length > 2000) throw new BadRequestException('Too many links at once')
    const files = new Map(run.files.map((f) => [f.id, f]))
    const chosen = links.map((l) => {
      const item = items.get(`${l?.target}-${l?.id}`)
      if (!item) throw new BadRequestException('A payroll item is not of this month')
      if (!slotsOf(item.proof).includes(l.slot))
        throw new BadRequestException(`That proof is not one ${item.proof.kind} pay needs`)
      const f = files.get(l.fileId)
      if (!f || f.kind !== PAYROLL_SLOT_KIND[l.slot])
        throw new BadRequestException(`Choose a ${SLOT_WORDS[l.slot]} of this zip`)
      // The line and the highlights are worked out here, as Show draws them: never taken from the browser.
      const found = matchSlot(
        item.proof,
        l.slot,
        [proofFile(f)],
        highlight[PAYROLL_SLOT_KIND[l.slot]]
      ).candidates[0]
      const mark = found?.mark ? cleanMark(found.mark) : null
      // A bank statement proves a payment by its line alone: with no line found on it, it is not this payment's proof
      // (the line is found under Unmatched payments, after Save).
      if (l.slot === 'bank' && !mark)
        throw new BadRequestException(
          `No line for this payment was found on ${f.fileName}: find it under Unmatched payments after saving`
        )
      const marks = (found?.marks ?? []).slice(0, 20).map(cleanMark)
      return { item, slot: l.slot, file: f, mark, marks }
    })
    const earlier = run.replace
      ? await this.prisma.document.findMany({
          where: {
            engagementId: r.engagementId,
            period: r.period,
            kind: { in: [...PAYROLL_DOCUMENT_KINDS] },
            ...tenantWhere(caller),
          },
        })
      : []
    const staged = run.files.filter((f) => !f.documentId)
    await this.log.change(
      caller,
      async (tx) => {
        const docIds = new Map(run.files.map((f) => [f.id, f.documentId]))
        for (const f of staged) {
          const doc = await tx.document.create({
            data: {
              workspaceId: r.workspaceId!,
              engagementId: r.engagementId,
              period: r.period,
              kind: f.kind,
              sensitivity: DOCUMENT_SENSITIVITY[f.kind as PayrollDocumentKind],
              fileName: f.fileName,
              contentType: f.contentType,
              size: f.size,
              sha256: f.sha256,
              storageKey: f.storageKey,
              uploadedById: caller.userId,
            },
          })
          docIds.set(f.id, doc.id)
          await this.log.also(tx, caller, {
            workspaceId: doc.workspaceId,
            resource: 'document',
            subjectId: doc.id,
            action: 'create',
            description: `Uploaded ${describe(doc)} with the month's payroll`,
          })
        }
        for (const c of chosen) {
          const documentId = docIds.get(c.file.id)!
          const purpose = PURPOSE[c.slot]
          const mark = (c.mark ?? undefined) as object | undefined
          if (c.item.target === 'expense')
            await tx.expenseDocument.upsert({
              where: { expenseId_documentId: { expenseId: c.item.id, documentId } },
              update: { purpose, mark: mark ?? undefined, marks: c.marks as object[] },
              create: {
                expenseId: c.item.id,
                documentId,
                purpose,
                mark,
                marks: c.marks as object[],
              },
            })
          else
            await tx.wexPaymentDocument.upsert({
              where: { wexPaymentId_documentId: { wexPaymentId: c.item.id, documentId } },
              update: { purpose, mark: mark ?? undefined, marks: c.marks as object[] },
              create: {
                wexPaymentId: c.item.id,
                documentId,
                purpose,
                mark,
                marks: c.marks as object[],
              },
            })
          await this.log.also(tx, caller, {
            workspaceId: r.workspaceId!,
            resource: c.item.target === 'expense' ? 'expense' : 'report',
            subjectId: c.item.id,
            action: 'update',
            description: `Linked ${describe({ ...c.file, period: r.period })} to ${c.item.subject} as its ${SLOT_WORDS[c.slot]}${c.mark ? ' and marked the line' : ''}`,
          })
        }
        await tx.payrollMatchRun.delete({ where: { id: run.id } })
        return { workspaceId: r.workspaceId! }
      },
      {
        workspaceId: r.workspaceId!,
        resource: 'report',
        subjectId: r.id,
        action: 'update',
        description: `Saved the payroll match for ${monthName(r.period)}: ${howMany(staged.length, 'file')} filed, ${howMany(chosen.length, 'proof')} linked`,
      },
      { timeout: 60_000 }
    )
    await this.stats.recordWith('payroll', () => this.statOf(caller, run, 'saved'))
    for (const d of earlier) await this.documents.removeReplaced(caller, d)
    await this.checks.refresh(r.id)
    return this.reports.fresh(caller, r.id)
  }

  /** Discard: the run, its rows and its staged objects go; the month is as it was. */
  async discard(caller: Caller, runId: string): Promise<void> {
    const run = await this.load(caller, runId)
    if (run.createdById !== caller.userId) throw new NotFoundException()
    await this.remove(caller, run, 'Discarded', 'discarded')
  }

  /** The caller's earlier runs of this month, and every run of their workspaces past RUN_HOURS. */
  private async sweep(caller: Caller, reportId: string) {
    const old = await this.prisma.payrollMatchRun.findMany({
      where: {
        ...tenantWhere(caller),
        OR: [
          { monthlyReportId: reportId, createdById: caller.userId },
          { createdAt: { lt: new Date(Date.now() - RUN_HOURS * 3_600_000) } },
        ],
      },
      include: { files: true },
    })
    const before = Date.now() - RUN_HOURS * 3_600_000
    for (const run of old)
      await this.remove(
        caller,
        run,
        'Removed an unsaved',
        run.createdAt.getTime() < before ? 'expired' : 'discarded'
      )
  }

  private async remove(
    caller: Caller,
    run: RunRow,
    verb: string,
    outcome: 'discarded' | 'expired'
  ) {
    const r = await this.prisma.monthlyReport.findFirst({
      where: { id: run.monthlyReportId, ...tenantWhere(caller) },
    })
    await this.log.change(caller, (tx) => tx.payrollMatchRun.delete({ where: { id: run.id } }), {
      workspaceId: run.workspaceId!,
      resource: 'report',
      subjectId: run.monthlyReportId,
      action: 'delete',
      description: `${verb} payroll match${r ? ` for ${monthName(r.period)}` : ''} (${howMany(run.files.filter((f) => !f.documentId).length, 'staged file')})`,
    })
    await this.stats.recordWith('payroll', () => this.statOf(caller, run, outcome))
    await this.dropStaged(run)
  }

  /**
   * Trusted work, inside runAsSystem (payroll-match.sweeper.ts, on a timer): every run past RUN_HOURS in every
   * workspace goes, with its staged objects, so a wizard closed and never opened again leaves no pay stub or its text
   * behind. Each removal's line is written in the starter's name in the run's workspace (`AccessLogService.trusted`);
   * a run saved or discarded meanwhile is skipped. The number removed.
   */
  async expireAll(limit = 50): Promise<number> {
    const old = await this.prisma.payrollMatchRun.findMany({
      where: { createdAt: { lt: new Date(Date.now() - RUN_HOURS * 3_600_000) } },
      include: { files: true },
      orderBy: { createdAt: 'asc' },
      take: limit,
    })
    let removed = 0
    for (const run of old)
      try {
        if (await this.expire(run)) removed++
      } catch (e) {
        this.logger.error(
          `Could not remove the expired payroll match ${run.id}: ${(e as Error).message}`
        )
      }
    return removed
  }

  private async expire(run: RunRow): Promise<boolean> {
    const [starter, r] = await Promise.all([
      this.prisma.user.findFirst({ where: { id: run.createdById }, select: { email: true } }),
      this.prisma.monthlyReport.findFirst({
        where: { id: run.monthlyReportId },
        select: { period: true },
      }),
    ])
    const actor = { userId: run.createdById, email: starter?.email ?? null }
    const staged = run.files.filter((f) => !f.documentId).length
    const gone = await this.log.trusted(
      actor,
      (tx) => tx.payrollMatchRun.deleteMany({ where: { id: run.id } }),
      (d) =>
        d.count
          ? [
              {
                workspaceId: run.workspaceId!,
                resource: 'report',
                subjectId: run.monthlyReportId,
                action: 'delete',
                description: `Removed an unsaved payroll match${r ? ` for ${monthName(r.period)}` : ''} left for over ${RUN_HOURS} hours (${howMany(staged, 'staged file')})`,
              },
            ]
          : []
    )
    // Saved or discarded in between: its files are the month's documents now, or already gone.
    if (!gone.count) return false
    await this.stats.recordWith('payroll', () => this.statOf(actor, run, 'expired'))
    await this.dropStaged(run)
    return true
  }

  /** After the run's rows went: the objects it staged, never a document's (a file with `documentId`). */
  private async dropStaged(run: RunRow) {
    for (const f of run.files)
      if (!f.documentId && f.storageKey.startsWith(`${run.workspaceId}/`))
        await this.storage
          .delete(f.storageKey)
          .catch((e: unknown) =>
            this.logger.error(
              `Could not delete the staged object ${f.storageKey}: ${(e as Error).message}`
            )
          )
  }

  /**
   * The run as Matching statistics counts it, when it ends: its files and their size, the time the job spent reading
   * them, and what the matcher found for each proof the month's items need (sure, guessed, nothing). Counts only.
   */
  private async statOf(
    caller: Actor,
    run: RunRow,
    outcome: 'saved' | 'discarded' | 'expired'
  ): Promise<MatchRun> {
    const [items, highlight] = await Promise.all([
      this.items(run.monthlyReportId),
      this.highlights.current(),
    ])
    const files = run.files.map(proofFile)
    const slots = items.flatMap((i) =>
      slotsOf(i.proof).map((slot) =>
        matchSlot(i.proof, slot, files, highlight[PAYROLL_SLOT_KIND[slot]])
      )
    )
    const picked = slots.filter((m) => m.pick)
    const sure = picked.filter((m) => m.candidates.find((c) => c.fileId === m.pick)?.sure).length
    const reads = run.files.map((f) => f.readMs).filter((ms): ms is number => ms != null)
    // Who started it: the caller, or (a run past RUN_HOURS swept by the next one to start) another member.
    const starter =
      run.createdById === caller.userId
        ? staffName(caller)
        : ((
            await this.prisma.user.findFirst({
              where: { id: run.createdById },
              select: { email: true },
            })
          )?.email ?? run.createdById)
    return {
      workspaceId: run.workspaceId!,
      feature: 'payroll',
      startedById: run.createdById,
      startedByEmail: starter,
      startedAt: run.createdAt,
      outcome,
      // The upload: the files sent for this run, not the month's files already on file it read beside them.
      fileCount: run.files.filter((f) => !f.documentId).length,
      totalBytes: run.files.filter((f) => !f.documentId).reduce((n, f) => n + f.size, 0),
      readMs: reads.length ? reads.reduce((n, ms) => n + ms, 0) : null,
      items: items.length,
      matched: sure,
      guessed: picked.length - sure,
      missing: slots.length - picked.length,
      failed: run.files.filter((f) => f.status === 'failed').length,
      bankLines: run.files
        .filter((f) => f.kind === 'bank-statement')
        .reduce((n, f) => n + (Array.isArray(f.lines) ? f.lines.length : 0), 0),
    }
  }

  /** The month's payroll items: its payroll expense lines and its work-experience payments. */
  private async items(reportId: string) {
    const [expenses, wex] = await Promise.all([
      this.prisma.expense.findMany({ where: { monthlyReportId: reportId } }),
      this.prisma.wexPayment.findMany({
        where: { monthlyReportId: reportId },
        include: { participant: true },
      }),
    ])
    return [
      ...expenses
        .filter((e) => PAYROLL_REPORT_LINES.has(e.reportLine as ReportLine))
        .map((e) => ({
          target: 'expense' as const,
          id: e.id,
          subject: `expense ${e.itemNumber}`,
          proof: {
            target: 'expense' as const,
            id: e.id,
            kind: 'staff' as const,
            name: null,
            amount: Number(e.totalCost),
            start: day(e.date),
            end: day(e.date),
          } satisfies ProofItem,
        })),
      ...wex.map((w) => ({
        target: 'wex' as const,
        id: w.id,
        subject: 'a work-experience payment',
        proof: {
          target: 'wex' as const,
          id: w.id,
          kind: 'participant' as const,
          name: w.participant.displayName,
          amount: Number(w.grossAmount),
          start: day(w.payPeriodStart),
          end: day(w.payPeriodEnd),
        } satisfies ProofItem,
      })),
    ]
  }

  private async dto(run: RunRow): Promise<PayrollMatchRunDto> {
    const files: ProofFile[] = run.files.map((f) => ({
      id: f.id,
      kind: f.kind as PayrollDocumentKind,
      fileName: f.fileName,
      lines: f.lines as unknown as StatementLine[],
      items: f.items as unknown as PageItem[],
    }))
    const [items, highlight] = await Promise.all([
      this.items(run.monthlyReportId),
      this.highlights.current(),
    ])
    return {
      id: run.id,
      replace: run.replace,
      expiresAt: new Date(run.createdAt.getTime() + RUN_HOURS * 3_600_000).toISOString(),
      files: run.files.map((f): PayrollMatchFileDto => ({
        id: f.id,
        kind: f.kind as PayrollDocumentKind,
        fileName: f.fileName,
        pages: f.pages,
        scanned: f.scanned,
        status: f.status as PayrollMatchFileDto['status'],
        error: f.error,
        staged: !f.documentId,
        personal: f.sensitivity === 'personal',
      })),
      slots: items.flatMap((i) =>
        slotsOf(i.proof).map((slot) =>
          matchSlot(i.proof, slot, files, highlight[PAYROLL_SLOT_KIND[slot]])
        )
      ),
    }
  }
}
