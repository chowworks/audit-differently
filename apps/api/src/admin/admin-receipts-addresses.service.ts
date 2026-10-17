import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { Prisma, type ReceiptsAddress } from '@prisma/client'
import type { AdminReceiptsAddressDto, AdminReceiptsAddressesDto } from '@ad/types'
import type { Caller } from '../core/caller'
import { receiptsEmail } from '../inbound/config'
import { REJECT } from '../inbound/inbound.service'
import { PrismaService } from '../prisma/prisma.service'

type Since = { id: string; received: number; last: Date | null }

/**
 * The emails refused at each previously used address not yet released, since it was removed, and when the last
 * arrived: one aggregate over the refused rows the webhook keeps (InboundService.enqueue: no workspace, no sender, the
 * "no longer in use" reason), never a stored count. `only` narrows it to one history row. Parameterized.
 */
export function sinceRemovalSql(only: string | null) {
  return Prisma.sql`SELECT a."id", count(r."id")::int AS "received", max(r."receivedAt") AS "last"
  FROM "ReceiptsAddress" a
  JOIN "InboundReceipt" r
    ON r."workspaceId" IS NULL AND r."status" = 'rejected' AND r."fromAddress" IS NULL
   AND r."rejectReason" = ${REJECT.retired}
   AND split_part(r."toAddress", '@', 1) = a."address" AND r."receivedAt" >= a."removedAt"
 WHERE a."removedAt" IS NOT NULL AND a."releasedAt" IS NULL
   ${only ? Prisma.sql`AND a."id" = ${only}` : Prisma.empty}
 GROUP BY a."id"`
}

/**
 * Admin tools → Email administration → Receipts addresses: every receipts address a workspace has used (migration
 * 20261017000400), with how many emails still arrived at a previously used one since it was removed, so an admin can
 * judge whether it is safe to hand out again, and release it. Under the admin's mark (AdminGuard), never trusted work:
 * the database lets the mark read every row and release a previously used one, and says who released it and when. No
 * line goes in the workspace's access log (owner's decision, 2026-10-17): its owners never see this.
 */
@Injectable()
export class AdminReceiptsAddressesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Previously used and not released first (the ones to judge), most recently removed first; then the current ones,
   * then the released ones, by address.
   */
  async list(caller: Caller): Promise<AdminReceiptsAddressesDto> {
    adminOnly(caller)
    const rows = await this.prisma.receiptsAddress.findMany({
      orderBy: [{ removedAt: { sort: 'desc', nulls: 'last' } }, { address: 'asc' }],
    })
    const [names, since] = await Promise.all([
      this.workspaceNames(rows.map((r) => r.workspaceId)),
      this.prisma.$queryRaw<Since[]>(sinceRemovalSql(null)),
    ])
    const byId = new Map(since.map((s) => [s.id, s]))
    const group = (d: AdminReceiptsAddressDto) => (d.releasedAt ? 2 : d.removedAt ? 0 : 1)
    const items = rows.map((r) => dto(r, names.get(r.workspaceId) ?? null, byId.get(r.id)))
    // A stable sort, so each group keeps the order above.
    return { items: items.sort((a, b) => group(a) - group(b)) }
  }

  /**
   * Releases a previously used address, so any workspace may choose it again; never a workspace's current one. Only
   * while no email has arrived since the admin saw the count (`seen`): otherwise 409, to look again. The database sets
   * who and when, and removes the address's kept refused emails in the same statement.
   */
  async release(caller: Caller, id: string, seen: unknown): Promise<AdminReceiptsAddressesDto> {
    adminOnly(caller)
    if (typeof seen !== 'number' || !Number.isInteger(seen) || seen < 0)
      throw new BadRequestException('Say how many emails you saw since it was removed')
    const row = await this.prisma.receiptsAddress.findFirst({ where: { id } })
    if (!row) throw new NotFoundException()
    if (!row.removedAt)
      throw new ConflictException("A workspace's current receipts address is never released")
    if (row.releasedAt) throw new ConflictException('It was released already; reload')
    await this.prisma.$transaction(async (tx) => {
      const [now] = await tx.$queryRaw<Since[]>(sinceRemovalSql(id))
      if ((now?.received ?? 0) !== seen)
        throw new ConflictException('An email arrived since you opened this page; reload')
      const { count } = await tx.receiptsAddress.updateMany({
        where: { id, removedAt: { not: null }, releasedAt: null },
        // The database replaces the time with its own and names the admin (trigger ReceiptsAddress_4_release).
        data: { releasedAt: new Date() },
      })
      if (!count) throw new ConflictException('It changed a moment ago; reload')
    })
    return this.list(caller)
  }

  /** Workspaces' names today (the admin's mark reads every workspace); a deleted one has none. */
  private async workspaceNames(ids: string[]): Promise<Map<string, string>> {
    if (!ids.length) return new Map()
    const ws = await this.prisma.workspace.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: { id: true, name: true },
    })
    return new Map(ws.map((w) => [w.id, w.name]))
  }
}

function adminOnly(caller: Caller) {
  if (!caller.admin) throw new ForbiddenException('Platform admins only')
}

function dto(
  r: ReceiptsAddress,
  workspaceName: string | null,
  since: Since | undefined
): AdminReceiptsAddressDto {
  return {
    id: r.id,
    address: r.address,
    email: receiptsEmail(r.address),
    workspaceId: r.workspaceId,
    workspaceName,
    firstUsedAt: r.firstUsedAt.toISOString(),
    removedAt: r.removedAt?.toISOString() ?? null,
    receivedSinceRemoval: since?.received ?? 0,
    lastReceivedAt: since?.last ? new Date(since.last).toISOString() : null,
    releasedAt: r.releasedAt?.toISOString() ?? null,
    releasedByEmail: r.releasedByEmail,
    canRelease: !!r.removedAt && !r.releasedAt,
  }
}
