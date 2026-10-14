import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import {
  WRITE_ROLES,
  DEFAULT_FUNDING_SOURCES,
  ROLES,
  ROLE_LABELS,
  type ActivityEntry,
  type LoggedChange,
  type Role,
  type SuggestionDto,
  type WorkspaceDetail,
  type WorkspaceDto,
  type WorkspaceMemberDto,
} from '@ad/types'
import { TermsService } from '../auth/terms.service'
import { AccessLogService } from '../core/access-log.service'
import { allow, workspaceRole, type Caller } from '../core/caller'
import { changesOf, type Fields } from '../core/changes'
import { runAsSystem } from '../core/tenant-context'
import { PrismaService } from '../prisma/prisma.service'

const LIST_FIELDS: Fields = { fundingSources: { label: 'Sources of funds', show: 'list' } }
/** A membership's role, in the words of the people list and the invite form (Owner, Bookkeeper, Auditor). */
export const ROLE_FIELDS: Fields = { role: { label: 'Role', show: 'text', labels: ROLE_LABELS } }

/** A role inside a sentence of the log: "as auditor". */
export const roleWord = (role: string) => (ROLE_LABELS[role as Role] ?? role).toLowerCase()

/** A member as the access log names them: by email (`staffName` in core/caller.ts), never a display name. */
const personEmail = (u: { email: string | null } | null, id: string) => u?.email || id

/**
 * A workspace is the team's container: the engagements it accounts for, the people who work in it and the
 * lists its owners keep. It is also the line row-level security draws: a person sees the workspaces they
 * belong to and nothing else.
 */
@Injectable()
export class WorkspacesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly terms: TermsService,
    private readonly log: AccessLogService
  ) {}

  private readonly include = {
    _count: { select: { memberships: true, engagements: true } },
  }

  private dto(
    caller: Caller,
    w: {
      id: string
      name: string
      fundingSources: string[]
      termsAcceptedAt?: Date | null
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
      termsAcceptedAt: w.termsAcceptedAt?.toISOString() ?? null,
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

  /** The newest lines of the workspace's access log: who read, listed, downloaded, exported or changed what. */
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
      description: r.description,
      changes: (r.changes as LoggedChange[] | null) ?? null,
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
    await this.log.change(
      caller,
      (tx) =>
        tx.suggestion.create({
          data: { workspaceId: id, userId: caller.userId, kind: 'list', text: clean },
        }),
      (made) => ({
        workspaceId: made.workspaceId,
        resource: 'workspace',
        subjectId: made.id,
        action: 'create',
        // The form sits in the "More lists" card, under "Missing something today? Say so."
        description: 'Suggested an addition to the lists',
        changes: [{ field: 'Suggestion' }],
      })
    )
    return this.get(caller, id)
  }

  /** A new workspace; whoever creates it owns it, and accepts the current terms doing so (version and time kept). */
  async create(
    caller: Caller,
    name: string,
    acceptedTermsVersion?: string
  ): Promise<WorkspaceDetail> {
    const clean = name?.trim()
    if (!clean) throw new BadRequestException('A workspace needs a name')
    if (acceptedTermsVersion !== this.terms.version)
      throw new BadRequestException('Accept the current terms to create a workspace')
    // The creator is not a member yet, so they could neither read the workspace back nor give themselves the
    // first membership; both are the one trusted step (migrations 20261011000400 and ..0500). The line goes in the
    // same transaction, written as the new owner once the membership exists: if it cannot be written, there is no
    // workspace either, and trying again does not leave a duplicate behind.
    const { made: w } = await runAsSystem(() =>
      this.log.trusted(
        caller,
        async (tx, refresh) => {
          const made = await tx.workspace.create({
            data: {
              name: clean,
              fundingSources: DEFAULT_FUNDING_SOURCES,
              termsVersion: this.terms.version,
              termsAcceptedAt: new Date(),
              termsAcceptedById: caller.userId,
            },
          })
          // The new workspace joins the system context, so the membership can be read back as it is written.
          await refresh()
          const seat = await tx.membership.create({
            data: { userId: caller.userId, workspaceId: made.id, role: 'owner' },
          })
          return { made, seat }
        },
        ({ seat }) => [
          {
            workspaceId: seat.workspaceId,
            resource: 'workspace',
            subjectId: seat.workspaceId,
            action: 'create',
            description: `Created the workspace ${clean} and accepted the Terms & Conditions`,
          },
        ]
      )
    )
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
    const w = await this.load(caller, id)
    allow(workspaceRole(caller, id, ['owner']), 'Only an owner edits the lists')
    const clean = [...new Set((fundingSources ?? []).map((f) => String(f).trim()).filter(Boolean))]
    if (clean.length > 40 || clean.some((f) => f.length > 60))
      throw new BadRequestException('Up to 40 sources of 60 characters each')
    await this.log.change(
      caller,
      (tx) => tx.workspace.update({ where: { id }, data: { fundingSources: clean } }),
      {
        workspaceId: id,
        resource: 'workspace',
        subjectId: id,
        action: 'update',
        description: 'Changed the sources of funds',
        changes: changesOf(w, { fundingSources: clean }, LIST_FIELDS),
      }
    )
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
    await this.log.change(
      caller,
      (tx) =>
        tx.membership.create({ data: { userId: user.id, workspaceId: id, role: input.role } }),
      (seat) => ({
        workspaceId: seat.workspaceId,
        resource: 'member',
        subjectId: user.id,
        action: 'create',
        description: `Invited ${email} as ${roleWord(input.role)}`,
        changes: changesOf(null, { role: input.role }, ROLE_FIELDS),
      })
    )
    return this.get(caller, id)
  }

  async setRole(caller: Caller, id: string, userId: string, role: Role): Promise<WorkspaceDetail> {
    await this.load(caller, id)
    allow(workspaceRole(caller, id, ['owner']), 'Only an owner changes roles')
    if (!(ROLES as readonly string[]).includes(role))
      throw new BadRequestException('role must be owner, bookkeeper or auditor')
    const m = await this.prisma.membership.findFirst({
      where: { userId, workspaceId: id },
      include: { user: true },
    })
    if (!m) throw new NotFoundException('Not a member of this workspace')
    if (role !== 'owner') await this.keepAnOwner(id, userId)
    await this.log.change(
      caller,
      (tx) => tx.membership.update({ where: { id: m.id }, data: { role } }),
      (seat) => ({
        workspaceId: seat.workspaceId,
        resource: 'member',
        subjectId: userId,
        action: 'update',
        description: `Changed the role of ${personEmail(m.user, userId)} from ${roleWord(m.role)} to ${roleWord(role)}`,
        changes: changesOf(m, { role }, ROLE_FIELDS),
      })
    )
    return this.get(caller, id)
  }

  async removeMember(caller: Caller, id: string, userId: string): Promise<WorkspaceDetail> {
    await this.load(caller, id)
    allow(workspaceRole(caller, id, ['owner']), 'Only an owner removes people')
    await this.keepAnOwner(id, userId)
    const m = await this.prisma.membership.findFirst({
      where: { userId, workspaceId: id },
      include: { user: true },
    })
    if (!m) throw new NotFoundException('Not a member of this workspace')
    await this.log.change(
      caller,
      (tx) => tx.membership.deleteMany({ where: { userId, workspaceId: id } }),
      {
        workspaceId: id,
        resource: 'member',
        subjectId: userId,
        action: 'delete',
        description: `Removed ${personEmail(m.user, userId)} from the workspace`,
        changes: changesOf(m, null, ROLE_FIELDS),
      }
    )
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
