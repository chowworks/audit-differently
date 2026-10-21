import { Throttle } from '@nestjs/throttler'
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common'
import { FilesInterceptor } from '@nestjs/platform-express'
import type { Response } from 'express'
import type {
  PayrollMatchProgress,
  PayrollMatchRunDto,
  PayrollMatchSaveInput,
  ReportDetail,
} from '@ad/types'
import { AuthenticatedGuard } from '../auth/authenticated.guard'
import { CallerService, UserId } from '../core/caller'
import { MAX_UPLOAD_BYTES } from '../documents/documents.service'
import { payrollAiAvailable, payrollAiBeta } from './ai-read-payroll'
import { PayrollMatchService } from './payroll-match.service'
import { MAX_PAYROLL_FILES } from './payroll.service'

/** "Match payroll & timecards": a payroll zip staged on the server, matched, then saved or discarded. */
@Controller()
@UseGuards(AuthenticatedGuard)
export class PayrollMatchController {
  constructor(
    private readonly match: PayrollMatchService,
    private readonly callers: CallerService
  ) {}

  /**
   * Whether payroll files can be read with AI here, and whether it is the beta (#22): the Upload step shows its tick-box
   * from this, before there is an upload. No workspace data: nothing to log.
   */
  @Get('payroll-ai')
  payrollAi(): { available: boolean; beta: boolean } {
    return { available: payrollAiAvailable(), beta: payrollAiBeta() }
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('reports/:id/payroll-match')
  async start(
    @UserId() userId: string,
    @Param('id') id: string,
    @Body() body: { replace?: unknown }
  ): Promise<PayrollMatchRunDto> {
    return this.match.start(await this.callers.load(userId), id, body?.replace === true)
  }

  // A 200-file zip goes up in 10 batches of 20.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('payroll-match/:runId/files')
  @UseInterceptors(
    FilesInterceptor('files', MAX_PAYROLL_FILES, {
      limits: { fileSize: MAX_UPLOAD_BYTES, files: MAX_PAYROLL_FILES },
    })
  )
  async add(
    @UserId() userId: string,
    @Param('runId') runId: string,
    @UploadedFiles() files: Express.Multer.File[] | undefined,
    @Body() body: { kinds?: string | string[] }
  ): Promise<PayrollMatchRunDto> {
    return this.match.add(await this.callers.load(userId), runId, files ?? [], body?.kinds)
  }

  /** The caller's unsaved run of the month, if any: the wizard picks it up where it was. */
  @Get('reports/:id/payroll-match')
  async latest(
    @UserId() userId: string,
    @Param('id') id: string
  ): Promise<PayrollMatchRunDto | null> {
    return this.match.latest(await this.callers.load(userId), id)
  }

  /** Polled while the job reads: counts only. */
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Get('payroll-match/:runId/progress')
  async progress(
    @UserId() userId: string,
    @Param('runId') runId: string
  ): Promise<PayrollMatchProgress> {
    return this.match.progress(await this.callers.load(userId), runId)
  }

  @Get('payroll-match/:runId')
  async get(@UserId() userId: string, @Param('runId') runId: string): Promise<PayrollMatchRunDto> {
    return this.match.get(await this.callers.load(userId), runId)
  }

  /** Reads up to three files of the match with AI, when the person ticked it; the run as it now matches. */
  @Throttle({ default: { limit: 40, ttl: 60_000 } })
  @Post('payroll-match/:runId/ai-read')
  async aiRead(
    @UserId() userId: string,
    @Param('runId') runId: string,
    @Body() body: unknown
  ): Promise<PayrollMatchRunDto> {
    return this.match.aiRead(await this.callers.load(userId), runId, body)
  }

  /** A file of the run, for the viewer: every payroll file, a pay stub included (owner's decision, 2026-10-16). */
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('payroll-match/:runId/files/:fileId')
  async file(
    @UserId() userId: string,
    @Param('runId') runId: string,
    @Param('fileId') fileId: string,
    @Res() res: Response
  ): Promise<void> {
    const f = await this.match.file(await this.callers.load(userId), runId, fileId)
    sendInline(res, f)
  }

  /** One item's own copy of a file of the run, highlighted for it alone: what Show displays. */
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('payroll-match/:runId/files/:fileId/copy')
  async copy(
    @UserId() userId: string,
    @Param('runId') runId: string,
    @Param('fileId') fileId: string,
    @Query('target') target: string,
    @Query('id') id: string,
    @Query('slot') slot: string,
    @Res() res: Response
  ): Promise<void> {
    const f = await this.match.copy(
      await this.callers.load(userId),
      runId,
      fileId,
      target,
      id,
      slot
    )
    sendInline(res, f)
  }

  @Post('payroll-match/:runId/save')
  async save(
    @UserId() userId: string,
    @Param('runId') runId: string,
    @Body() body: PayrollMatchSaveInput
  ): Promise<ReportDetail> {
    return this.match.save(await this.callers.load(userId), runId, body)
  }

  @Delete('payroll-match/:runId')
  @HttpCode(204)
  async discard(@UserId() userId: string, @Param('runId') runId: string): Promise<void> {
    await this.match.discard(await this.callers.load(userId), runId)
  }
}

/** A file for the viewer: shown in the browser, never cached. */
export function sendInline(
  res: Response,
  f: { bytes: Uint8Array; contentType: string; fileName: string }
): void {
  res.setHeader('Content-Type', f.contentType)
  res.setHeader(
    'Content-Disposition',
    `inline; filename="${f.fileName.replace(/["\\\r\n]/g, '_')}"`
  )
  res.setHeader('Cache-Control', 'no-store')
  res.end(Buffer.from(f.bytes))
}
