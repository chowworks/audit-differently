import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import type {
  EngagementStatus,
  StaffAddInput,
  StaffInput,
  StaffInputProblem,
  StaffListDto,
} from '@ad/types'
import { AccessLogService } from '../core/access-log.service'
import { allow, tenantWhere, workspaceRole, type Caller } from '../core/caller'
import { changesOf, howMany, type Fields } from '../core/changes'
import { PrismaService } from '../prisma/prisma.service'

/** Pasted rows at most in one import. */
export const MAX_STAFF_ROWS = 500

/**
 * A person on the staff list in the access log: every field by name alone. Their name may be in a line's description
 * (they are the company's staff, named as members are named by email); their role never is. No employee number is kept
 * (owner's decision, 2026-10-18).
 */
const STAFF_FIELDS: Fields = {
  name: { label: 'Name' },
  role: { label: 'Role' },
}

const clean = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '')
/** Names are compared as the database's unique index compares them: trimmed, spaces folded, whatever the case. */
const nameKey = (n: string) => clean(n).toLowerCase()

type Checked = {
  name: string
  role: string | null
}

/**
 * The staff list and engagement staffing (GitHub issue #22; owner's decisions, 2026-10-18): the company's staff as
 * records, not accounts, and the engagements each one works on. Owners change it; owners and auditors read it; anyone
 * else (a bookkeeper, a member of another workspace) finds nothing here (404). The database draws the same line
 * (migration 20261018000100). Every change is written with its line in the access log, in the screen's words.
 */
@Injectable()
export class StaffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly log: AccessLogService
  ) {}

  private reader(caller: Caller, workspaceId: string) {
    if (!workspaceRole(caller, workspaceId, ['owner', 'auditor'])) throw new NotFoundException()
  }

  private owner(caller: Caller, workspaceId: string) {
    this.reader(caller, workspaceId)
    allow(workspaceRole(caller, workspaceId, ['owner']), 'Only an owner changes the staff list')
  }

  /** A person on the list, in the caller's sight; 404 for anyone who may not read the list. */
  private async person(caller: Caller, staffId: string) {
    const s = await this.prisma.staffMember.findFirst({
      where: { id: staffId, ...tenantWhere(caller) },
      include: { _count: { select: { payProofs: true } } },
    })
    if (!s) throw new NotFoundException()
    this.owner(caller, s.workspaceId)
    return s
  }

  /** The list as the page shows it: each person with their engagements, and the workspace's engagements. */
  async list(caller: Caller, workspaceId: string): Promise<StaffListDto> {
    this.reader(caller, workspaceId)
    const out = await this.listOf(caller, workspaceId)
    await this.log.log(caller, {
      workspaceId,
      resource: 'workspace',
      subjectId: workspaceId,
      action: 'read',
      description: `Opened the staff list (${howMany(out.staff.length, 'person', 'people')})`,
    })
    return out
  }

  private async listOf(caller: Caller, workspaceId: string): Promise<StaffListDto> {
    const [staff, engagements] = await Promise.all([
      this.prisma.staffMember.findMany({
        where: { workspaceId },
        orderBy: [{ name: 'asc' }, { createdAt: 'asc' }],
        include: {
          assignments: { include: { engagement: { select: { id: true, name: true } } } },
          _count: { select: { payProofs: true } },
        },
      }),
      this.prisma.engagement.findMany({
        where: { workspaceId },
        orderBy: { name: 'asc' },
        select: { id: true, name: true, code: true, status: true },
      }),
    ])
    return {
      workspaceId,
      staff: staff.map((s) => ({
        id: s.id,
        name: s.name,
        role: s.role,
        engagements: s.assignments
          .map((a) => ({ id: a.engagement.id, name: a.engagement.name }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        inSavedProof: s._count.payProofs > 0,
      })),
      engagements: engagements.map((e) => ({
        id: e.id,
        name: e.name,
        code: e.code,
        status: e.status as EngagementStatus,
      })),
      can: { change: workspaceRole(caller, workspaceId, ['owner']) },
    }
  }

  /**
   * Checks rows as the paste import gives them, against each other, the list as it stands and the workspace's
   * participant lists: every problem at once, each beside its row and field. A name is the person's only key (the payroll
   * files are matched by it), so the owner tells two people apart (owner's decision, 2026-10-18): a name already on the
   * staff list, on another row, or of a participant on an engagement's list is refused, never left to the match to guess.
   */
  private check(
    rows: StaffInput[],
    list: { id: string; name: string }[],
    participants: { displayName: string; engagement: { name: string } }[],
    except?: string
  ): { checked: Checked[]; problems: StaffInputProblem[] } {
    const problems: StaffInputProblem[] = []
    const checked: Checked[] = []
    const others = list.filter((s) => s.id !== except)
    // A person's own name, kept as it is, is not refused for a participant added since.
    const kept = list.find((s) => s.id === except)?.name
    const apart = (name: string, role: string | null) =>
      `add something to tell them apart, e.g. ${name} (${role ?? 'their engagement'})`
    rows.forEach((raw, i) => {
      const row = i + 1
      const name = clean(raw?.name)
      const role = clean(raw?.role) || null
      if (!name) problems.push({ row, field: 'name', message: `Row ${row}: the name is missing` })
      else if (name.length > 120)
        problems.push({
          row,
          field: 'name',
          message: `Row ${row}: the name is over 120 characters`,
        })
      if (role && role.length > 80)
        problems.push({ row, field: 'role', message: `Row ${row}: the role is over 80 characters` })
      if (name) {
        const key = nameKey(name)
        const earlier = checked.findIndex((c) => c.name && nameKey(c.name) === key)
        const programs = [
          ...new Set(
            participants.filter((p) => nameKey(p.displayName) === key).map((p) => p.engagement.name)
          ),
        ].sort()
        if (others.some((s) => nameKey(s.name) === key))
          problems.push({
            row,
            field: 'name',
            message: `Row ${row}: ${name} is already on the staff list: ${apart(name, role)}`,
          })
        else if (earlier >= 0)
          problems.push({
            row,
            field: 'name',
            message: `Row ${row}: ${name} is also on row ${earlier + 1}: ${apart(name, role)}`,
          })
        else if (programs.length && (!kept || nameKey(kept) !== key))
          problems.push({
            row,
            field: 'name',
            message: `Row ${row}: ${name} is a participant on ${programs.join(' and ')}: add something to tell them apart`,
          })
      }
      checked.push({ name, role })
    })
    return { checked, problems }
  }

  private refuse(problems: StaffInputProblem[]): never {
    throw new BadRequestException({ message: problems.map((p) => p.message).join('. '), problems })
  }

  /** A unique index refusal (two tabs adding the same name at once): said in plain words. */
  private taken(e: unknown): never {
    if ((e as { code?: string })?.code === 'P2002')
      throw new ConflictException(
        'That name is already on the staff list: add something to tell them apart'
      )
    throw e
  }

  /** The list's names and the workspace's participants, for `check`. */
  private namesOf(workspaceId: string) {
    return Promise.all([
      this.prisma.staffMember.findMany({
        where: { workspaceId },
        select: { id: true, name: true },
      }),
      this.prisma.participant.findMany({
        where: { workspaceId },
        select: { displayName: true, engagement: { select: { name: true } } },
      }),
    ])
  }

  /** The paste import: every row checked at once, and all added or none. */
  async add(caller: Caller, workspaceId: string, input: StaffAddInput): Promise<StaffListDto> {
    this.owner(caller, workspaceId)
    const rows = Array.isArray(input?.staff) ? input.staff : null
    if (!rows || !rows.length) throw new BadRequestException('Add at least one person')
    if (rows.length > MAX_STAFF_ROWS)
      throw new BadRequestException(`Add at most ${MAX_STAFF_ROWS} people at a time`)
    const [list, participants] = await this.namesOf(workspaceId)
    const { checked, problems } = this.check(rows, list, participants)
    if (problems.length) this.refuse(problems)
    await this.log
      .change(
        caller,
        (tx) => tx.staffMember.createMany({ data: checked.map((c) => ({ workspaceId, ...c })) }),
        {
          workspaceId,
          resource: 'staff',
          subjectId: workspaceId,
          action: 'create',
          description:
            checked.length === 1
              ? `Added ${checked[0]!.name} to the staff list`
              : `Added ${checked.length} staff`,
          changes: checked.length === 1 ? changesOf(null, checked[0]!, STAFF_FIELDS) : undefined,
        }
      )
      .catch((e) => this.taken(e))
    return this.listOf(caller, workspaceId)
  }

  /** A person's name and role. Nothing changed changes nothing. */
  async update(caller: Caller, staffId: string, input: StaffInput): Promise<StaffListDto> {
    const s = await this.person(caller, staffId)
    const [list, participants] = await this.namesOf(s.workspaceId)
    const { checked, problems } = this.check([input], list, participants, s.id)
    if (problems.length) this.refuse(problems)
    const data = checked[0]!
    const changes = changesOf(s, data, STAFF_FIELDS)
    if (changes.length)
      await this.log
        .change(caller, (tx) => tx.staffMember.update({ where: { id: s.id }, data }), {
          workspaceId: s.workspaceId,
          resource: 'staff',
          subjectId: s.id,
          action: 'update',
          description: `Changed ${data.name}'s details on the staff list`,
          changes,
        })
        .catch((e) => this.taken(e))
    return this.listOf(caller, s.workspaceId)
  }

  /**
   * Removes a person from the list, with their engagement tags. Refused while saved payroll proof names them
   * (StaffPayProof, which the database also keeps them for): their pay in the files is what an engagement's card counts.
   */
  async remove(caller: Caller, staffId: string): Promise<StaffListDto> {
    const s = await this.person(caller, staffId)
    const kept = () =>
      new ConflictException(
        `${s.name} is in saved payroll proof, so stays on the staff list. Take them off their engagements instead.`
      )
    if (s._count.payProofs > 0) throw kept()
    try {
      await this.log.change(caller, (tx) => tx.staffMember.delete({ where: { id: s.id } }), {
        workspaceId: s.workspaceId,
        resource: 'staff',
        subjectId: s.id,
        action: 'delete',
        description: `Removed ${s.name} from the staff list`,
        changes: changesOf(s, null, STAFF_FIELDS),
      })
    } catch (e) {
      // A match saved meanwhile found them: the foreign key refused it.
      if ((e as { code?: string })?.code === 'P2003') throw kept()
      throw e
    }
    return this.listOf(caller, s.workspaceId)
  }

  /** Tags a person to an engagement of the same workspace they work on. Already on it changes nothing. */
  async assign(caller: Caller, staffId: string, engagementId: string): Promise<StaffListDto> {
    const s = await this.person(caller, staffId)
    const e = await this.prisma.engagement.findFirst({
      where: { id: engagementId, workspaceId: s.workspaceId },
      select: { id: true, name: true },
    })
    if (!e) throw new NotFoundException()
    const had = await this.prisma.staffAssignment.findFirst({
      where: { staffMemberId: s.id, engagementId: e.id },
    })
    if (!had)
      await this.log
        .change(
          caller,
          (tx) => tx.staffAssignment.create({ data: { staffMemberId: s.id, engagementId: e.id } }),
          {
            workspaceId: s.workspaceId,
            resource: 'staff',
            subjectId: s.id,
            action: 'update',
            description: `Put ${s.name} on ${e.name}`,
          }
        )
        .catch((err) => {
          // Two tabs at once: the other one put them on it.
          if ((err as { code?: string })?.code !== 'P2002') throw err
        })
    return this.listOf(caller, s.workspaceId)
  }

  /** Takes a person off an engagement. Not on it changes nothing. */
  async unassign(caller: Caller, staffId: string, engagementId: string): Promise<StaffListDto> {
    const s = await this.person(caller, staffId)
    const had = await this.prisma.staffAssignment.findFirst({
      where: { staffMemberId: s.id, engagementId },
      include: { engagement: { select: { name: true } } },
    })
    if (had)
      await this.log.change(
        caller,
        (tx) => tx.staffAssignment.deleteMany({ where: { id: had.id } }),
        {
          workspaceId: s.workspaceId,
          resource: 'staff',
          subjectId: s.id,
          action: 'update',
          description: `Took ${s.name} off ${had.engagement.name}`,
        }
      )
    return this.listOf(caller, s.workspaceId)
  }
}
