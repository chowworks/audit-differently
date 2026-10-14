import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common'
import type {
  DocumentPurpose,
  ExpenseInput,
  ReportDetail,
  ReportReview,
  WexPaymentInput,
} from '@ad/types'
import { AuthenticatedGuard } from '../auth/authenticated.guard'
import { CallerService, UserId } from '../core/caller'
import { ReportsService } from './reports.service'

@Controller()
@UseGuards(AuthenticatedGuard)
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly callers: CallerService
  ) {}

  @Get('reports/:id')
  async get(@UserId() userId: string, @Param('id') id: string): Promise<ReportDetail> {
    return this.reports.get(await this.callers.load(userId), id)
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

  @Post('reports/:id/review')
  async review(
    @UserId() userId: string,
    @Param('id') id: string,
    @Body() body: { decision: 'approve' | 'deny'; reason?: string; review?: ReportReview }
  ): Promise<ReportDetail> {
    return this.reports.review(await this.callers.load(userId), id, body)
  }

  @Post('reports/:id/reopen')
  async reopen(@UserId() userId: string, @Param('id') id: string): Promise<ReportDetail> {
    return this.reports.reopen(await this.callers.load(userId), id)
  }
}
