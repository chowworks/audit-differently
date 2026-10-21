import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common'
import { Prisma, type InboundReceipt } from '@prisma/client'
import {
  DISMISS_REASONS,
  DISMISS_REASON_LABELS,
  WRITE_ROLES,
  type DismissReason,
  type FileInboundReceiptRequest,
  type InboundReceiptDto,
  type InboundReceiptStatus,
  type ReceiptsInboxDto,
} from '@ad/types'
import { ClerkService } from '../auth/clerk.service'
import { AccessLogService } from '../core/access-log.service'
import {
  CallerService,
  allow,
  staffName,
  tenantWhere,
  workspaceRole,
  type Caller,
} from '../core/caller'
import { changesOf, monthName, type Fields } from '../core/changes'
import { MatchStatsService } from '../core/match-stats.service'
import { identifyCaller, runAsSystem, withTenantContext } from '../core/tenant-context'
import { looksLike, type Uploaded } from '../documents/documents.service'
import { describe } from '../documents/staged-file'
import { EngagementsService } from '../engagements/engagements.service'
import { PrismaService } from '../prisma/prisma.service'
import { readReceipt, type ReceiptRead } from '../receipts/read-receipt'
import {
  MAX_RECEIPT_BYTES,
  RECEIPT_TYPES,
  ReceiptsService,
  readWithAi,
} from '../receipts/receipts.service'
import { inboundConfig, receiptsDomain } from './config'
import { MAX_RAW_BYTES, ProviderError, ResendInbound, type ReceivedAttachment } from './resend'
import { SenderCheck } from './sender-check'

/** Why an emailed receipt was refused, in the inbox's words. */
export const REJECT = {
  noAddress: 'no such address',
  /** An address a workspace used before (ReceiptsAddress, migration 20261017000400). */
  retired: 'this address is no longer in use',
  unverified: 'sender could not be verified',
  notMember: 'not a member',
  noFiles: 'no PDF, PNG or JPG attached',
} as const

/** At most this many attachments of one email are downloaded and looked at; the rest are listed as skipped. */
export const MAX_ATTACHMENTS = 10
/** An image smaller than this is a logo or a signature picture, not a receipt: passed over without a word. */
export const MIN_IMAGE_BYTES = 10 * 1024
/** Minutes to wait after the 1st, 2nd, 3rd and 4th failed attempt; the 5th failure is final. */
export const BACKOFF_MINUTES = [1, 5, 15, 60]
export const MAX_ATTEMPTS = BACKOFF_MINUTES.length + 1
/** A row nobody's (no workspace), or refused or failed for good, is removed after this many days. */
export const UNKNOWN_KEPT_DAYS = 30
/** How long a claim (or a hand filing) holds a row; renewed before each attachment. */
const LEASE_MS = 15 * 60_000
/** Why a row was given up when its last lease ran out with nobody finishing it, in the inbox's words. */
export const STOPPED = 'Filing it stopped part way too many times; run it again'

/**
 * Claims the emailed receipts due now, at most $1, for one worker: a row waiting whose time has come, or one left
 * "processing" by a worker that stopped (its lease, nextAttemptAt, ran out), while it has had fewer than $2 attempts.
 * SKIP LOCKED lets several API processes claim at once without taking the same row; the claim counts the attempt and
 * leases the row for 15 minutes. A row a person is filing by hand ("filing") is never claimed. Only a row sent to
 * this process's own receipts domain ($3) is claimed, so an API set up for another domain (a second developer's
 * laptop on the shared dev database) never takes this one's mail. Parameterized; timestamps are UTC, as Prisma
 * writes them.
 */
export const CLAIM_SQL = `UPDATE "InboundReceipt"
   SET "status" = 'processing', "attempts" = "attempts" + 1,
       "nextAttemptAt" = (now() AT TIME ZONE 'UTC') + interval '15 minutes',
       "updatedAt" = (now() AT TIME ZONE 'UTC')
 WHERE "id" IN (
   SELECT "id" FROM "InboundReceipt"
    WHERE "status" IN ('received', 'processing') AND "nextAttemptAt" <= (now() AT TIME ZONE 'UTC')
      AND "attempts" < $2
      AND right(lower("toAddress"), length($3) + 1) = '@' || $3
    ORDER BY "nextAttemptAt"
    LIMIT $1
    FOR UPDATE SKIP LOCKED)
RETURNING *`

/** Why a row queued with no receipts address was given up, in the inbox's words. */
export const NO_ADDRESS = 'It was not sent to a receipts address'

/**
 * Gives up what a stopped process left behind, once its lease ran out: a row still "processing" after its last attempt
 * ($1) fails for good with the reason $2 (otherwise one whose filing crashes the process would be claimed forever),
 * and a hand filing that stopped part way goes back to "unmatched" for the person to file again. A row queued with no
 * receipts address (before the webhook kept only mail to its own domain) is never claimed: after a day it fails with
 * the reason $3, so it ends and is removed with the others. A row for another domain is left to that domain's API.
 */
export const EXPIRE_SQL = `UPDATE "InboundReceipt"
   SET "status" = CASE WHEN "status" = 'filing' THEN 'unmatched' ELSE 'failed' END,
       "error" = CASE WHEN "status" = 'filing' THEN "error" WHEN "status" = 'received' THEN $3 ELSE $2 END,
       "updatedAt" = (now() AT TIME ZONE 'UTC')
 WHERE ("nextAttemptAt" <= (now() AT TIME ZONE 'UTC')
     AND ("status" = 'filing' OR ("status" = 'processing' AND "attempts" >= $1)))
    OR ("status" = 'received' AND "toAddress" IS NULL
     AND "createdAt" <= (now() AT TIME ZONE 'UTC') - interval '1 day')`

/**
 * The clean-up's delete (purgeOld): rows received before $1 with no workspace, or refused, failed or dismissed for
 * good; never an email refused at a previously used address (no workspace, no sender, reason $2) while that address
 * is held and not released. Every term is true or false, never null, so NOT keeps every other row in the delete.
 * Parameterized.
 */
export const PURGE_SQL = `DELETE FROM "InboundReceipt" r
 WHERE r."receivedAt" < $1
   AND (r."workspaceId" IS NULL OR r."status" IN ('rejected', 'failed', 'dismissed'))
   AND NOT (r."workspaceId" IS NULL AND r."status" = 'rejected' AND r."fromAddress" IS NULL
        AND COALESCE(r."rejectReason", '') = $2
        AND EXISTS (SELECT 1 FROM "ReceiptsAddress" a
                     WHERE a."address" = split_part(r."toAddress", '@', 1)
                       AND a."removedAt" IS NOT NULL AND a."releasedAt" IS NULL))`

/** The row's filed attachments, read and locked inside a filing transaction: a second worker waits, then sees them. */
const LOCK_SQL = `SELECT "filedAttachments" FROM "InboundReceipt" WHERE "id" = $1 FOR UPDATE`

/** Refused for good: written on the row, never tried again by itself. */
class Rejected extends Error {}
/** Filed already, by another worker that held the row a moment ago: this one files nothing. */
class AlreadyFiled extends Error {}
/** Verified, but where it goes is not clear: kept for a person to file. */
class Unmatched extends Error {
  constructor(
    message: string,
    readonly engagementId: string | null = null
  ) {
    super(message)
  }
}

const STATUS_FIELDS: Fields = { status: { label: 'Status', show: 'text' } }

/** The bare address of `Name <a@b.org>` or `a@b.org`, lowercased; null when there is none. */
export function addressOf(value: unknown): string | null {
  // A header longer than any real one is not read at all, so no pattern runs on attacker-sized input.
  if (typeof value !== 'string' || value.length > 1000) return null
  const inAngles = /<([^<>\s@]+@[^<>\s]+)>/.exec(value)
  const bare = (inAngles?.[1] ?? value).trim().toLowerCase()
  return /^[^\s@<>]+@[^\s@<>]+$/.test(bare) && bare.length <= 254 ? bare : null
}

/** Whether the subject names `code` as a whole word (letters, digits and hyphens make a word), in any case. */
export function namesCode(subject: string | null, code: string): boolean {
  if (!subject) return false
  const escaped = code.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')
  return new RegExp(`(^|[^A-Za-z0-9-])${escaped}($|[^A-Za-z0-9-])`, 'i').test(subject)
}

/** The type the bytes say a receipt is: PDF, PNG or JPG; null for anything else. */
const sniff = (buffer: Buffer) => RECEIPT_TYPES.find((t) => looksLike(buffer, t)) ?? null
const EXT: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
}

/**
 * The webhook's event, checked: Resend's `email.received` carries the email's id, sender, recipients and subject, and
 * no body or file (resend.com/docs/webhooks/emails/received). The receipts address is the recipient on our domain;
 * an email to none of our addresses has none (null), and is not kept.
 */
export function parseReceived(payload: unknown, domain: string) {
  const p = (payload ?? {}) as { type?: unknown; data?: Record<string, unknown> }
  if (p.type !== 'email.received' || !p.data || typeof p.data !== 'object')
    throw new BadRequestException('Not an email.received event')
  const d = p.data
  const emailId = typeof d.email_id === 'string' ? d.email_id.trim() : ''
  if (!emailId || emailId.length > 200) throw new BadRequestException('No email id')
  const to = (Array.isArray(d.to) ? d.to : [d.to]).map(addressOf).filter((a): a is string => !!a)
  const ours = to.find((a) => a.endsWith(`@${domain}`)) ?? null
  const at = typeof d.created_at === 'string' ? new Date(d.created_at) : new Date()
  return {
    emailId,
    fromAddress: addressOf(d.from),
    toAddress: ours,
    subject: typeof d.subject === 'string' ? d.subject.slice(0, 300) : null,
    receivedAt: Number.isNaN(at.getTime()) ? new Date() : at,
  }
}

type Target = { engagementId: string; period: string }
type Words = (
  made: { kind: string; sensitivity: string; period: string | null },
  engagement: string
) => string

/**
 * Emailed receipts: the queue the webhook fills, the worker that files each one in the name of the member who sent
 * it, and the receipts inbox where owners and bookkeepers see what became of each and file the ones left unmatched.
 *
 * Trusted work (runAsSystem) is kept to the queue itself, before anyone is known: writing the row, claiming it,
 * finding the workspace from the address, finding the member from the verified sender, and writing what became of
 * it. Everything filed is filed as the member, with no system mark: their roles and row-level security apply as if
 * they had uploaded it. Nothing here sends an email, and the sender gets no reply.
 */
@Injectable()
export class InboundService {
  private readonly logger = new Logger(InboundService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly log: AccessLogService,
    private readonly callers: CallerService,
    private readonly clerk: ClerkService,
    private readonly receipts: ReceiptsService,
    private readonly engagements: EngagementsService,
    private readonly resend: ResendInbound,
    private readonly senders: SenderCheck,
    private readonly stats: MatchStatsService
  ) {}

  // ── The queue ─────────────────────────────────────────────────────────────

  /**
   * The webhook's one job: the email in the queue, once per provider id. A repeated call adds nothing. Any other event
   * type is ignored (false), so the provider counts it delivered and never retries it.
   */
  async enqueue(payload: unknown): Promise<boolean> {
    const cfg = inboundConfig()
    if (!cfg) throw new NotFoundException()
    if ((payload as { type?: unknown } | null)?.type !== 'email.received') return false
    const row = parseReceived(payload, cfg.domain)
    // Mail to another receipts domain (the other environment's, when one email account serves both) is not ours: it is
    // ignored, never kept, so no sender or subject of it is stored here.
    if (!row.toAddress) return false
    // Trusted work: nobody is known yet, and a row with no workspace is app.system's alone (migration 20261015001000).
    await runAsSystem(async () => {
      const retired = await this.retiredAddress(row.toAddress, cfg.domain)
      if (!retired) {
        await this.prisma.inboundReceipt.createMany({ data: [row], skipDuplicates: true })
        return
      }
      // Sent to an address a workspace used before: refused now. Kept with no sender and no subject (nothing of the
      // email but its id, the address and when), once per provider id, so Admin tools → Email administration →
      // Receipts addresses counts it (never a stored count), until the address is released (purgeOld keeps it).
      await this.prisma.inboundReceipt.createMany({
        data: [
          {
            emailId: row.emailId,
            toAddress: row.toAddress,
            receivedAt: row.receivedAt,
            status: 'rejected',
            rejectReason: REJECT.retired,
          },
        ],
        skipDuplicates: true,
      })
    })
    return true
  }

  /**
   * The history row of an address on our domain that a workspace used before and no longer does, not released (at
   * most one: an address is held by one row not released); null otherwise.
   */
  private async retiredAddress(to: string | null, domain: string) {
    const local = to?.endsWith(`@${domain}`) ? to.slice(0, -(domain.length + 1)) : null
    if (!local) return null
    return this.prisma.receiptsAddress.findFirst({
      where: { address: local, removedAt: { not: null }, releasedAt: null },
      select: { id: true },
    })
  }

  /** Claims the rows due now and processes each; the number claimed (0: nothing was due). */
  async runDue(limit = 5): Promise<number> {
    const cfg = inboundConfig()
    if (!cfg) return 0
    // Trusted work: the claim reads and leases rows of every workspace, and rows of none.
    const rows = await runAsSystem(async () => {
      await this.prisma.$executeRawUnsafe(EXPIRE_SQL, MAX_ATTEMPTS, STOPPED, NO_ADDRESS)
      return this.prisma.$queryRawUnsafe<InboundReceipt[]>(
        CLAIM_SQL,
        limit,
        MAX_ATTEMPTS,
        cfg.domain
      )
    })
    for (const row of rows) await this.process(row)
    return rows.length
  }

  /**
   * Removes, after UNKNOWN_KEPT_DAYS, the rows nobody needs: those that never named a workspace (an unknown address, a
   * sender not verified, someone not a member) and those refused or failed for good. Except an email refused at a
   * previously used address (kept by enqueue with no sender): kept while that address is held and not released, so
   * Admin tools counts it; releasing the address removes it (trigger ReceiptsAddress_4_release).
   */
  async purgeOld(now = new Date()): Promise<void> {
    const before = new Date(now.getTime() - UNKNOWN_KEPT_DAYS * 86_400_000)
    // Trusted work: only it sees a row with no workspace, and only it removes a row (migration 20261015001200).
    await runAsSystem(() => this.prisma.$executeRawUnsafe(PURGE_SQL, before, REJECT.retired))
  }

  /** One claimed row, start to end. A failure that may pass is tried again later; after five it is final. */
  async process(row: InboundReceipt): Promise<void> {
    try {
      await this.handle(row)
    } catch (e) {
      if (e instanceof Rejected)
        return this.settle(row.id, { status: 'rejected', rejectReason: e.message, error: null })
      if (e instanceof Unmatched)
        return this.settle(row.id, {
          status: 'unmatched',
          rejectReason: e.message,
          error: null,
          ...(e.engagementId && { engagementId: e.engagementId }),
        })
      // Never the sender, the subject or a file name: the row's id and what kind of failure it was.
      this.logger.warn(
        `Emailed receipt ${row.id}: attempt ${row.attempts} failed (${(e as Error).name})`
      )
      const error = failureWords(e)
      if (row.attempts >= MAX_ATTEMPTS) return this.settle(row.id, { status: 'failed', error })
      const wait = BACKOFF_MINUTES[Math.max(0, row.attempts - 1)]!
      return this.settle(row.id, {
        status: 'received',
        error,
        nextAttemptAt: new Date(Date.now() + wait * 60_000),
      })
    }
  }

  /** What became of a row, written by the worker: the queue's own bookkeeping, as trusted work. */
  private async settle(id: string, data: Prisma.InboundReceiptUncheckedUpdateInput) {
    await runAsSystem(() => this.prisma.inboundReceipt.update({ where: { id }, data }))
  }

  private async handle(row: InboundReceipt): Promise<void> {
    const cfg = inboundConfig()
    if (!cfg) throw new ProviderError('The email provider is not set up')

    // a. Whose address it is. Only looked up here: the row names its workspace once the sender is verified (d), so
    // junk stays nobody's and is purged.
    let workspaceId = row.workspaceId
    if (!workspaceId) {
      const local = row.toAddress?.endsWith(`@${cfg.domain}`)
        ? row.toAddress.slice(0, -(cfg.domain.length + 1))
        : null
      // Trusted work: the address names a workspace nobody here belongs to yet.
      const ws = local
        ? await runAsSystem(() =>
            this.prisma.workspace.findFirst({
              where: { receiptsAddress: local },
              select: { id: true },
            })
          )
        : null
      if (!ws) {
        // Queued while the address was still a workspace's, processed after it changed (or run again): refused as
        // no longer in use. Counted only when it arrives (enqueue), so a retry or a rerun never counts it twice.
        const retired = await runAsSystem(() => this.retiredAddress(row.toAddress, cfg.domain))
        throw new Rejected(retired ? REJECT.retired : REJECT.noAddress)
      }
      // Arrived before this workspace took the address: it was sent to whoever held it then (released since, and
      // chosen again by this one), never to this workspace. Refused as no longer in use.
      const held = await runAsSystem(() =>
        this.prisma.receiptsAddress.findFirst({
          where: { workspaceId: ws.id, address: local!, removedAt: null },
          select: { firstUsedAt: true },
        })
      )
      if (held && held.firstUsedAt > row.receivedAt) throw new Rejected(REJECT.retired)
      workspaceId = ws.id
    }

    // b. That the From line names someone who files receipts here (an owner or bookkeeper, by a verified email),
    // before anything is fetched from the provider.
    if (!row.fromAddress) throw new Rejected(REJECT.unverified)
    const senderId = await this.memberFor(workspaceId, row.fromAddress)
    if (!senderId || (row.senderUserId && row.senderUserId !== senderId))
      throw new Rejected(REJECT.notMember)

    // c. That the sender is who the From line says: the provider's DMARC result, and our own over the raw message. It
    // has one To and one Subject (a second is how a signed message is replayed under new ones), and the receipts
    // address is in a To or Cc header the sender's own aligned signature covers.
    const email = await this.resend.email(row.emailId)
    if (email.authentication?.dmarc !== 'pass' || !email.raw?.download_url)
      throw new Rejected(REJECT.unverified)
    const raw = await this.resend.download(email.raw.download_url, MAX_RAW_BYTES)
    if (!raw) throw new Rejected(REJECT.unverified)
    const verdict = await this.senders.verify(raw, cfg.domain)
    if (
      !verdict.dmarcPass ||
      verdict.headerFrom.length !== 1 ||
      verdict.headerFrom[0] !== row.fromAddress ||
      verdict.toHeaders > 1 ||
      verdict.subjectHeaders > 1 ||
      !row.toAddress ||
      !verdict.signedRecipients.includes(row.toAddress)
    )
      throw new Rejected(REJECT.unverified)

    // d. Whose it is, said once: the workspace together with its verified sender.
    if (!row.workspaceId) await this.settle(row.id, { workspaceId, senderUserId: senderId })
    else if (!row.senderUserId) await this.settle(row.id, { senderUserId: senderId })

    // d. From here on, as that member: a context of their own, set the way a signed-in request's guard sets it.
    await withTenantContext(async () => {
      identifyCaller({ userId: senderId })
      const caller = await this.callers.load(senderId)
      await this.file(
        caller,
        { ...row, workspaceId },
        null,
        (made, name) => `Emailed in ${describe(made)} of ${name}`
      )
    })
  }

  /**
   * The member of `workspaceId` who may file receipts (owner or bookkeeper) and whose verified email `from` is: the
   * address on their User row (taken from Clerk's verified address at sign-in, never an invitation's placeholder), and
   * still one of their verified addresses at Clerk now. Null when there is not exactly one.
   */
  private async memberFor(workspaceId: string, from: string): Promise<string | null> {
    // Trusted work: the sender is not anyone's caller yet; this reads people and memberships to find out who.
    const users = await runAsSystem(() =>
      this.prisma.user.findMany({
        where: {
          email: { equals: from, mode: 'insensitive' },
          NOT: { id: { startsWith: 'pending-' } },
          memberships: { some: { workspaceId, role: { in: [...WRITE_ROLES] } } },
        },
        select: { id: true },
      })
    )
    if (users.length !== 1) return null
    const verified = await this.clerk.verifiedEmails(users[0]!.id)
    return verified.includes(from) ? users[0]!.id : null
  }

  /**
   * Files an emailed receipt's attachments as `caller`: into the engagement its subject names by code (or the
   * workspace's only active engagement, or `target`), each into the draft month of the date read from it (or the date
   * the email arrived), started if it is not yet, matched automatically where it can be. Each file is one transaction
   * with its line and its place on the queue row, which it reads locked first, so neither a retry nor a second worker
   * whose lease overlapped ever files one twice. The lease is renewed before each file.
   */
  private async file(caller: Caller, row: InboundReceipt, target: Target | null, words: Words) {
    const startedAt = new Date()
    const workspaceId = row.workspaceId!
    allow(
      workspaceRole(caller, workspaceId, WRITE_ROLES),
      'Only an owner or bookkeeper files receipts'
    )
    const engagements = await this.prisma.engagement.findMany({
      where: { AND: [{ workspaceId }, tenantWhere(caller)] },
      select: {
        id: true,
        name: true,
        code: true,
        status: true,
        periodStart: true,
        periodEnd: true,
      },
    })
    const e = target
      ? engagements.find((x) => x.id === target.engagementId)
      : pickEngagement(engagements, row.subject)
    if (!e) throw new NotFoundException('No such engagement in this workspace')

    const metas = await this.resend.attachments(row.emailId)
    const { accepted, skipped } = await this.pick(metas, row.filedAttachments)
    if (!accepted.length && !row.documentIds.length) throw new Rejected(REJECT.noFiles)

    // Matching statistics: one row per attempt that files (done) or fails, as this member, written once it ends.
    const counts = { filed: 0, matched: 0, unread: 0, readMs: null as number | null }
    const stat = (outcome: 'done' | 'failed') =>
      this.stats.record({
        workspaceId,
        feature: 'emailed-receipts',
        startedById: caller.userId,
        startedByEmail: staffName(caller),
        startedAt,
        outcome,
        fileCount: accepted.length,
        totalBytes: accepted.reduce((n, a) => n + a.file.size, 0),
        readMs: counts.readMs,
        items: counts.filed,
        matched: counts.matched,
        missing: counts.filed - counts.matched,
        failed: counts.unread,
      })
    try {
      await this.fileAccepted(caller, row, target, words, e, accepted, skipped, counts)
    } catch (err) {
      // Refused or left for a person: what became of the email, not a failed run.
      if (!(err instanceof Rejected) && !(err instanceof Unmatched)) await stat('failed')
      throw err
    }
    await stat('done')
  }

  /** The rest of `file`: read each accepted attachment, then file each into its draft month and match it. */
  private async fileAccepted(
    caller: Caller,
    row: InboundReceipt,
    target: Target | null,
    words: Words,
    e: { id: string; name: string; periodStart: Date | null; periodEnd: Date | null },
    accepted: Awaited<ReturnType<InboundService['pick']>>['accepted'],
    skipped: string[],
    counts: { filed: number; matched: number; unread: number; readMs: number | null }
  ) {
    const workspaceId = row.workspaceId!

    // Nobody is present to say yes, so AI reads them only when the workspace's owners turned it on.
    const ws = await this.prisma.workspace.findFirst({
      where: { id: workspaceId },
      select: { readEmailedReceiptsWithAi: true },
    })
    const withAi = ws?.readEmailedReceiptsWithAi === true
    const reads: { att: (typeof accepted)[number]; read: ReceiptRead; period: string }[] = []
    const readFrom = Date.now()
    for (const att of accepted) {
      const read = await readReceipt(
        { buffer: att.file.buffer, contentType: att.file.mimetype, sensitivity: 'financial' },
        withAi
      )
      const period = target?.period ?? (read.date ?? row.receivedAt.toISOString()).slice(0, 7)
      reads.push({ att, read, period })
    }
    counts.readMs = Date.now() - readFrom
    counts.unread = reads.filter((r) => r.read.amount == null).length
    const months = await this.draftMonths(caller, e, [...new Set(reads.map((r) => r.period))])

    for (const { att, read, period } of reads) {
      await this.prisma.inboundReceipt.update({
        where: { id: row.id },
        data: { nextAttemptAt: new Date(Date.now() + LEASE_MS) },
      })
      try {
        const filed = await this.receipts.fileOne(
          caller,
          months.get(period)!,
          att.file,
          read,
          (made) => `${words(made, e.name)}${readWithAi(read)}`,
          async (tx, documentId) => {
            const [held] = await tx.$queryRawUnsafe<{ filedAttachments: string[] }[]>(
              LOCK_SQL,
              row.id
            )
            if (!held || held.filedAttachments.includes(att.id)) throw new AlreadyFiled()
            return tx.inboundReceipt.update({
              where: { id: row.id },
              data: {
                engagementId: e.id,
                documentIds: { push: documentId },
                filedAttachments: { push: att.id },
              },
            })
          }
        )
        counts.filed++
        if (filed.matched) counts.matched++
      } catch (err) {
        if (!(err instanceof AlreadyFiled)) throw err
      }
    }
    await this.prisma.inboundReceipt.update({
      where: { id: row.id },
      data: {
        status: 'filed',
        engagementId: e.id,
        rejectReason: null,
        error: skipped.length ? `Skipped: ${skipped.join('; ')}`.slice(0, 2000) : null,
      },
    })
  }

  /**
   * The draft month for each period, started when missing ("Start month", logged as the caller), all within the
   * contract period. A month that is closed or submitted, or outside the contract, leaves the receipt unmatched.
   */
  private async draftMonths(
    caller: Caller,
    e: { id: string; name: string; periodStart: Date | null; periodEnd: Date | null },
    periods: string[]
  ): Promise<Map<string, string>> {
    if (!e.periodStart || !e.periodEnd)
      throw new Unmatched(`${e.name} has no contract period yet`, e.id)
    const start = e.periodStart.toISOString().slice(0, 7)
    const end = e.periodEnd.toISOString().slice(0, 7)
    const outside = periods.find((p) => p < start || p > end)
    if (outside)
      throw new Unmatched(`${monthName(outside)} is outside the contract period of ${e.name}`, e.id)
    const find = () =>
      this.prisma.monthlyReport.findMany({
        where: { engagementId: e.id, period: { in: periods }, ...tenantWhere(caller) },
        select: { id: true, period: true, status: true },
      })
    let rows = await find()
    const locked = rows.find((m) => m.status !== 'draft')
    if (locked)
      throw new Unmatched(
        `${monthName(locked.period)} of ${e.name} is ${locked.status === 'closed' ? 'closed' : 'submitted'}`,
        e.id
      )
    for (const p of periods.filter((p) => !rows.some((m) => m.period === p))) {
      try {
        await this.engagements.createReport(caller, e.id, p)
      } catch (err) {
        // Started a moment ago by someone else: use theirs.
        if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'))
          throw err
      }
    }
    rows = await find()
    return new Map(rows.map((m) => [m.period, m.id]))
  }

  /**
   * The attachments that may be receipts: PDF, PNG or JPG by their bytes (never the name or the type the email gives),
   * at most 10 MB each, and at most 10 per email downloaded at all (those filed on an earlier attempt count). The rest
   * are listed by name, as skipped, for the inbox. Pictures in the email's body (inline) and images under 10 KB (a
   * logo, a signature picture) are passed over without a word.
   */
  private async pick(metas: ReceivedAttachment[], filed: string[]) {
    const accepted: { id: string; file: Uploaded }[] = []
    const skipped: string[] = []
    let tried = 0
    for (const a of metas) {
      if (filed.includes(a.id) || a.content_disposition?.toLowerCase() === 'inline') continue
      const image = (a.content_type ?? '').toLowerCase().startsWith('image/')
      if (image && a.size != null && a.size < MIN_IMAGE_BYTES) continue
      const name = (a.filename || 'attachment').replace(/[^\w.() -]+/g, '_').slice(0, 120)
      if (tried + filed.length >= MAX_ATTACHMENTS) {
        skipped.push(`${name} (more than ${MAX_ATTACHMENTS} attachments)`)
        continue
      }
      if ((a.size ?? 0) > MAX_RECEIPT_BYTES) {
        skipped.push(`${name} (over 10 MB)`)
        continue
      }
      tried++
      const buffer = await this.resend.download(a.download_url, MAX_RECEIPT_BYTES)
      if (!buffer) {
        skipped.push(`${name} (over 10 MB)`)
        continue
      }
      const type = sniff(buffer)
      if (!type) {
        skipped.push(`${name} (not a PDF, PNG or JPG)`)
        continue
      }
      if (type !== 'application/pdf' && buffer.length < MIN_IMAGE_BYTES) continue
      const originalname = /\.\w{1,5}$/.test(name) ? name : `${name}.${EXT[type]}`
      accepted.push({
        id: a.id,
        file: { originalname, mimetype: type, size: buffer.length, buffer },
      })
    }
    return { accepted, skipped }
  }

  // ── The receipts inbox ────────────────────────────────────────────────────

  /** The workspace's address and its emailed receipts, newest first. Every member reads it. */
  async inbox(caller: Caller, workspaceId: string): Promise<ReceiptsInboxDto> {
    if (!caller.workspaceIds.includes(workspaceId)) throw new NotFoundException()
    const w = await this.prisma.workspace.findFirst({
      where: { id: workspaceId },
      select: { receiptsAddress: true },
    })
    if (!w) throw new NotFoundException()
    const rows = await this.prisma.inboundReceipt.findMany({
      // A dismissed receipt has been dealt with: it leaves the inbox and goes with the 30-day clean-up.
      where: { AND: [{ workspaceId }, { status: { not: 'dismissed' } }, tenantWhere(caller)] },
      orderBy: { receivedAt: 'desc' },
      take: 100,
    })
    const ids = [...new Set(rows.map((r) => r.engagementId).filter((x): x is string => !!x))]
    const names = new Map(
      (
        await this.prisma.engagement.findMany({
          where: { id: { in: ids }, ...tenantWhere(caller) },
          select: { id: true, name: true },
        })
      ).map((e) => [e.id, e.name])
    )
    const domain = receiptsDomain()
    return {
      address: w.receiptsAddress && domain ? `${w.receiptsAddress}@${domain}` : null,
      configured: !!inboundConfig(),
      items: rows.map((r) => inboundDto(r, names)),
      canManage: workspaceRole(caller, workspaceId, WRITE_ROLES),
    }
  }

  /** "Run again": a failed or unmatched receipt goes back in the queue, due now, with its attempts counted afresh. */
  async runAgain(caller: Caller, id: string): Promise<ReceiptsInboxDto> {
    const row = await this.changeable(caller, id)
    if (row.status !== 'failed' && row.status !== 'unmatched')
      throw new ConflictException('Only a failed receipt or one that needs filing runs again')
    const data = {
      status: 'received',
      attempts: 0,
      nextAttemptAt: new Date(),
      error: null,
      rejectReason: null,
    }
    await this.log.change(caller, (tx) => tx.inboundReceipt.update({ where: { id }, data }), {
      workspaceId: row.workspaceId!,
      resource: 'document',
      subjectId: id,
      action: 'update',
      description: 'Ran an emailed receipt again from the receipts inbox',
      changes: changesOf(row, data, STATUS_FIELDS),
    })
    return this.inbox(caller, row.workspaceId!)
  }

  /**
   * "Dismiss": a receipt that needs filing but should never be filed (personal, a duplicate, not a receipt), or one
   * that failed and the person does not want run again, is put aside with its reason, from a fixed list. It leaves the
   * inbox; the database lets only those two become dismissed, and nothing changes one after (migrations
   * 20261017000100 and 20261018000500).
   */
  async dismiss(caller: Caller, id: string, reason: unknown): Promise<ReceiptsInboxDto> {
    if (!DISMISS_REASONS.includes(reason as DismissReason))
      throw new BadRequestException('Say why it is dismissed')
    const row = await this.changeable(caller, id)
    if (row.status !== 'unmatched' && row.status !== 'failed')
      throw new ConflictException('Only a receipt that needs filing or failed is dismissed')
    const label = DISMISS_REASON_LABELS[reason as DismissReason]
    const data = { status: 'dismissed', rejectReason: label.toLowerCase() }
    await this.log.change(caller, (tx) => tx.inboundReceipt.update({ where: { id }, data }), {
      workspaceId: row.workspaceId!,
      resource: 'document',
      subjectId: id,
      action: 'update',
      description: `Dismissed an emailed receipt from the receipts inbox: ${label.toLowerCase()}`,
      changes: changesOf(row, data, STATUS_FIELDS),
    })
    return this.inbox(caller, row.workspaceId!)
  }

  /**
   * Files an unmatched receipt where the person says: the engagement and the month they choose (a draft month, started
   * if needed). As the person clicking, now, with a line for each file in their name.
   */
  async fileByHand(
    caller: Caller,
    id: string,
    body: Partial<FileInboundReceiptRequest>
  ): Promise<ReceiptsInboxDto> {
    const row = await this.changeable(caller, id)
    if (row.status !== 'unmatched')
      throw new ConflictException('Only a receipt that needs filing is filed by hand')
    if (typeof body?.engagementId !== 'string' || !body.engagementId)
      throw new BadRequestException('Choose the engagement')
    if (typeof body.period !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(body.period))
      throw new BadRequestException('Choose the month, YYYY-MM')
    // Taken while it is filed ("filing", which the worker never claims), so two people filing it at once, or a
    // person and the worker, cannot both file it.
    const claimed = await this.prisma.inboundReceipt.updateMany({
      where: { id, status: 'unmatched', ...tenantWhere(caller) },
      data: { status: 'filing', nextAttemptAt: new Date(Date.now() + LEASE_MS) },
    })
    if (!claimed.count) throw new ConflictException('Someone filed it a moment ago; reload')
    try {
      await this.file(
        caller,
        row,
        { engagementId: body.engagementId, period: body.period },
        (made, name) => `Filed ${describe(made)} of ${name} from the receipts inbox`
      )
    } catch (e) {
      await this.prisma.inboundReceipt.update({ where: { id }, data: { status: 'unmatched' } })
      if (e instanceof Unmatched || e instanceof Rejected) throw new ConflictException(e.message)
      if (e instanceof ProviderError)
        throw new ServiceUnavailableException('The email provider is not answering; try again')
      throw e
    }
    return this.inbox(caller, row.workspaceId!)
  }

  /** A row of the caller's workspace, for a change by an owner or bookkeeper; another workspace's is a 404. */
  private async changeable(caller: Caller, id: string) {
    const row = await this.prisma.inboundReceipt.findFirst({
      where: { id, ...tenantWhere(caller) },
    })
    if (!row?.workspaceId) throw new NotFoundException()
    allow(
      workspaceRole(caller, row.workspaceId, WRITE_ROLES),
      'Only an owner or bookkeeper files emailed receipts'
    )
    return row
  }
}

/** The engagement the subject names by code; else the only active one; else none (unmatched, with the reason). */
function pickEngagement<E extends { id: string; code: string | null; status: string }>(
  engagements: E[],
  subject: string | null
): E {
  const named = engagements.filter((x) => x.code && namesCode(subject, x.code))
  if (named.length === 1) return named[0]!
  if (named.length > 1) throw new Unmatched('The subject names more than one engagement code')
  const active = engagements.filter((x) => x.status === 'active')
  if (active.length === 1) return active[0]!
  throw new Unmatched(
    active.length
      ? `No engagement code in the subject, and ${active.length} engagements are active`
      : 'No engagement code in the subject, and no engagement is active'
  )
}

/** A failure in words that hold nothing personal: our own messages, else what kind of failure it was. */
function failureWords(e: unknown): string {
  if (e instanceof ProviderError || e instanceof HttpException) return e.message.slice(0, 500)
  return 'Something went wrong filing it; it will be tried again'
}

function inboundDto(r: InboundReceipt, names: Map<string, string>): InboundReceiptDto {
  return {
    id: r.id,
    // A hand filing in progress shows as "Working on it".
    status: (r.status === 'filing' ? 'processing' : r.status) as InboundReceiptStatus,
    receivedAt: r.receivedAt.toISOString(),
    fromAddress: r.fromAddress,
    subject: r.subject,
    engagementId: r.engagementId,
    engagementName: r.engagementId ? (names.get(r.engagementId) ?? null) : null,
    documentCount: r.documentIds.length,
    reason: r.rejectReason,
    error: r.error,
    attempts: r.attempts,
  }
}
