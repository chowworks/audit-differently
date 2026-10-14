import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { WRITE_ROLES } from '@ad/types'
import { ChecksService } from '../checks/checks.service'
import { AccessLogService } from '../core/access-log.service'
import { allow, tenantWhere, workspaceRole, type Caller } from '../core/caller'
import { linkDocument, NothingChanged, unlessUnchanged } from '../documents/link'
import type { StagedFile } from '../documents/staged-file'
import { eligibilityItemsOf } from '../engagements/eligibility'
import { PrismaService } from '../prisma/prisma.service'

/**
 * A checklist item as the participant's file shows it, in a sentence: "proof of age (birth certificate or state
 * ID)". Which kind of record, never anything from it.
 */
export const itemWords = (engagement: { eligibilityItems: unknown }, key: string) => {
  const label = eligibilityItemsOf(engagement).find((i) => i.key === key)?.label ?? key
  // Lower the first letter of a sentence-case label, never of an acronym ("ISS plan" stays).
  return /^[A-Z][a-z]/.test(label) ? label[0]!.toLowerCase() + label.slice(1) : label
}

/** A participant's eligibility file: the records attached to each item of the engagement's checklist. */
@Injectable()
export class ParticipantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly checks: ChecksService,
    private readonly log: AccessLogService
  ) {}

  private async refreshOpenReports(engagementId: string): Promise<void> {
    const reports = await this.prisma.monthlyReport.findMany({
      where: { engagementId, status: { in: ['draft', 'submitted', 'under-review'] } },
      select: { id: true },
    })
    for (const r of reports) await this.checks.refresh(r.id)
  }

  private async writable(caller: Caller, id: string) {
    const p = await this.prisma.participant.findFirst({
      where: { id, ...tenantWhere(caller) },
      include: { engagement: true },
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
    await this.refreshOpenReports(p.engagementId)
    return p.engagementId
  }

  async detach(caller: Caller, id: string, documentId: string): Promise<void> {
    const p = await this.writable(caller, id)
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
      await this.refreshOpenReports(p.engagementId)
    })
  }
}
