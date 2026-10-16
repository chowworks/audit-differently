import { Throttle } from '@nestjs/throttler'
import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Put,
  Res,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common'
import { FilesInterceptor } from '@nestjs/platform-express'
import type { Response } from 'express'
import type {
  PayrollLineSearch,
  PayrollUploadResult,
  ReportDetail,
  StatementLinkInput,
} from '@ad/types'
import { AuthenticatedGuard } from '../auth/authenticated.guard'
import { CallerService, UserId } from '../core/caller'
import { MAX_UPLOAD_BYTES } from '../documents/documents.service'
import { sendInline } from './payroll-match.controller'
import { MAX_PAYROLL_FILES, PayrollService, type PayrollTarget } from './payroll.service'

const target = (t: string): PayrollTarget => {
  if (t !== 'expense' && t !== 'wex') throw new NotFoundException()
  return t
}

/** A month's payroll proof: upload many documents at once, find an item's line on a bank statement, link and mark it. */
@Controller()
@UseGuards(AuthenticatedGuard)
export class PayrollController {
  constructor(
    private readonly payroll: PayrollService,
    private readonly callers: CallerService
  ) {}

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('reports/:id/payroll-documents')
  @UseInterceptors(
    FilesInterceptor('files', MAX_PAYROLL_FILES, {
      limits: { fileSize: MAX_UPLOAD_BYTES, files: MAX_PAYROLL_FILES },
    })
  )
  async upload(
    @UserId() userId: string,
    @Param('id') id: string,
    @UploadedFiles() files: Express.Multer.File[] | undefined,
    @Body() body: { kinds?: string | string[] }
  ): Promise<PayrollUploadResult> {
    return this.payroll.upload(await this.callers.load(userId), id, files ?? [], body?.kinds)
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('reports/:id/payroll-documents/replace')
  async replace(
    @UserId() userId: string,
    @Param('id') id: string,
    @Body() body: { documentIds?: unknown }
  ): Promise<ReportDetail> {
    return this.payroll.replace(await this.callers.load(userId), id, body?.documentIds)
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('payroll/:target/:id/lines')
  async lines(
    @UserId() userId: string,
    @Param('target') t: string,
    @Param('id') id: string
  ): Promise<PayrollLineSearch> {
    return this.payroll.findLines(await this.callers.load(userId), target(t), id)
  }

  /** The statement's bytes for the viewer: the browser never fetches from storage itself. */
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('payroll/statements/:documentId/file')
  async file(
    @UserId() userId: string,
    @Param('documentId') documentId: string,
    @Res() res: Response
  ): Promise<void> {
    const bytes = await this.payroll.statementFile(await this.callers.load(userId), documentId)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', 'inline')
    res.setHeader('Cache-Control', 'no-store')
    res.end(bytes)
  }

  /** A payroll proof as its item's own copy, highlighted for that item alone. */
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('payroll/:target/:id/proof/:documentId')
  async proof(
    @UserId() userId: string,
    @Param('target') t: string,
    @Param('id') id: string,
    @Param('documentId') documentId: string,
    @Res() res: Response
  ): Promise<void> {
    sendInline(
      res,
      await this.payroll.proofCopy(await this.callers.load(userId), target(t), id, documentId)
    )
  }

  @Put('payroll/:target/:id/statement')
  async link(
    @UserId() userId: string,
    @Param('target') t: string,
    @Param('id') id: string,
    @Body() body: StatementLinkInput
  ): Promise<ReportDetail> {
    return this.payroll.link(await this.callers.load(userId), target(t), id, body)
  }
}
