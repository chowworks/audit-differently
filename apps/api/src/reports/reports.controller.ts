import { Body, Controller, Delete, Get, Param, Patch, Post, Res, UseGuards } from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Response } from 'express'
import type {
  ClosingInput,
  DocumentPurpose,
  ExpenseInput,
  ReportDetail,
  WexPaymentInput,
} from '@ad/types'
import { AuthenticatedGuard } from '../auth/authenticated.guard'
import { CallerService, UserId } from '../core/caller'
import { MonthBundleService } from './month-bundle.service'
import { ReportsService } from './reports.service'

@Controller()
@UseGuards(AuthenticatedGuard)
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly bundles: MonthBundleService,
    private readonly callers: CallerService
  ) {}

  @Get('reports/:id')
  async get(@UserId() userId: string, @Param('id') id: string): Promise<ReportDetail> {
    return this.reports.get(await this.callers.load(userId), id)
  }

  /**
   * The month's bundle: the signed report, the ledger summary and the supporting records in one zip, for any member
   * of the workspace (no link to share). Personal records never go in. Logged once per download. Each one is built
   * in memory, so a client gets three a minute.
   */
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Get('reports/:id/bundle')
  async bundle(
    @UserId() userId: string,
    @Param('id') id: string,
    @Res() res: Response
  ): Promise<void> {
    const caller = await this.callers.load(userId)
    const bundle = await this.bundles.make(caller, id)
    await this.bundles.logDownload(caller, bundle)
    res.setHeader('Content-Type', 'application/zip')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${bundle.name.replace(/[^\x20-\x7e]|["\\]/g, '')}"`
    )
    res.setHeader('Cache-Control', 'no-store')
    try {
      await pipeline(Readable.from(this.bundles.stream(bundle)), res)
    } catch (e) {
      // Nothing was sent yet: answer with the error. Part way: cut the response so the download fails.
      if (!res.headersSent) throw e
      res.destroy()
    }
  }

  @Post('reports/:id/expenses')
  async addExpense(
    @UserId() userId: string,
    @Param('id') id: string,
    @Body() body: ExpenseInput
  ): Promise<ReportDetail> {
    return this.reports.addExpense(await this.callers.load(userId), id, body)
  }

  @Patch('expenses/:id')
  async updateExpense(
    @UserId() userId: string,
    @Param('id') id: string,
    @Body() body: ExpenseInput
  ): Promise<ReportDetail> {
    return this.reports.updateExpense(await this.callers.load(userId), id, body)
  }

  @Delete('expenses/:id')
  async deleteExpense(@UserId() userId: string, @Param('id') id: string): Promise<ReportDetail> {
    return this.reports.deleteExpense(await this.callers.load(userId), id)
  }

  @Post('expenses/:id/documents')
  async attach(
    @UserId() userId: string,
    @Param('id') id: string,
    @Body() body: { documentId: string; purpose: DocumentPurpose }
  ): Promise<ReportDetail> {
    return this.reports.attachToExpense(
      await this.callers.load(userId),
      id,
      body.purpose,
      body.documentId
    )
  }

  @Delete('expenses/:id/documents/:documentId')
  async detach(
    @UserId() userId: string,
    @Param('id') id: string,
    @Param('documentId') documentId: string
  ): Promise<ReportDetail> {
    return this.reports.detachFromExpense(await this.callers.load(userId), id, documentId)
  }

  @Post('reports/:id/wex')
  async addWex(
    @UserId() userId: string,
    @Param('id') id: string,
    @Body() body: WexPaymentInput
  ): Promise<ReportDetail> {
    return this.reports.addWexPayment(await this.callers.load(userId), id, body)
  }

  @Patch('wex/:id')
  async updateWex(
    @UserId() userId: string,
    @Param('id') id: string,
    @Body() body: WexPaymentInput
  ): Promise<ReportDetail> {
    return this.reports.updateWexPayment(await this.callers.load(userId), id, body)
  }

  @Delete('wex/:id')
  async deleteWex(@UserId() userId: string, @Param('id') id: string): Promise<ReportDetail> {
    return this.reports.deleteWexPayment(await this.callers.load(userId), id)
  }

  @Post('wex/:id/documents')
  async attachWex(
    @UserId() userId: string,
    @Param('id') id: string,
    @Body() body: { documentId: string; purpose: DocumentPurpose }
  ): Promise<ReportDetail> {
    return this.reports.attachToWex(
      await this.callers.load(userId),
      id,
      body.purpose,
      body.documentId
    )
  }

  @Post('reports/:id/submit')
  async submit(@UserId() userId: string, @Param('id') id: string): Promise<ReportDetail> {
    return this.reports.submit(await this.callers.load(userId), id)
  }

  @Post('reports/:id/closing')
  async approveClosing(
    @UserId() userId: string,
    @Param('id') id: string,
    @Body() body: ClosingInput
  ): Promise<ReportDetail> {
    return this.reports.approveClosing(await this.callers.load(userId), id, body)
  }

  @Post('reports/:id/send-back')
  async sendBack(
    @UserId() userId: string,
    @Param('id') id: string,
    @Body() body: { reason: string }
  ): Promise<ReportDetail> {
    return this.reports.sendBack(await this.callers.load(userId), id, body?.reason)
  }

  @Post('reports/:id/request-edits')
  async requestEdits(
    @UserId() userId: string,
    @Param('id') id: string,
    @Body() body: { comment?: unknown }
  ): Promise<ReportDetail> {
    return this.reports.requestEdits(await this.callers.load(userId), id, body?.comment)
  }

  /** A month with nothing in it: there is nothing to submit, so an owner deletes it. */
  @Delete('reports/:id')
  async deleteEmptyMonth(
    @UserId() userId: string,
    @Param('id') id: string
  ): Promise<{ engagementId: string }> {
    return this.reports.deleteEmptyMonth(await this.callers.load(userId), id)
  }

  @Post('reports/:id/reopen')
  async reopen(
    @UserId() userId: string,
    @Param('id') id: string,
    @Body() body: { reason: string }
  ): Promise<ReportDetail> {
    return this.reports.reopen(await this.callers.load(userId), id, body?.reason)
  }
}
