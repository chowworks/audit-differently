import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { WRITE_ROLES, type ParticipantDto } from '@ad/types'
import { ChecksService } from '../checks/checks.service'
import { AccessLogService } from '../core/access-log.service'
import { allow, tenantWhere, workspaceRole, type Caller } from '../core/caller'
import { linkDocument, NothingChanged, unlessUnchanged } from '../documents/link'
import type { StagedFile } from '../documents/staged-file'
import { changesOf } from '../core/changes'
import { eligibilityItemsOf } from '../engagements/eligibility'
import { PARTICIPANT_FIELDS, participantDto } from '../engagements/engagements.service'
import { cleanTags } from '../workspaces/tags'
import { PrismaService } from '../prisma/prisma.service'
import { backToDraft, BECAUSE } from '../reports/back-to-draft'
import type { Finding } from '../checks/rules'

/**
 * A checklist item as the participant's file shows it, in a sentence: "proof of age (birth certificate or state
 * ID)". Which kind of record, never anything from it.
 */
export const itemWords = (engagement: { eligibilityItems: unknown }, key: string) => {
  const label = eligibilityItemsOf(engagement).find((i) => i.key === key)?.label ?? key
  // Lower the first letter of a sentence-case label, never of an acronym ("ISS plan" stays).
  return /^[A-Z][a-z]/.test(label) ? label[0]!.toLowerCase() + label.slice(1) : label
}

/**
 * What a month's checks say, to compare before and after a change: its blocking and attention findings, in order.
 * Information findings never hold up a closing, so they do not count.
 */
const checksSay = (findings: Finding[]) =>
  findings
    .filter((f) => f.severity === 'blocker' || f.severity === 'attention')
    .map((f) => [f.code, f.severity, f.expenseId ?? '', f.participantId ?? '', f.message].join('|'))
    .sort()
    .join('\n')

/** A participant's eligibility file: the records attached to each item of the engagement's checklist. */
@Injectable()
export class ParticipantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly checks: ChecksService,
    private readonly log: AccessLogService
  ) {}

  /**
   * What the checks of each closed or submitted month of the engagement say now, before a change to a participant's
   * file.
   */
  private async lockedChecks(engagementId: string): Promise<Map<string, string>> {
    const closed = await this.prisma.monthlyReport.findMany({
      where: { engagementId, status: { in: ['closed', 'submitted'] } },
      select: { id: true },
    })
    const said = new Map<string, string>()
    for (const r of closed) said.set(r.id, checksSay(await this.checks.findings(r.id)))
    return said
  }

  /**
   * Runs the checks of every month of the engagement again, closed and submitted ones included (the owner's
   * decision, 2026-10-15). A closed or submitted month whose blocking or attention checks the change altered goes back
   * to draft (the owner's decisions, 2026-10-16): a closed one sent back, a submitted one reopened with its history
   * kept, one transaction and one line per month in the person's name. One whose checks say the same is left as it is.
   */
  private async refreshReports(
    caller: Caller,
    p: { engagementId: string; workspaceId: string | null; engagement: { name: string } },
    before: Map<string, string>
  ): Promise<void> {
    const engagement = { id: p.engagementId, name: p.engagement.name, workspaceId: p.workspaceId! }
    const reports = await this.prisma.monthlyReport.findMany({
      where: { engagementId: engagement.id },
      select: { id: true },
    })
    const changed: string[] = []
    for (const r of reports) {
      const after = checksSay(await this.checks.refresh(r.id))
      if (before.has(r.id) && before.get(r.id) !== after) changed.push(r.id)
    }
    for (const id of changed)
      await unlessUnchanged(() =>
        this.log.change(
          caller,
          (tx) => backToDraft(tx, caller, id, engagement, BECAUSE.participants),
          (sent) => sent.entry
        )
      )
  }

  private async writable(caller: Caller, id: string) {
    const p = await this.prisma.participant.findFirst({
      where: { id, ...tenantWhere(caller) },
      include: { engagement: { include: { workspace: true } } },
    })
    if (!p) throw new NotFoundException()
    allow(workspaceRole(caller, p.workspaceId!, WRITE_ROLES))
    return p
  }

  /**
   * Files a record under one checklist item: one the workspace holds (`source` is its id), or a new upload
   * (`source` is the staged file from POST /documents). A bookkeeper attaches personal records and does not read
   * them back. Answers the participant's engagement id.
   */
  async attach(
    caller: Caller,
    id: string,
    purpose: string,
    source: string | StagedFile
  ): Promise<string> {
    const p = await this.writable(caller, id)
    if (!eligibilityItemsOf(p.engagement).some((i) => i.key === purpose))
      throw new BadRequestException("purpose is not an item of this engagement's checklist")
    const before = await this.lockedChecks(p.engagementId)
    const key = (documentId: string) => ({
      participantId_documentId: { participantId: id, documentId },
    })
    await linkDocument(
      this.prisma,
      this.log,
      caller,
      {
        workspaceId: p.workspaceId!,
        engagementId: p.engagementId,
        resource: 'participant',
        subjectId: p.id,
        subject: `a participant's file in ${p.engagement.name}`,
        purpose,
        words: (k) => itemWords(p.engagement, k),
        namesItem: true,
        find: (tx, documentId) =>
          tx.participantDocument.findFirst({ where: { participantId: id, documentId } }),
        create: (tx, documentId) =>
          tx.participantDocument.create({ data: { participantId: id, documentId, purpose } }),
        move: (tx, documentId) =>
          tx.participantDocument.update({ where: key(documentId), data: { purpose } }),
      },
      source
    )
    await this.refreshReports(caller, p, before)
    return p.engagementId
  }

  /**
   * Changes a participant's tags, from the workspace's list. Personal data: the line names the field, never the
   * values. Answers the participant as the list shows them.
   */
  async setTags(caller: Caller, id: string, tags: unknown): Promise<ParticipantDto> {
    const p = await this.writable(caller, id)
    // A request without the list is not "no tags": clearing them is an empty list.
    if (tags == null) throw new BadRequestException('tags is required; send [] to clear them')
    const data = { tags: cleanTags(tags, p.engagement.workspace, 'participant', p.tags) }
    const changes = changesOf(p, data, PARTICIPANT_FIELDS)
    if (changes.length)
      await this.log.change(caller, (tx) => tx.participant.update({ where: { id }, data }), {
        workspaceId: p.workspaceId!,
        resource: 'participant',
        subjectId: p.id,
        action: 'update',
        description: `Changed the tags of a participant in ${p.engagement.name}`,
        changes,
      })
    const fresh = await this.prisma.participant.findFirst({
      where: { id, ...tenantWhere(caller) },
      include: { documents: { include: { document: true } } },
    })
    if (!fresh) throw new NotFoundException()
    return participantDto(fresh)
  }

  /**
   * Corrects a participant's details: their name, the funder's participant number and whether they are new or carried
   * over. Personal data: the line names the fields, never their values. The months' checks run again (their words name
   * the participant). Answers the participant as the list shows them.
   */
  async update(
    caller: Caller,
    id: string,
    input: { participantId?: unknown; displayName?: unknown; enrollmentStatus?: unknown }
  ): Promise<ParticipantDto> {
    const p = await this.writable(caller, id)
    const data: { participantId?: string; displayName?: string; enrollmentStatus?: string } = {}
    const problems: string[] = []
    if (input?.displayName !== undefined) {
      const name = typeof input.displayName === 'string' ? input.displayName.trim() : ''
      if (!name) problems.push('Name the participant')
      else if (name.length > 120) problems.push('Keep the name under 120 characters')
      else data.displayName = name
    }
    if (input?.participantId !== undefined) {
      const number = typeof input.participantId === 'string' ? input.participantId.trim() : ''
      if (!number) problems.push("Give the funder's participant number")
      else if (number.length > 40) problems.push('Keep the participant number under 40 characters')
      else if (
        number !== p.participantId &&
        (await this.prisma.participant.findFirst({
          where: {
            engagementId: p.engagementId,
            participantId: number,
            id: { not: id },
            ...tenantWhere(caller),
          },
          select: { id: true },
        }))
      )
        problems.push('Another participant of this engagement has that number')
      else data.participantId = number
    }
    if (input?.enrollmentStatus !== undefined) {
      if (input.enrollmentStatus !== 'new' && input.enrollmentStatus !== 'carryover')
        problems.push('Say whether they are new or carried over')
      else data.enrollmentStatus = input.enrollmentStatus
    }
    if (problems.length) throw new BadRequestException(problems.join('. '))
    const changes = changesOf(p, data, PARTICIPANT_FIELDS)
    if (changes.length) {
      const before = await this.lockedChecks(p.engagementId)
      await this.log.change(caller, (tx) => tx.participant.update({ where: { id }, data }), {
        workspaceId: p.workspaceId!,
        resource: 'participant',
        subjectId: p.id,
        action: 'update',
        description: `Changed a participant's details in ${p.engagement.name}`,
        changes,
      })
      await this.refreshReports(caller, p, before)
    }
    const fresh = await this.prisma.participant.findFirst({
      where: { id, ...tenantWhere(caller) },
      include: { documents: { include: { document: true } } },
    })
    if (!fresh) throw new NotFoundException()
    return participantDto(fresh)
  }

  /**
   * Removes a participant added by mistake. Refused while anything depends on them, saying what to take off first:
   * their work-experience payments (pay history the review reads) and the records in their eligibility file. Personal
   * data: the line names the fields, never their values.
   */
  async remove(caller: Caller, id: string): Promise<void> {
    const p = await this.writable(caller, id)
    const [payments, records] = await Promise.all([
      this.prisma.wexPayment.count({ where: { participantId: id, ...tenantWhere(caller) } }),
      this.prisma.participantDocument.count({
        where: { participantId: id, ...tenantWhere(caller) },
      }),
    ])
    const blocking = [
      payments && `${payments} work-experience payment${payments === 1 ? '' : 's'}`,
      records && `${records} record${records === 1 ? '' : 's'} in their eligibility file`,
    ].filter(Boolean)
    if (blocking.length)
      throw new ConflictException(
        `This participant has ${blocking.join(' and ')}: remove ${payments + records === 1 ? 'it' : 'them'} first`
      )
    const before = await this.lockedChecks(p.engagementId)
    await this.log.change(caller, (tx) => tx.participant.delete({ where: { id } }), {
      workspaceId: p.workspaceId!,
      resource: 'participant',
      subjectId: p.id,
      action: 'delete',
      description: `Removed a participant from ${p.engagement.name}`,
      changes: changesOf(p, null, PARTICIPANT_FIELDS),
    })
    await this.refreshReports(caller, p, before)
  }

  async detach(caller: Caller, id: string, documentId: string): Promise<void> {
    const p = await this.writable(caller, id)
    const before = await this.lockedChecks(p.engagementId)
    await unlessUnchanged(async () => {
      await this.log.change(
        caller,
        async (tx) => {
          const link = await tx.participantDocument.findFirst({
            where: { participantId: id, documentId },
          })
          if (!link) throw new NothingChanged()
          await tx.participantDocument.deleteMany({ where: { participantId: id, documentId } })
          return link
        },
        (link) => ({
          workspaceId: p.workspaceId!,
          resource: 'participant',
          subjectId: p.id,
          action: 'update',
          description: `Detached ${itemWords(p.engagement, link.purpose)} from a participant's file in ${p.engagement.name}`,
        })
      )
      await this.refreshReports(caller, p, before)
    })
  }
}
