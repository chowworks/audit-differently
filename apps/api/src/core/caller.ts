import {
  ForbiddenException,
  Injectable,
  createParamDecorator,
  type ExecutionContext,
} from '@nestjs/common'
import type { Role } from '@ad/types'
import { PrismaService } from '../prisma/prisma.service'

/** Who is calling and what they may act for. The database's row-level security draws the same line; this
 * is the application's copy of it, for the role checks the database does not know about. */
export interface Caller {
  userId: string
  displayName: string
  memberships: { workspaceId: string; workspaceName: string; role: Role }[]
  /** The workspaces the caller belongs to, in any role. */
  workspaceIds: string[]
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
      memberships: rows,
      workspaceIds: [...new Set(rows.map((m) => m.workspaceId))],
    }
  }
}

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
