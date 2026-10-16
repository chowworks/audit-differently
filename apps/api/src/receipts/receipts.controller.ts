import { Throttle } from '@nestjs/throttler'
import {
  Body,
  Controller,
  Delete,
  Param,
  Patch,
  Post,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common'
import { FilesInterceptor } from '@nestjs/platform-express'
import type { ReceiptInput, ReceiptUploadResult, ReportDetail } from '@ad/types'
import { AuthenticatedGuard } from '../auth/authenticated.guard'
import { CallerService, UserId } from '../core/caller'
import { MAX_RECEIPT_BYTES, MAX_RECEIPTS, ReceiptsService } from './receipts.service'

/** A month's receipts: upload many at once, correct what was read, match, unmatch, dismiss. */
@Controller()
@UseGuards(AuthenticatedGuard)
export class ReceiptsController {
  constructor(
    private readonly receipts: ReceiptsService,
    private readonly callers: CallerService
  ) {}

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('reports/:id/receipts')
  @UseInterceptors(
    FilesInterceptor('files', MAX_RECEIPTS, {
      limits: { fileSize: MAX_RECEIPT_BYTES, files: MAX_RECEIPTS },
    })
  )
  async upload(
    @UserId() userId: string,
    @Param('id') id: string,
    @UploadedFiles() files: Express.Multer.File[] | undefined,
    @Body() body: { kind?: string; ai?: string }
  ): Promise<ReceiptUploadResult> {
    // AI reads them only when the person ticked "Read the amount, date and vendor with AI" (the form sends "true").
    return this.receipts.upload(
      await this.callers.load(userId),
      id,
      files ?? [],
      body?.kind,
      body?.ai === 'true'
    )
  }

  @Patch('receipts/:id')
  async edit(
    @UserId() userId: string,
    @Param('id') id: string,
    @Body() body: ReceiptInput
  ): Promise<ReportDetail> {
    return this.receipts.edit(await this.callers.load(userId), id, body)
  }

  @Post('receipts/:id/match')
  async match(
    @UserId() userId: string,
    @Param('id') id: string,
    @Body() body: { expenseId: string }
  ): Promise<ReportDetail> {
    return this.receipts.match(await this.callers.load(userId), id, body?.expenseId)
  }

  @Delete('receipts/:id/match/:expenseId')
  async unmatch(
    @UserId() userId: string,
    @Param('id') id: string,
    @Param('expenseId') expenseId: string
  ): Promise<ReportDetail> {
    return this.receipts.unmatch(await this.callers.load(userId), id, expenseId)
  }

  @Post('receipts/:id/dismiss')
  async dismiss(
    @UserId() userId: string,
    @Param('id') id: string,
    @Body() body: { dismissed: boolean }
  ): Promise<ReportDetail> {
    return this.receipts.dismiss(await this.callers.load(userId), id, body?.dismissed)
  }
}
