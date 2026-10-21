import { Injectable, NotFoundException } from '@nestjs/common'
import type { AiFileFacts, PayrollDocumentKind, StatementLine } from '@ad/types'
import { AccessLogService } from '../core/access-log.service'
import { workspaceRole, type Caller } from '../core/caller'
import { PrismaService } from '../prisma/prisma.service'
import {
  aiReadPayrollFile,
  PAYROLL_AI_MODEL,
  payrollAiAvailable,
  payrollAiBeta,
} from './ai-read-payroll'

/** How many files one request reads with AI at most (the screen sends them a few at a time, to show its progress). */
export const AI_FILES_PER_CALL = 3

/** A file of a match to read with AI: its contents' sha256, its bytes, and the lines the job read from it. */
export interface AiFile {
  id: string
  sha256: string
  kind: string
  contentType: string
  documentId: string | null
  lines: unknown
  bytes: () => Promise<Buffer>
}

/**
 * What AI read from payroll files, when a person asked for it on either match screen (GitHub issue #22; owner's
 * decisions, 2026-10-19), kept by each file's contents in the workspace (`PayrollFileAiReading`, migration
 * 20261019000500) so every later match of the same file uses it, as a period given is.
 */
@Injectable()
export class PayrollAiService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly log: AccessLogService
  ) {}

  /** Whether the server may read payroll files with AI (a key, and zero data retention declared). */
  available(): boolean {
    return payrollAiAvailable()
  }

  /** Puts what AI read (if anything) on each file, by its contents. */
  async attach<F extends { sha256: string; ai?: AiFileFacts | null }>(
    workspaceId: string,
    files: F[]
  ): Promise<F[]> {
    const shas = [...new Set(files.map((f) => f.sha256))]
    const rows = shas.length
      ? await this.prisma.payrollFileAiReading.findMany({
          where: { workspaceId, sha256: { in: shas } },
          select: { sha256: true, facts: true },
        })
      : []
    const by = new Map(rows.map((r) => [r.sha256, r.facts as unknown as AiFileFacts]))
    for (const f of files) f.ai = by.get(f.sha256) ?? null
    return files
  }

  /** The screen's word of which files AI has read, and which it read nothing from. */
  static summary(files: { id: string; ai?: AiFileFacts | null }[]) {
    const read = files.filter((f) => !!f.ai)
    return {
      available: payrollAiAvailable(),
      beta: payrollAiBeta(),
      read: read.map((f) => f.id),
      nothing: read.filter((f) => !!f.ai!.note).map((f) => f.id),
    }
  }

  /**
   * An owner or bookkeeper reads some files of their match with AI: each file in its own request, with the names on the
   * lists; what it found, checked against the file, is kept with the file's contents. One access-log line, counts only.
   * A file AI could not read keeps the rules' reading. Bank statements are never sent: their debit is found by amount.
   */
  async read(
    caller: Caller,
    workspaceId: string,
    files: AiFile[],
    names: string[],
    screen: string
  ): Promise<void> {
    if (!workspaceRole(caller, workspaceId, ['owner', 'bookkeeper']) || !this.available())
      throw new NotFoundException()
    const sendable = files.filter((f) => f.kind !== 'bank-statement').slice(0, AI_FILES_PER_CALL)
    if (!sendable.length) return
    const found = await Promise.all(
      sendable.map(async (f) => ({
        f,
        facts: await aiReadPayrollFile(
          {
            kind: f.kind as PayrollDocumentKind,
            bytes: await f.bytes(),
            contentType: f.contentType,
            lines: (Array.isArray(f.lines) ? f.lines : []) as StatementLine[],
          },
          names
        ),
      }))
    )
    const read = found.filter((x): x is { f: AiFile; facts: AiFileFacts } => !!x.facts)
    await this.log.change(
      caller,
      async (tx) => {
        for (const { f, facts } of read)
          await tx.payrollFileAiReading.upsert({
            where: { workspaceId_sha256: { workspaceId, sha256: f.sha256 } },
            create: {
              workspaceId,
              sha256: f.sha256,
              kind: f.kind,
              facts: facts as object,
              model: PAYROLL_AI_MODEL,
              readById: caller.userId,
            },
            update: {
              facts: facts as object,
              model: PAYROLL_AI_MODEL,
              readById: caller.userId,
              readAt: new Date(),
            },
          })
        return { workspaceId }
      },
      {
        workspaceId,
        resource: 'document',
        action: 'read',
        description: `Read ${sendable.length} payroll file${sendable.length === 1 ? '' : 's'} with AI in ${screen}${
          read.length < sendable.length
            ? ` (${sendable.length - read.length} couldn't be read)`
            : ''
        }`,
      }
    )
  }
}
