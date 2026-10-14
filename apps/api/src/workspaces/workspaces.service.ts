import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import {
  WRITE_ROLES,
  DEFAULT_FUNDING_SOURCES,
  ROLES,
  ROLE_LABELS,
  type ActivityEntry,
  type AdminWorkspaceDetail,
  type AdminWorkspaceDto,
  type CreateWorkspaceRequest,
  type LoggedChange,
  type Role,
  type SuggestionDto,
  type WorkspaceDetail,
  type WorkspaceDto,
  type WorkspaceMemberDto,
} from '@ad/types'
import { ClerkService } from '../auth/clerk.service'
import { AccessLogService } from '../core/access-log.service'
import { allow, staffName, workspaceRole, type Caller } from '../core/caller'
import { changesOf, type Fields } from '../core/changes'
import { runAsSystem } from '../core/tenant-context'
import { PrismaService } from '../prisma/prisma.service'

const LIST_FIELDS: Fields = { fundingSources: { label: 'Sources of funds', show: 'list' } }
const NAME_FIELDS: Fields = { name: { label: 'Workspace name', show: 'text' } }
/** A membership's role, in the words of the people list and the invite form (Owner, Bookkeeper, Auditor). */
export const ROLE_FIELDS: Fields = { role: { label: 'Role', show: 'text', labels: ROLE_LABELS } }

/** A role inside a sentence of the log: "as auditor". */
export const roleWord = (role: string) => (ROLE_LABELS[role as Role] ?? role).toLowerCase()

/** A member as the access log names them: by email (`staffName` in core/caller.ts), never a display name. */
const personEmail = (u: { email: string | null } | null, id: string) => u?.email || id

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Who runs a workspace's people and lists: its owners, and the platform admin on an admin route. */
const runs = (caller: Caller, id: string) => !!caller.admin || workspaceRole(caller, id, ['owner'])

/**
 * A line of the platform admin's, marked so the workspace's log shows it unmistakably: "(by a platform admin)" at the
 * end. The lines where the admin seats themself name them instead (`seatedAdmin`). A member's line is unchanged.
 */
const byAdmin = (caller: Caller, text: string) =>
  caller.admin ? `${text} (by a platform admin)` : text
/** The admin as a line names them when they seat themself: "admin@example.org (platform admin)". */
const seatedAdmin = (caller: Caller) => `${staffName(caller)} (platform admin)`

/** A workspace's name: trimmed, required, at most 120 characters. */
function workspaceName(given: unknown): string {
  const name = typeof given === 'string' ? given.trim() : ''
  if (!name) throw new BadRequestException('A workspace needs a name')
  if (name.length > 120) throw new BadRequestException('Keep the name under 120 characters')
  return name
}

type MemberRow = {
  userId: string
  role: string
  user: { displayName: string | null; email: string | null }
}

const memberDto = (m: MemberRow): WorkspaceMemberDto => ({
  userId: m.userId,
  displayName: m.user.displayName ?? m.user.email ?? m.userId,
  email: m.user.email,
  role: m.role as Role,
  pending: m.userId.startsWith('pending-'),
})

/**
 * A workspace is the team's container: the engagements it accounts for, the people who work in it and the
 * lists its owners keep. It is also the line row-level security draws: a person sees the workspaces they
 * belong to and nothing else.
 */
@Injectable()
export class WorkspacesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly log: AccessLogService,
    private readonly clerk: ClerkService
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
    const members = w.memberships.map(memberDto)
    return { ...this.dto(caller, w), members, suggestions: suggestionDtos(members, w.suggestions) }
  }

  /**
   * Every workspace, for the platform admin: its name, when it was made and its people. Nothing below the workspace
   * is asked for (no engagement count), and the database would show the admin none of it (migration 20261013000200).
   */
  async adminList(caller: Caller): Promise<AdminWorkspaceDto[]> {
    allow(!!caller.admin, 'Platform admins only')
    const rows = await this.prisma.workspace.findMany({
      include: { memberships: { include: { user: true }, orderBy: { createdAt: 'asc' } } },
      orderBy: { name: 'asc' },
    })
    return rows.map((w) => adminDto(w))
  }

  /** One workspace for the platform admin: its people, its lists and its suggestions. */
  async adminGet(caller: Caller, id: string): Promise<AdminWorkspaceDetail> {
    allow(!!caller.admin, 'Platform admins only')
    const w = await this.prisma.workspace.findFirst({
      where: { id },
      include: {
        memberships: { include: { user: true }, orderBy: { createdAt: 'asc' } },
        suggestions: { orderBy: { createdAt: 'desc' }, take: 50 },
      },
    })
    if (!w) throw new NotFoundException()
    const dto = adminDto(w)
    return {
      ...dto,
      fundingSources: w.fundingSources.length ? w.fundingSources : DEFAULT_FUNDING_SOURCES,
      suggestions: suggestionDtos(dto.members, w.suggestions),
    }
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

  /**
   * A new workspace for a customer, made by the platform admin with its first owner named by email: the person's
   * account if they have signed in before, else an invitation's placeholder that their first sign-in claims (GET /me).
   * The admin accepts no Terms for it: the Terms fields stay empty until that owner has accepted (MeController). The
   * workspace, the owner's seat and the line are one transaction, under the admin's database flag. An admin who names
   * one of their own addresses is seated as themself, and the line says so.
   */
  async create(caller: Caller, input: CreateWorkspaceRequest): Promise<AdminWorkspaceDetail> {
    allow(!!caller.admin, 'Only a platform admin creates a workspace')
    const name = workspaceName(input?.name)
    const email = input.ownerEmail?.trim().toLowerCase()
    if (!email || !EMAIL.test(email))
      throw new BadRequestException("The first owner's email address is needed")
    const self = await this.ownAddress(caller, email)
    const made = await this.log.change(
      caller,
      async (tx) => {
        const w = await tx.workspace.create({
          data: { name, fundingSources: DEFAULT_FUNDING_SOURCES },
        })
        const ownerId = self ? caller.userId : (await findOrInvite(tx, email, input.ownerName)).id
        await tx.membership.create({ data: { userId: ownerId, workspaceId: w.id, role: 'owner' } })
        return w
      },
      (w) => ({
        workspaceId: w.id,
        resource: 'workspace',
        subjectId: w.id,
        action: 'create',
        description: self
          ? `Created the workspace ${name} with ${seatedAdmin(caller)} as its first owner, themself`
          : byAdmin(caller, `Created the workspace ${name} with first owner ${email}`),
      })
    )
    return this.adminGet(caller, made.id)
  }

  /** An owner renames their workspace; the platform admin any workspace (trigger Workspace_4_admin_lists). */
  async rename(caller: Caller, id: string, given: unknown): Promise<void> {
    const w = await this.load(caller, id)
    allow(runs(caller, id), 'Only an owner renames the workspace')
    const name = workspaceName(given)
    if (name === w.name) return
    await this.log.change(caller, (tx) => tx.workspace.update({ where: { id }, data: { name } }), {
      workspaceId: id,
      resource: 'workspace',
      subjectId: id,
      action: 'update',
      description: byAdmin(caller, `Renamed the workspace from ${w.name} to ${name}`),
      changes: changesOf(w, { name }, NAME_FIELDS),
    })
  }

  async setLists(caller: Caller, id: string, fundingSources: string[]): Promise<void> {
    const w = await this.load(caller, id)
    allow(runs(caller, id), 'Only an owner edits the lists')
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
        description: byAdmin(caller, 'Changed the sources of funds'),
        changes: changesOf(w, { fundingSources: clean }, LIST_FIELDS),
      }
    )
  }

  /**
   * Invite by email. A person not yet signed in gets a placeholder User row that sign-in claims. The platform admin may
   * name one of their own addresses: they are then seated as themself, and the line says so.
   */
  async addMember(
    caller: Caller,
    id: string,
    input: { email: string; displayName?: string; role: Role }
  ): Promise<void> {
    await this.load(caller, id)
    allow(runs(caller, id), 'Only an owner invites people')
    const email = input.email?.trim().toLowerCase()
    if (!email || !EMAIL.test(email)) throw new BadRequestException('An email address is needed')
    if (!(ROLES as readonly string[]).includes(input.role))
      throw new BadRequestException('role must be owner, bookkeeper or auditor')
    const self = await this.ownAddress(caller, email)
    // An owner cannot see people outside their workspaces, so the lookup and the placeholder are trusted work.
    const invited = caller.admin
      ? null
      : await runAsSystem(() => findOrInvite(this.prisma, email, input.displayName))
    await this.log.change(
      caller,
      async (tx) => {
        // The platform admin's own database flag admits the lookup and the placeholder (migration 20261013000200), so
        // they go inside the change: an invitation that fails leaves no placeholder without its line.
        const userId =
          invited?.id ??
          (self ? caller.userId : (await findOrInvite(tx, email, input.displayName)).id)
        const already = await tx.membership.findFirst({ where: { userId, workspaceId: id } })
        if (already) throw new BadRequestException(`${email} is already in this workspace`)
        return tx.membership.create({ data: { userId, workspaceId: id, role: input.role } })
      },
      (seat) => ({
        workspaceId: seat.workspaceId,
        resource: 'member',
        subjectId: seat.userId,
        action: 'create',
        description: self
          ? `${seatedAdmin(caller)} added themself as ${roleWord(input.role)}`
          : byAdmin(caller, `Invited ${email} as ${roleWord(input.role)}`),
        changes: changesOf(null, { role: input.role }, ROLE_FIELDS),
      })
    )
  }

  async setRole(caller: Caller, id: string, userId: string, role: Role): Promise<void> {
    await this.load(caller, id)
    allow(runs(caller, id), 'Only an owner changes roles')
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
        description:
          caller.admin && userId === caller.userId
            ? `${seatedAdmin(caller)} changed their own role from ${roleWord(m.role)} to ${roleWord(role)}`
            : byAdmin(
                caller,
                `Changed the role of ${personEmail(m.user, userId)} from ${roleWord(m.role)} to ${roleWord(role)}`
              ),
        changes: changesOf(m, { role }, ROLE_FIELDS),
      })
    )
  }

  async removeMember(caller: Caller, id: string, userId: string): Promise<void> {
    await this.load(caller, id)
    allow(runs(caller, id), 'Only an owner removes people')
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
        description: byAdmin(caller, `Removed ${personEmail(m.user, userId)} from the workspace`),
        changes: changesOf(m, null, ROLE_FIELDS),
      }
    )
  }

  /** The workspace, if the caller may act on it: a member, or the platform admin on an admin route. */
  private async load(caller: Caller, id: string) {
    if (!caller.admin && !caller.workspaceIds.includes(id)) throw new NotFoundException()
    const w = await this.prisma.workspace.findFirst({ where: { id } })
    if (!w) throw new NotFoundException()
    return w
  }

  /**
   * Whether `email` (lowercased) is the platform admin's own: the address on their User row or any verified address
   * on their Clerk account. `findOrInvite` matches one address only, so a second address of the admin's would
   * otherwise become an invitation's placeholder. Only on the admin path; a member's invitation never asks Clerk.
   */
  private async ownAddress(caller: Caller, email: string): Promise<boolean> {
    if (!caller.admin) return false
    if (caller.email?.toLowerCase() === email) return true
    return (await this.clerk.verifiedEmails(caller.userId)).includes(email)
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

/** The account an email names, or an invitation's placeholder under it that the person's first sign-in claims. */
async function findOrInvite(
  db: Pick<PrismaService, 'user'> | Prisma.TransactionClient,
  email: string,
  displayName?: string
) {
  const existing = await db.user.findFirst({
    where: { email: { equals: email, mode: 'insensitive' } },
  })
  if (existing) return existing
  return db.user.create({
    data: { id: `pending-${randomUUID()}`, email, displayName: displayName?.trim() || null },
  })
}

function adminDto(w: {
  id: string
  name: string
  createdAt: Date
  termsAcceptedAt: Date | null
  memberships: MemberRow[]
}): AdminWorkspaceDto {
  return {
    id: w.id,
    name: w.name,
    createdAt: w.createdAt.toISOString(),
    memberCount: w.memberships.length,
    members: w.memberships.map(memberDto),
    termsAcceptedAt: w.termsAcceptedAt?.toISOString() ?? null,
  }
}

/** Suggestions name who made them by the members' display names; someone no longer a member is "someone who left". */
function suggestionDtos(
  members: WorkspaceMemberDto[],
  rows: { id: string; text: string; userId: string; createdAt: Date }[]
): SuggestionDto[] {
  const names = new Map(members.map((m) => [m.userId, m.displayName]))
  return rows.map((x) => ({
    id: x.id,
    text: x.text,
    by: names.get(x.userId) ?? 'someone who left',
    createdAt: x.createdAt.toISOString(),
  }))
}
