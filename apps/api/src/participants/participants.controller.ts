import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common'
import { WRITE_ROLES } from '@ad/types'
import { eligibilityItemsOf } from '../engagements/eligibility'
import { AuthenticatedGuard } from '../auth/authenticated.guard'
import { ChecksService } from '../checks/checks.service'
import { AccessLogService } from '../core/access-log.service'
import { allow, CallerService, tenantWhere, UserId, workspaceRole } from '../core/caller'
import { PrismaService } from '../prisma/prisma.service'

@Controller('participants')
@UseGuards(AuthenticatedGuard)
export class ParticipantsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly callers: CallerService,
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

  @Post(':id/documents')
  @HttpCode(204)
  async attach(
    @UserId() userId: string,
    @Param('id') id: string,
    @Body() body: { documentId: string; purpose: string }
  ): Promise<void> {
    const caller = await this.callers.load(userId)
    const p = await this.prisma.participant.findFirst({
      where: { id, ...tenantWhere(caller) },
      include: { engagement: true },
    })
    if (!p) throw new NotFoundException()
    if (!eligibilityItemsOf(p.engagement).some((i) => i.key === body.purpose))
      throw new BadRequestException("purpose is not an item of this engagement's checklist")
    allow(workspaceRole(caller, p.workspaceId!, WRITE_ROLES))
    const doc = await this.prisma.document.findFirst({
      where: { id: body.documentId, workspaceId: p.workspaceId! },
    })
    if (!doc) throw new NotFoundException('No such document in this workspace')
    await this.prisma.participantDocument.upsert({
      where: { participantId_documentId: { participantId: id, documentId: doc.id } },
      update: { purpose: body.purpose },
      create: { participantId: id, documentId: doc.id, purpose: body.purpose },
    })
    await this.log.log(caller, {
      workspaceId: p.workspaceId!,
      resource: 'participant',
      subjectId: p.id,
      action: 'update',
      detail: `attached ${body.purpose}`,
    })
    await this.refreshOpenReports(p.engagementId)
  }

  @Delete(':id/documents/:documentId')
  @HttpCode(204)
  async detach(
    @UserId() userId: string,
    @Param('id') id: string,
    @Param('documentId') documentId: string
  ): Promise<void> {
    const caller = await this.callers.load(userId)
    const p = await this.prisma.participant.findFirst({ where: { id, ...tenantWhere(caller) } })
    if (!p) throw new NotFoundException()
    allow(workspaceRole(caller, p.workspaceId!, WRITE_ROLES))
    await this.prisma.participantDocument.deleteMany({ where: { participantId: id, documentId } })
    await this.refreshOpenReports(p.engagementId)
  }
}
