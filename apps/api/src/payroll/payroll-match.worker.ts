import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import { hostname } from 'node:os'
import { runAsSystem } from '../core/tenant-context'
import { PrismaService } from '../prisma/prisma.service'
import { DOCUMENT_STORAGE, type DocumentStorage } from '../storage/document-storage.interface'
import { readStatement } from './statement-lines'

/** How often the worker looks for payroll files waiting to be read, when nothing woke it sooner. */
export const PAYROLL_TICK_MS = 5_000
/** Tries per file before it is given up as failed. */
export const MAX_READ_ATTEMPTS = 3
/** Files claimed per pass: read one after another, so a pass stays short and other runs get a turn. */
const BATCH = 5

/**
 * The storage this API's objects are in, as a payroll match's file records it (`PayrollMatchFile.storage`, migration
 * 20261016001700): the R2 bucket's name, or this machine's disk (StorageModule's choice).
 */
export function storageName(): string {
  const bucket = process.env.R2_DOCUMENTS_BUCKET
  return bucket ? `r2:${bucket}` : `local:${hostname()}`
}

/**
 * Claims files waiting to be read, at most $1: a waiting one, or one left "reading" by a worker that stopped (its lease
 * ran out), while it has had fewer than $2 tries. SKIP LOCKED lets several API processes claim at once without taking
 * the same file; the claim counts the try and leases the file for 5 minutes. Only a file in this API's own storage ($3,
 * `storageName`) is claimed, or one staged before files said which (null), so an API with another bucket (a second
 * developer's laptop on the shared dev database) never takes, and fails, this one's files. Parameterized; timestamps
 * are UTC, as Prisma writes them.
 */
export const READ_CLAIM_SQL = `UPDATE "PayrollMatchFile"
   SET "status" = 'reading', "attempts" = "attempts" + 1,
       "leaseUntil" = (now() AT TIME ZONE 'UTC') + interval '5 minutes'
 WHERE "id" IN (
   SELECT "id" FROM "PayrollMatchFile"
    WHERE ("status" = 'waiting' OR ("status" = 'reading' AND "leaseUntil" <= (now() AT TIME ZONE 'UTC')))
      AND "attempts" < $2
      AND ("storage" IS NULL OR "storage" = $3)
    ORDER BY "createdAt"
    LIMIT $1
    FOR UPDATE SKIP LOCKED)
RETURNING "id", "workspaceId", "storageKey", "contentType", "attempts"`

/** Gives up a file whose last try stopped part way (its lease ran out after MAX_READ_ATTEMPTS tries). */
export const READ_EXPIRE_SQL = `UPDATE "PayrollMatchFile"
   SET "status" = 'failed', "error" = $2
 WHERE "status" = 'reading' AND "leaseUntil" <= (now() AT TIME ZONE 'UTC') AND "attempts" >= $1`

const STOPPED = 'Reading it stopped part way too many times'
const UNREADABLE = 'This PDF could not be opened'

type Claimed = {
  id: string
  workspaceId: string
  storageKey: string
  contentType: string
  attempts: number
}

/**
 * The job that reads a payroll match's files, inside the API process (owner's decision, 2026-10-16): each PDF's text,
 * page by page, as lines with their boxes, written on the file for matching. Trusted work (runAsSystem, a reviewed
 * path): it finds files in every workspace, and the database lets it change only what reading fills (migration
 * 20261016001300). A file that is not a PDF, or a PDF without text, is read as scanned: matched by hand. Every 5
 * seconds, and at once when files arrive (`kick`); never two passes at once, and never under the tests.
 */
@Injectable()
export class PayrollMatchWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PayrollMatchWorker.name)
  private timer: NodeJS.Timeout | null = null
  private busy = false
  private again = false

  constructor(
    private readonly prisma: PrismaService,
    @Inject(DOCUMENT_STORAGE) private readonly storage: DocumentStorage
  ) {}

  private get off() {
    return process.env.NODE_ENV === 'test' || !!process.env.JEST_WORKER_ID
  }

  onModuleInit(): void {
    if (this.off) return
    this.timer = setInterval(() => void this.tick(), PAYROLL_TICK_MS)
    this.timer.unref()
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Files arrived: read them now rather than at the next tick. */
  kick(): void {
    if (!this.off) void this.tick()
  }

  /** One pass: every file due, in batches. A kick during a pass runs one more. */
  async tick(): Promise<void> {
    if (this.busy) {
      this.again = true
      return
    }
    this.busy = true
    try {
      do {
        this.again = false
        while ((await this.runDue()) > 0) {
          /* the next batch */
        }
      } while (this.again)
    } catch (e) {
      this.logger.error(`The payroll reading worker stopped a pass: ${(e as Error).name}`)
    } finally {
      this.busy = false
    }
  }

  /** Claims the files due and reads each; the number claimed (0: nothing was due). */
  async runDue(limit = BATCH): Promise<number> {
    const files = await runAsSystem(async () => {
      await this.prisma.$executeRawUnsafe(READ_EXPIRE_SQL, MAX_READ_ATTEMPTS, STOPPED)
      return this.prisma.$queryRawUnsafe<Claimed[]>(
        READ_CLAIM_SQL,
        limit,
        MAX_READ_ATTEMPTS,
        storageName()
      )
    })
    for (const f of files) await this.read(f)
    return files.length
  }

  /** Reads one file and writes what it found; a failed try waits for the next, the last one fails the file. */
  async read(f: Claimed): Promise<void> {
    let data: Prisma.PayrollMatchFileUpdateManyMutationInput
    const started = Date.now()
    try {
      // Every object lives under its own workspace: a row that says otherwise is not read.
      if (!f.storageKey.startsWith(`${f.workspaceId}/`))
        throw new Error('key outside its workspace')
      if (f.contentType !== 'application/pdf')
        data = { status: 'read', scanned: true, pages: 0, lines: [], items: [], leaseUntil: null }
      else {
        const text = await readStatement(await this.storage.read(f.storageKey))
        data = {
          status: 'read',
          pages: text.pages,
          scanned: text.scanned,
          lines: text.lines as unknown as Prisma.InputJsonValue,
          items: text.items as unknown as Prisma.InputJsonValue,
          leaseUntil: null,
          error: null,
          // For Matching statistics: how long this file took to read.
          readMs: Date.now() - started,
        }
      }
    } catch (e) {
      const last = f.attempts >= MAX_READ_ATTEMPTS
      this.logger.warn(
        `Reading payroll file ${f.id} failed (try ${f.attempts}): ${(e as Error).message}`
      )
      data = last
        ? { status: 'failed', error: UNREADABLE, scanned: true, leaseUntil: null }
        : { status: 'waiting', leaseUntil: null }
    }
    // A run discarded while its file was read takes the file with it: nothing left to write.
    await runAsSystem(() => this.prisma.payrollMatchFile.updateMany({ where: { id: f.id }, data }))
  }
}
