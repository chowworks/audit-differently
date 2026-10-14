import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import {
  MAX_PLATFORM_ADMINS,
  PLATFORM_ADMIN,
  type AdminListDto,
  type AdminUserDto,
  type PlatformRoleChangeDto,
} from '@ad/types'
import { ClerkService } from '../auth/clerk.service'
import { PrismaService } from '../prisma/prisma.service'

/**
 * Admin tools: who is a platform admin (Clerk `publicMetadata.role` on this product's instance). It is the only role
 * an account carries; every other role is a membership in a workspace. Same rules as Learn Differently's
 * admin-users.service.ts. Only reached through AdminGuard, which asked Clerk that the caller is an admin.
 *
 * A change belongs to no workspace, so it is not a line of any workspace's access log: every attempt that reaches
 * Clerk is a `PlatformRoleChange` row (append-only, migration 20261013000200), and a line in the API's log.
 */
@Injectable()
export class AdminUsersService {
  private readonly logger = new Logger(AdminUsersService.name)

  constructor(
    private readonly clerk: ClerkService,
    private readonly prisma: PrismaService
  ) {}

  search(query: string | undefined): Promise<AdminUserDto[]> {
    return this.clerk.searchUsers((query ?? '').trim().slice(0, 100))
  }

  /**
   * The admins, read from Clerk at most every 30 seconds: the list pages through every account (up to 20 Clerk
   * calls), and opening Admin tools twice should not cost that twice. A role change clears it.
   */
  private cachedAdmins: { at: number; list: AdminListDto } | null = null

  async admins(): Promise<AdminListDto> {
    if (this.cachedAdmins && Date.now() - this.cachedAdmins.at < 30_000)
      return this.cachedAdmins.list
    const list = await this.clerk.listAdmins()
    this.cachedAdmins = { at: Date.now(), list }
    return list
  }

  /** The 50 newest attempts to make or unmake an admin, kept or failed. */
  async changes(): Promise<PlatformRoleChangeDto[]> {
    const rows = await this.prisma.platformRoleChange.findMany({
      orderBy: { at: 'desc' },
      take: 50,
    })
    return rows.map((r) => ({
      id: r.id,
      at: r.at.toISOString(),
      actorEmail: r.actorEmail,
      targetEmail: r.targetEmail,
      oldRole: r.oldRole,
      newRole: r.newRole,
      outcome: r.outcome === 'done' ? 'done' : 'failed',
      error: r.error,
    }))
  }

  /** Makes the person a platform admin, or takes it away with null. */
  async setRole(actorId: string, targetId: string, given: unknown): Promise<AdminUserDto> {
    const role = given === PLATFORM_ADMIN ? PLATFORM_ADMIN : given === null ? null : undefined
    if (role === undefined)
      throw new BadRequestException(
        `Only ${PLATFORM_ADMIN} can be given on an account (or null to clear it). Other roles are given in a workspace.`
      )
    // Nobody changes their own role, so the platform can never lose its last admin.
    if (targetId === actorId) throw new BadRequestException('You cannot change your own role')
    const target = await this.clerk.getUserSummary(targetId)
    if (!target) throw new NotFoundException('No such person')
    if (role === PLATFORM_ADMIN && target.role !== PLATFORM_ADMIN) {
      const { admins } = await this.clerk.listAdmins()
      if (admins.length >= MAX_PLATFORM_ADMINS)
        throw new BadRequestException(`There can be at most ${MAX_PLATFORM_ADMINS} platform admins`)
    }
    const actor = await this.clerk.getUserSummary(actorId)
    const record = {
      actorId,
      actorEmail: actor?.email ?? null,
      targetId,
      targetEmail: target.email,
      oldRole: target.role,
      newRole: role,
    }
    try {
      // The row and the Clerk call together: the row is written first, and goes back with the transaction if Clerk
      // refuses or does not answer, so a 'done' row is never kept for a change Clerk did not make.
      await this.prisma.$transaction(
        async (tx) => {
          await tx.platformRoleChange.create({ data: { ...record, outcome: 'done' } })
          await this.clerk.setRole(targetId, role)
        },
        { timeout: 15_000 }
      )
    } catch (err) {
      // The answer is the original failure; a failure to keep the row is logged beside it.
      await this.prisma.platformRoleChange
        .create({
          data: {
            ...record,
            outcome: 'failed',
            error: err instanceof Error ? err.message.slice(0, 500) : 'unknown',
          },
        })
        .catch((e: unknown) =>
          this.logger.error(
            `Could not keep a failed platform role change: ${e instanceof Error ? e.message : 'unknown'}`
          )
        )
      throw err
    }
    this.cachedAdmins = null
    this.logger.log(
      `${actor?.email ?? actorId} changed the platform role of ${target.email ?? targetId}: ${target.role ?? 'none'} -> ${role ?? 'none'}`
    )
    return { ...target, role }
  }
}
