import {
  ForbiddenException,
  Injectable,
  createParamDecorator,
  type ExecutionContext,
} from '@nestjs/common'
import type { Role } from '@ad/types'
import { PrismaService } from '../prisma/prisma.service'
import { tenantContext } from './tenant-context'

/** Who is calling and what they may act for. The database's row-level security draws the same line; this
 * is the application's copy of it, for the role checks the database does not know about. */
export interface Caller {
  userId: string
  displayName: string
  /** The User row's email: how the access log and every staff-facing record name this person. */
  email?: string | null
  memberships: { workspaceId: string; workspaceName: string; role: Role }[]
  /** The workspaces the caller belongs to, in any role. */
  workspaceIds: string[]
  /**
   * The platform admin on an admin route (AdminGuard): runs any workspace's people and lists, and nothing below the
   * workspace. Never set on any other route, where an admin is only what their memberships make them.
   */
  admin?: boolean
}

/** The verified user id the guard put on the request. */
export const UserId = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  return ctx.switchToHttp().getRequest<{ userId: string }>().userId
})

@Injectable()
export class CallerService {
  constructor(private readonly prisma: PrismaService) {}

  async load(userId: string): Promise<Caller> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } })
    const memberships = await this.prisma.membership.findMany({
      where: { userId },
      include: { workspace: true },
      orderBy: { createdAt: 'asc' },
    })
    const rows = memberships.map((m) => ({
      workspaceId: m.workspaceId,
      workspaceName: m.workspace.name,
      role: m.role as Role,
    }))
    return {
      userId,
      displayName: user?.displayName ?? user?.email ?? userId,
      email: user?.email ?? null,
      memberships: rows,
      workspaceIds: [...new Set(rows.map((m) => m.workspaceId))],
    }
  }

  /** The platform admin, on a route AdminGuard let through (it checked the Clerk role and marked the request). */
  async loadAdmin(userId: string): Promise<Caller> {
    if (!tenantContext()?.admin) throw new ForbiddenException('Platform admins only')
    return { ...(await this.load(userId)), admin: true }
  }
}

/**
 * How staff are named in the access log, an export's README and a deletion record: by email (owner's decision,
 * 2026-10-13), never a display name. A person with no email on file is named by their account id.
 */
export const staffName = (c: { userId: string; email?: string | null }) => c.email || c.userId

/** A Prisma `where` that keeps a list to what the caller may see. */
export function tenantWhere(c: Caller) {
  return { workspaceId: { in: c.workspaceIds } }
}

/** Whether the caller holds a role in the workspace: any role, or one of `roles`. */
export function workspaceRole(c: Caller, workspaceId: string, roles?: Role[]): boolean {
  return c.memberships.some(
    (m) => m.workspaceId === workspaceId && (!roles || roles.includes(m.role))
  )
}

export function allow(condition: boolean, message = 'Not allowed'): void {
  if (!condition) throw new ForbiddenException(message)
}
