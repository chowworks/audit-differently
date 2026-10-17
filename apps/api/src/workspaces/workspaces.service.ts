import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import {
  WRITE_ROLES,
  DEFAULT_TAG_TYPES,
  ROLES,
  ROLE_LABELS,
  RECEIPTS_ADDRESS_PATTERN,
  type ActivityEntry,
  type AdminWorkspaceDetail,
  type AdminWorkspaceDto,
  type CreateWorkspaceRequest,
  type LoggedChange,
  type Role,
  type SuggestionDto,
  type TagTarget,
  type TagUses,
  type WorkspaceDetail,
  type WorkspaceDto,
  type WorkspaceMemberDto,
} from '@ad/types'
import { ClerkService } from '../auth/clerk.service'
import { AccessLogService } from '../core/access-log.service'
import { allow, staffName, workspaceRole, type Caller } from '../core/caller'
import { changesOf, type Fields } from '../core/changes'
import { runAsSystem } from '../core/tenant-context'
import { aiConfigured } from '../imports/ai-guess'
import { receiptsEmail } from '../inbound/config'
import { PrismaService } from '../prisma/prisma.service'
import { cleanTagTypes, removedTags, tagTypesOf, tagTypeWords, type RemovedTag } from './tags'

/** The tag types by their words, "Age group (Participants): Under 18, 18 to 24": owners' labels, never personal. */
const TAG_TYPE_FIELDS: Fields = { tagTypes: { label: 'Tag types', show: 'list' } }
const NAME_FIELDS: Fields = { name: { label: 'Workspace name', show: 'text' } }
/** The local part of the receipts address: the owners' own words for the team, never personal. */
const RECEIPTS_ADDRESS_FIELDS: Fields = {
  receiptsAddress: { label: 'Receipts address', show: 'text' },
}
const EMAILED_AI_FIELDS: Fields = {
  readEmailedReceiptsWithAi: {
    label: 'Read emailed receipts with AI',
    show: 'text',
    labels: { true: 'on', false: 'off' },
  },
}

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
      featuredDemo: boolean
      tagTypes: unknown
      receiptsAddress: string | null
      readEmailedReceiptsWithAi: boolean
      termsAcceptedAt?: Date | null
      _count: { memberships: number; engagements: number }
    }
  ): WorkspaceDto {
    return {
      id: w.id,
      name: w.name,
      featuredDemo: w.featuredDemo,
      myRole: caller.memberships.find((m) => m.workspaceId === w.id)?.role ?? null,
      memberCount: w._count.memberships,
      engagementCount: w._count.engagements,
      tagTypes: tagTypesOf(w),
      canManage: workspaceRole(caller, w.id, ['owner']),
      receiptsAddress: w.receiptsAddress,
      receiptsEmail: receiptsEmail(w.receiptsAddress),
      readEmailedReceiptsWithAi: w.readEmailedReceiptsWithAi,
      aiAvailable: aiConfigured(),
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
    return {
      ...this.dto(caller, w),
      members,
      suggestions: suggestionDtos(members, w.suggestions),
      tagUses: workspaceRole(caller, id, ['owner']) ? await this.tagUses(id) : {},
    }
  }

  /**
   * How many records of each kind hold each tag, for the owners' warning before a removal. Counts only: no row of a
   * record (a participant's tags are personal) leaves the database.
   */
  private async tagUses(id: string): Promise<TagUses> {
    const rows = await this.prisma.$queryRaw<{ kind: TagTarget; tag: string; n: number }[]>`
      SELECT 'engagement' AS kind, t AS tag, count(*)::int AS n FROM "Engagement", unnest("tags") t
        WHERE "workspaceId" = ${id} GROUP BY t
      UNION ALL SELECT 'expense', t, count(*)::int FROM "Expense", unnest("tags") t
        WHERE "workspaceId" = ${id} GROUP BY t
      UNION ALL SELECT 'payroll', t, count(*)::int FROM "WexPayment", unnest("tags") t
        WHERE "workspaceId" = ${id} GROUP BY t
      UNION ALL SELECT 'participant', t, count(*)::int FROM "Participant", unnest("tags") t
        WHERE "workspaceId" = ${id} GROUP BY t`
    const out: TagUses = {}
    for (const r of rows ?? []) (out[r.tag] ??= {})[r.kind] = Number(r.n)
    return out
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
      receiptsAddress: w.receiptsAddress,
      receiptsEmail: receiptsEmail(w.receiptsAddress),
      tagTypes: tagTypesOf(w),
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
          data: { name, tagTypes: DEFAULT_TAG_TYPES as unknown as Prisma.InputJsonValue },
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

  /**
   * The workspace's receipts address (its local part; the domain is the environment's): set by its owners only. The
   * platform admin changes a workspace's name, lists and memberships, and this is none of them: it decides where a
   * workspace's mail lands. Empty clears it. Unique across workspaces.
   */
  async setReceiptsAddress(caller: Caller, id: string, given: unknown): Promise<void> {
    const w = await this.load(caller, id)
    allow(
      !caller.admin && workspaceRole(caller, id, ['owner']),
      'Only an owner sets the receipts address'
    )
    if (given !== null && typeof given !== 'string')
      throw new BadRequestException('The receipts address must be text')
    const local = (given ?? '').trim().toLowerCase() || null
    if (local && !RECEIPTS_ADDRESS_PATTERN.test(local))
      throw new BadRequestException(
        'Use 3 to 40 lowercase letters, digits and hyphens, starting and ending with a letter or digit'
      )
    if (local === w.receiptsAddress) return
    // Set once (trigger Workspace_6_receipts_address_kept): an address never moves, so mail sent to it never lands
    // in another workspace.
    if (w.receiptsAddress)
      throw new ConflictException('The receipts address is set; it does not change')
    try {
      await this.log.change(
        caller,
        (tx) => tx.workspace.update({ where: { id }, data: { receiptsAddress: local } }),
        {
          workspaceId: id,
          resource: 'workspace',
          subjectId: id,
          action: 'update',
          description: 'Set the receipts address',
          changes: changesOf(w, { receiptsAddress: local }, RECEIPTS_ADDRESS_FIELDS),
        }
      )
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
        throw new ConflictException('That address is taken; choose another')
      throw e
    }
  }

  /**
   * "Read emailed receipts with AI": the yes for the one path with no person present to give it. Its owners only; the
   * platform admin never sets it (the admin route refuses it, and so does trigger Workspace_4_admin_lists).
   */
  async setReadEmailedReceiptsWithAi(caller: Caller, id: string, given: unknown): Promise<void> {
    const w = await this.load(caller, id)
    allow(
      !caller.admin && workspaceRole(caller, id, ['owner']),
      'Only an owner turns on reading emailed receipts with AI'
    )
    if (typeof given !== 'boolean') throw new BadRequestException('Say true or false')
    if (given === w.readEmailedReceiptsWithAi) return
    const data = { readEmailedReceiptsWithAi: given }
    await this.log.change(caller, (tx) => tx.workspace.update({ where: { id }, data }), {
      workspaceId: id,
      resource: 'workspace',
      subjectId: id,
      action: 'update',
      description: given
        ? 'Turned on reading emailed receipts with AI'
        : 'Turned off reading emailed receipts with AI',
      changes: changesOf(w, data, EMAILED_AI_FIELDS),
    })
  }

  /**
   * The workspace's tag types and their values ("Funding source" is one like any other), kept like the other lists: by
   * the owners, and by the platform admin (trigger Workspace_4_admin_lists). A rename keeps the key, so every record
   * shows the new name. A value or type removed comes off every engagement, expense, payroll item and participant
   * that has it, in the same transaction, and the line says how many of each.
   */
  async setTagTypes(caller: Caller, id: string, given: unknown): Promise<void> {
    const w = await this.load(caller, id)
    allow(runs(caller, id), 'Only an owner edits the lists')
    const before = tagTypesOf(w)
    const clean = cleanTagTypes(given, before)
    const changes = changesOf(
      { tagTypes: before.map(tagTypeWords) },
      { tagTypes: clean.map(tagTypeWords) },
      TAG_TYPE_FIELDS
    )
    if (changes.length === 0) return
    const removed = removedTags(before, clean)
    // The tagged records are below the workspace, where a platform admin who is not a member sees no row.
    if (removed.length && !caller.memberships.some((m) => m.workspaceId === id))
      throw new ConflictException(
        "Only the workspace's owners remove a tag: it comes off their records, which they see"
      )
    await this.log.change(
      caller,
      async (tx) => {
        const tags = removed.map((r) => r.tag)
        if (tags.length) {
          // A closed or submitted month's ledger does not change (trigger month_is_draft): say so before anything.
          const where = {
            workspaceId: id,
            tags: { hasSome: tags },
            monthlyReport: { status: { not: 'draft' } },
          }
          const locked =
            (await tx.expense.count({ where })) + (await tx.wexPayment.count({ where }))
          if (locked)
            throw new ConflictException(
              `${locked === 1 ? 'An expense or payroll item' : `${locked} expenses or payroll items`} in a closed or submitted month ${locked === 1 ? 'has' : 'have'} this tag, and those months do not change. Reopen the month to take it off, or keep the tag.`
            )
        }
        const counts: { removed: RemovedTag; uses: Record<TagTarget, number> }[] = []
        for (const r of removed) counts.push({ removed: r, uses: await ripTag(tx, id, r.tag) })
        await tx.workspace.update({
          where: { id },
          data: { tagTypes: clean as unknown as Prisma.InputJsonValue },
        })
        return { workspaceId: id, counts }
      },
      ({ counts }) => ({
        workspaceId: id,
        resource: 'workspace',
        subjectId: id,
        action: 'update',
        description: byAdmin(
          caller,
          counts.length
            ? `Removed ${counts.map((c) => `the ${c.removed.type.toLowerCase()} ${c.removed.value} from ${usesWords(c.uses)}`).join('; ')}`
            : 'Changed the tags'
        ),
        changes,
      })
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
  featuredDemo: boolean
  createdAt: Date
  termsAcceptedAt: Date | null
  memberships: MemberRow[]
}): AdminWorkspaceDto {
  return {
    id: w.id,
    name: w.name,
    featuredDemo: w.featuredDemo,
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

/**
 * Takes one tag off every engagement, expense, payroll item and participant of the workspace that has it, and says how
 * many of each. Parameterized; the tables are named here, never from the request.
 */
export async function ripTag(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  tag: string
): Promise<Record<TagTarget, number>> {
  return {
    engagement:
      await tx.$executeRaw`UPDATE "Engagement" SET "tags" = array_remove("tags", ${tag}), "updatedAt" = now() WHERE "workspaceId" = ${workspaceId} AND ${tag} = ANY ("tags")`,
    expense:
      await tx.$executeRaw`UPDATE "Expense" SET "tags" = array_remove("tags", ${tag}), "updatedAt" = now() WHERE "workspaceId" = ${workspaceId} AND ${tag} = ANY ("tags")`,
    payroll:
      await tx.$executeRaw`UPDATE "WexPayment" SET "tags" = array_remove("tags", ${tag}), "updatedAt" = now() WHERE "workspaceId" = ${workspaceId} AND ${tag} = ANY ("tags")`,
    participant:
      await tx.$executeRaw`UPDATE "Participant" SET "tags" = array_remove("tags", ${tag}), "updatedAt" = now() WHERE "workspaceId" = ${workspaceId} AND ${tag} = ANY ("tags")`,
  }
}

const USE_WORDS: Record<TagTarget, [string, string]> = {
  expense: ['expense', 'expenses'],
  payroll: ['payroll item', 'payroll items'],
  participant: ['participant', 'participants'],
  engagement: ['engagement', 'engagements'],
}

/** "3 expenses, 1 participant and 2 engagements", or "no records". */
export function usesWords(uses: Partial<Record<TagTarget, number>>): string {
  const parts = (Object.keys(USE_WORDS) as TagTarget[])
    .filter((k) => (uses[k] ?? 0) > 0)
    .map((k) => `${uses[k]} ${USE_WORDS[k][uses[k] === 1 ? 0 : 1]}`)
  if (!parts.length) return 'no records'
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
}
