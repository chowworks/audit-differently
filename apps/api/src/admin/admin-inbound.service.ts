import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import type { AdminInboundDto, AdminInboundReceiptDto, InboundReceiptStatus } from '@ad/types'
import { AccessLogService } from '../core/access-log.service'
import { staffName, type Caller } from '../core/caller'
import { changesOf, type Fields } from '../core/changes'
import { inboundConfig } from '../inbound/config'
import { PrismaService } from '../prisma/prisma.service'

/** The statuses of a workspace's emailed receipts the admin sees: refused or failed for good. */
const ADMIN_STATUSES = ['rejected', 'failed']
const STATUS_FIELDS: Fields = { status: { label: 'Status', show: 'text' } }

/** What the list reads of a row: the envelope and what became of it, never the attachments or the documents. */
const SELECT = {
  id: true,
  status: true,
  receivedAt: true,
  toAddress: true,
  fromAddress: true,
  subject: true,
  workspaceId: true,
  attempts: true,
  error: true,
  rejectReason: true,
  workspace: { select: { name: true } },
} satisfies Prisma.InboundReceiptSelect
type Row = Prisma.InboundReceiptGetPayload<{ select: typeof SELECT }>

/**
 * Admin tools → Email administration: the emailed receipts that reached no workspace (an unknown address, a sender who
 * could not be verified, a failure before anyone knew whose it was), and a workspace's that were refused or failed
 * (owner's decision, 2026-10-16). Metadata only. Under the admin's mark (AdminGuard), never trusted work: the
 * database lets the mark read and rerun exactly these rows (migration 20261016000100).
 */
@Injectable()
export class AdminInboundService {
  private readonly logger = new Logger(AdminInboundService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly log: AccessLogService
  ) {}

  /** The newest 200, newest first. */
  async list(caller: Caller): Promise<AdminInboundDto> {
    adminOnly(caller)
    const rows = await this.prisma.inboundReceipt.findMany({
      // Said here as well as in the policy: an admin who is also a member sees all of that workspace's rows there.
      where: { OR: [{ workspaceId: null }, { status: { in: ADMIN_STATUSES } }] },
      orderBy: { receivedAt: 'desc' },
      take: 200,
      select: SELECT,
    })
    return { configured: !!inboundConfig(), items: rows.map(dto) }
  }

  /**
   * "Run again": back in the queue, due now, attempts counted afresh, the last error and reason cleared, so the worker
   * processes it with this server's current settings. A workspace's row gets a line in that workspace's access log in
   * the same transaction, written first (the database requires it); a row with no workspace has no log, so the API's
   * own log says it.
   */
  async runAgain(caller: Caller, id: string): Promise<AdminInboundReceiptDto> {
    adminOnly(caller)
    const row = await this.prisma.inboundReceipt.findFirst({
      where: { id, OR: [{ workspaceId: null }, { status: { in: ADMIN_STATUSES } }] },
      select: SELECT,
    })
    if (!row) throw new NotFoundException()
    if (!canRunAgain(row))
      throw new ConflictException(
        'Only a refused or failed email, or one still waiting, runs again'
      )
    const data = {
      status: 'received',
      attempts: 0,
      nextAttemptAt: new Date(),
      error: null,
      rejectReason: null,
    }
    // Only while it is as it was read: the worker may have claimed it a moment ago.
    const write = async (tx: Prisma.TransactionClient) => {
      const { count } = await tx.inboundReceipt.updateMany({
        where: { id, status: row.status, workspaceId: row.workspaceId },
        data,
      })
      if (!count) throw new ConflictException('It changed a moment ago; reload')
    }
    if (row.workspaceId) {
      await this.log.change(
        caller,
        write,
        {
          workspaceId: row.workspaceId,
          resource: 'document',
          subjectId: id,
          action: 'update',
          description: 'Ran an emailed receipt again (by a platform admin)',
          changes: changesOf(row, data, STATUS_FIELDS),
        },
        // The database admits a workspace's row back in the queue only once this line is written.
        { lineFirst: true }
      )
    } else {
      await this.prisma.$transaction(write)
      this.logger.log(
        `${staffName(caller)} (platform admin) ran emailed receipt ${id} again (was ${row.status})`
      )
    }
    // Built from what was written: a workspace's row back in the queue is no longer one the admin reads.
    return dto({ ...row, ...data })
  }
}

function adminOnly(caller: Caller) {
  if (!caller.admin) throw new ForbiddenException('Platform admins only')
}

function canRunAgain(r: Pick<Row, 'status' | 'workspaceId'>): boolean {
  return ADMIN_STATUSES.includes(r.status) || (r.status === 'received' && !r.workspaceId)
}

function dto(r: Row): AdminInboundReceiptDto {
  return {
    id: r.id,
    status: r.status as InboundReceiptStatus,
    receivedAt: r.receivedAt.toISOString(),
    toAddress: r.toAddress,
    fromAddress: r.fromAddress,
    subject: r.subject,
    workspaceId: r.workspaceId,
    workspaceName: r.workspace?.name ?? null,
    attempts: r.attempts,
    reason: r.rejectReason,
    error: r.error,
    canRunAgain: canRunAgain(r),
  }
}
