import { Body, Controller, Get, Param, Patch, Post, Res, UseGuards } from '@nestjs/common'
import type { Response } from 'express'
import type {
  EngagementDetail,
  EngagementInput,
  EngagementSummary,
  ParticipantDto,
  ReportSummary,
} from '@ad/types'
import { AuthenticatedGuard } from '../auth/authenticated.guard'
import { CallerService, UserId } from '../core/caller'
import { AuditPackageService } from './audit-package.service'
import { EngagementsService } from './engagements.service'

@Controller('engagements')
@UseGuards(AuthenticatedGuard)
export class EngagementsController {
  constructor(
    private readonly engagements: EngagementsService,
    private readonly audit: AuditPackageService,
    private readonly callers: CallerService
  ) {}

  @Get()
  async list(@UserId() userId: string): Promise<EngagementSummary[]> {
    return this.engagements.list(await this.callers.load(userId))
  }

  @Post()
  async create(@UserId() userId: string, @Body() body: EngagementInput): Promise<EngagementDetail> {
    return this.engagements.create(await this.callers.load(userId), body)
  }

  @Get(':id')
  async get(@UserId() userId: string, @Param('id') id: string): Promise<EngagementDetail> {
    return this.engagements.get(await this.callers.load(userId), id)
  }

  @Patch(':id')
  async update(
    @UserId() userId: string,
    @Param('id') id: string,
    @Body() body: Partial<EngagementInput>
  ): Promise<EngagementDetail> {
    return this.engagements.update(await this.callers.load(userId), id, body)
  }

  /** Everything the auditor will ask for, as one zip, organized by step and month. Logged as an export. */
  @Get(':id/audit-package')
  async auditPackage(
    @UserId() userId: string,
    @Param('id') id: string,
    @Res() res: Response
  ): Promise<void> {
    const pkg = await this.audit.build(await this.callers.load(userId), id)
    res.setHeader('Content-Type', 'application/zip')
    res.setHeader('Content-Disposition', `attachment; filename="${pkg.name.replace(/"/g, '')}"`)
    res.setHeader('Cache-Control', 'no-store')
    res.send(pkg.bytes)
  }

  @Post(':id/reports')
  async createReport(
    @UserId() userId: string,
    @Param('id') id: string,
    @Body() body: { period: string }
  ): Promise<ReportSummary> {
    return this.engagements.createReport(await this.callers.load(userId), id, body.period)
  }

  @Post(':id/participants')
  async createParticipant(
    @UserId() userId: string,
    @Param('id') id: string,
    @Body() body: { participantId: string; displayName: string; enrollmentStatus?: string }
  ): Promise<ParticipantDto> {
    return this.engagements.createParticipant(await this.callers.load(userId), id, body)
  }
}
