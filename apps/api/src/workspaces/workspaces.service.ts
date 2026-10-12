import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import {
  WRITE_ROLES,
  DEFAULT_FUNDING_SOURCES,
  ROLES,
  type ActivityEntry,
  type Role,
  type SuggestionDto,
  type WorkspaceDetail,
  type WorkspaceDto,
  type WorkspaceMemberDto,
} from '@ad/types'
import { allow, workspaceRole, type Caller } from '../core/caller'
import { runAsSystem } from '../core/tenant-context'
import { PrismaService } from '../prisma/prisma.service'

/**
 * A workspace is the team's container: the engagements it accounts for, the people who work in it and the
 * lists its owners keep. It is also the line row-level security draws: a person sees the workspaces they
 * belong to and nothing else.
 */
@Injectable()
export class WorkspacesService {
  constructor(private readonly prisma: PrismaService) {}

  private readonly include = {
    _count: { select: { memberships: true, engagements: true } },
  }

  private dto(
    caller: Caller,
    w: {
      id: string
      name: string
      fundingSources: string[]
      _count: { memberships: number; engagements: number }
    }
  ): WorkspaceDto {
    return {
      id: w.id,
      name: w.name,
      myRole: caller.memberships.find((m) => m.workspaceId === w.id)?.role ?? null,
      memberCount: w._count.memberships,
      engagementCount: w._count.engagements,
      fundingSources: w.fundingSources.length ? w.fundingSources : DEFAULT_FUNDING_SOURCES,
      canManage: workspaceRole(caller, w.id, ['owner']),
    }
  }

  async list(caller: Caller): Promise<WorkspaceDto[]> {
    const rows = await this.prisma.workspace.findMany({
      where: { id: { in: caller.workspaceIds } },
      include: this.include,
      orderBy: { name: 'asc' },
    })
    return rows.map((w) => this.dto(caller, w))
  }

  async get(caller: Caller, id: string): Promise<WorkspaceDetail> {
    const w = await this.prisma.workspace.findFirst({
      where: { id, ...(caller.workspaceIds.includes(id) ? {} : { id: '-' }) },
      include: {
        ...this.include,
        memberships: { include: { user: true }, orderBy: { createdAt: 'asc' } },
        suggestions: { orderBy: { createdAt: 'desc' }, take: 50 },
      },
    })
    if (!w) throw new NotFoundException()
    const members: WorkspaceMemberDto[] = w.memberships.map((m) => ({
      userId: m.userId,
      displayName: m.user.displayName ?? m.user.email ?? m.userId,
      email: m.user.email,
      role: m.role as Role,
      pending: m.userId.startsWith('pending-'),
    }))
    const names = new Map(members.map((m) => [m.userId, m.displayName]))
    const suggestions: SuggestionDto[] = w.suggestions.map((x) => ({
      id: x.id,
      text: x.text,
      by: names.get(x.userId) ?? 'someone who left',
      createdAt: x.createdAt.toISOString(),
    }))
    return { ...this.dto(caller, w), members, suggestions }
  }

  /** The newest lines of the workspace's access log: who read, listed, downloaded or exported what. */
  async activity(caller: Caller, id: string): Promise<ActivityEntry[]> {
    await this.load(caller, id)
    allow(
      workspaceRole(caller, id, ['owner', 'auditor']),
      'Only an owner or auditor reads the access log'
    )
    const rows = await this.prisma.dataAccessLog.findMany({
      where: { workspaceId: id },
      orderBy: { createdAt: 'desc' },
      take: 500,
    })
    return rows.map((r) => ({
      id: r.id,
      at: r.createdAt.toISOString(),
      actorName: r.actorName,
      action: r.action,
      resource: r.resource,
      detail: r.detail,
    }))
  }

  /** A member asks for something to be added to a list. Kept; later sent on. An auditor changes nothing. */
  async suggest(caller: Caller, id: string, text: string): Promise<WorkspaceDetail> {
    await this.load(caller, id)
    allow(workspaceRole(caller, id, WRITE_ROLES), 'Only an owner or bookkeeper suggests')
    const clean = text?.trim()
    if (!clean) throw new BadRequestException('Say what to add')
    if (clean.length > 300) throw new BadRequestException('Keep it under 300 characters')
    await this.prisma.suggestion.create({
      data: { workspaceId: id, userId: caller.userId, kind: 'list', text: clean },
    })
    return this.get(caller, id)
  }

  /** A new workspace; whoever creates it owns it. */
  async create(caller: Caller, name: string): Promise<WorkspaceDetail> {
    const clean = name?.trim()
    if (!clean) throw new BadRequestException('A workspace needs a name')
    // The creator is not a member yet, so they could neither read the workspace back nor give themselves the
    // first membership; both are the one trusted step (migrations 20261011000400 and ..0500).
    const w = await runAsSystem(async () => {
      const made = await this.prisma.workspace.create({
        data: { name: clean, fundingSources: DEFAULT_FUNDING_SOURCES },
      })
      await this.prisma.membership.create({
        data: { userId: caller.userId, workspaceId: made.id, role: 'owner' },
      })
      return made
    })
    const fresh: Caller = {
      ...caller,
      memberships: [
        ...caller.memberships,
        { workspaceId: w.id, workspaceName: clean, role: 'owner' },
      ],
      workspaceIds: [...caller.workspaceIds, w.id],
    }
    return this.get(fresh, w.id)
  }

  async setLists(caller: Caller, id: string, fundingSources: string[]): Promise<WorkspaceDetail> {
    await this.load(caller, id)
    allow(workspaceRole(caller, id, ['owner']), 'Only an owner edits the lists')
    const clean = [...new Set((fundingSources ?? []).map((f) => String(f).trim()).filter(Boolean))]
    if (clean.length > 40 || clean.some((f) => f.length > 60))
      throw new BadRequestException('Up to 40 sources of 60 characters each')
    await this.prisma.workspace.update({ where: { id }, data: { fundingSources: clean } })
    return this.get(caller, id)
  }

  /** Invite by email. A person not yet signed in gets a placeholder User row that sign-in claims. */
  async addMember(
    caller: Caller,
    id: string,
    input: { email: string; displayName?: string; role: Role }
  ): Promise<WorkspaceDetail> {
    await this.load(caller, id)
    allow(workspaceRole(caller, id, ['owner']), 'Only an owner invites people')
    const email = input.email?.trim().toLowerCase()
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      throw new BadRequestException('An email address is needed')
    if (!(ROLES as readonly string[]).includes(input.role))
      throw new BadRequestException('role must be owner, bookkeeper or auditor')
    const user = await runAsSystem(async () => {
      const existing = await this.prisma.user.findFirst({
        where: { email: { equals: email, mode: 'insensitive' } },
      })
      if (existing) return existing
      return this.prisma.user.create({
        data: {
          id: `pending-${randomUUID()}`,
          email,
          displayName: input.displayName?.trim() || null,
        },
      })
    })
    const already = await this.prisma.membership.findFirst({
      where: { userId: user.id, workspaceId: id },
    })
    if (already) throw new BadRequestException(`${email} is already in this workspace`)
    await this.prisma.membership.create({
      data: { userId: user.id, workspaceId: id, role: input.role },
    })
    return this.get(caller, id)
  }

  async setRole(caller: Caller, id: string, userId: string, role: Role): Promise<WorkspaceDetail> {
    await this.load(caller, id)
    allow(workspaceRole(caller, id, ['owner']), 'Only an owner changes roles')
    if (!(ROLES as readonly string[]).includes(role))
      throw new BadRequestException('role must be owner, bookkeeper or auditor')
    const m = await this.prisma.membership.findFirst({ where: { userId, workspaceId: id } })
    if (!m) throw new NotFoundException('Not a member of this workspace')
    if (role !== 'owner') await this.keepAnOwner(id, userId)
    await this.prisma.membership.update({ where: { id: m.id }, data: { role } })
    return this.get(caller, id)
  }

  async removeMember(caller: Caller, id: string, userId: string): Promise<WorkspaceDetail> {
    await this.load(caller, id)
    allow(workspaceRole(caller, id, ['owner']), 'Only an owner removes people')
    await this.keepAnOwner(id, userId)
    const gone = await this.prisma.membership.deleteMany({ where: { userId, workspaceId: id } })
    if (gone.count === 0) throw new NotFoundException('Not a member of this workspace')
    return this.get(caller, id)
  }

  private async load(caller: Caller, id: string) {
    if (!caller.workspaceIds.includes(id)) throw new NotFoundException()
    const w = await this.prisma.workspace.findFirst({ where: { id } })
    if (!w) throw new NotFoundException()
    return w
  }

  /** A workspace keeps at least one owner. */
  private async keepAnOwner(workspaceId: string, exceptUserId: string) {
    const isOwner = await this.prisma.membership.count({
      where: { workspaceId, role: 'owner', userId: exceptUserId },
    })
    if (isOwner === 0) return
    const others = await this.prisma.membership.count({
      where: { workspaceId, role: 'owner', userId: { not: exceptUserId } },
    })
    if (others === 0)
      throw new BadRequestException('Make someone else an owner first; a workspace keeps one')
  }
}
