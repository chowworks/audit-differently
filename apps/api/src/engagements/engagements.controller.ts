import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Response } from 'express'
import type {
  AuditPackagePartsDto,
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

  /**
   * Everything the auditor will ask for, as one zip, organized by step and month. Logged as an export. A package
   * over about 1.5 GB of files is split: without `?part=` it answers with the list of parts, and `?part=n`
   * downloads part n. A package that fits in one zip is that zip, as ever.
   */
  @Get(':id/audit-package')
  async auditPackage(
    @UserId() userId: string,
    @Param('id') id: string,
    @Query('part') part: string | undefined,
    @Res() res: Response
  ): Promise<void> {
    const caller = await this.callers.load(userId)
    const plan = await this.audit.plan(caller, id)
    const layouts = this.audit.parts(plan)
    if (layouts.length > 1 && part === undefined) {
      const body: AuditPackagePartsDto = {
        parts: layouts.map((l) => ({ n: l.n, fileName: l.fileName, sourceBytes: l.sourceBytes })),
      }
      res.setHeader('Cache-Control', 'no-store')
      res.json(body)
      return
    }
    const n = part === undefined ? 1 : Number(part)
    if (!Number.isInteger(n) || n < 1 || n > layouts.length) throw new NotFoundException()
    await this.audit.logExport(
      caller,
      plan,
      layouts.length > 1 ? { layout: layouts[n - 1]!, total: layouts.length } : undefined
    )
    res.setHeader('Content-Type', 'application/zip')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${layouts[n - 1]!.fileName.replace(/["\r\n]/g, '')}"`
    )
    res.setHeader('Cache-Control', 'no-store')
    try {
      await pipeline(Readable.from(this.audit.streamPart(plan, layouts, n)), res)
    } catch (e) {
      // Nothing was sent yet: answer with the error. Part way: cut the response so the download fails.
      if (!res.headersSent) throw e
      res.destroy()
    }
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
    @Body()
    body: { participantId: string; displayName: string; enrollmentStatus?: string; tags?: unknown }
  ): Promise<ParticipantDto> {
    return this.engagements.createParticipant(await this.callers.load(userId), id, body)
  }
}
