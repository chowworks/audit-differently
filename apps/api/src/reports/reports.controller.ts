import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common'
import type {
  CheckDto,
  DocumentPurpose,
  ExpenseDto,
  ExpenseInput,
  ReportDetail,
  ReportReview,
  WexPaymentDto,
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
  ): Promise<ExpenseDto> {
    return this.reports.addExpense(await this.callers.load(userId), id, body)
  }

  @Patch('expenses/:id')
  async updateExpense(
    @UserId() userId: string,
    @Param('id') id: string,
    @Body() body: ExpenseInput
  ): Promise<ExpenseDto> {
    return this.reports.updateExpense(await this.callers.load(userId), id, body)
  }

  @Delete('expenses/:id')
  @HttpCode(204)
  async deleteExpense(@UserId() userId: string, @Param('id') id: string): Promise<void> {
    await this.reports.deleteExpense(await this.callers.load(userId), id)
  }

  @Post('expenses/:id/documents')
  @HttpCode(204)
  async attach(
    @UserId() userId: string,
    @Param('id') id: string,
    @Body() body: { documentId: string; purpose: DocumentPurpose }
  ): Promise<void> {
    await this.reports.attachToExpense(
      await this.callers.load(userId),
      id,
      body.documentId,
      body.purpose
    )
  }

  @Delete('expenses/:id/documents/:documentId')
  @HttpCode(204)
  async detach(
    @UserId() userId: string,
    @Param('id') id: string,
    @Param('documentId') documentId: string
  ): Promise<void> {
    await this.reports.detachFromExpense(await this.callers.load(userId), id, documentId)
  }

  @Post('reports/:id/wex')
  async addWex(
    @UserId() userId: string,
    @Param('id') id: string,
    @Body() body: WexPaymentInput
  ): Promise<WexPaymentDto> {
    return this.reports.addWexPayment(await this.callers.load(userId), id, body)
  }

  @Post('wex/:id/documents')
  @HttpCode(204)
  async attachWex(
    @UserId() userId: string,
    @Param('id') id: string,
    @Body() body: { documentId: string; purpose: DocumentPurpose }
  ): Promise<void> {
    await this.reports.attachToWex(
      await this.callers.load(userId),
      id,
      body.documentId,
      body.purpose
    )
  }

  @Post('reports/:id/submit')
  async submit(
    @UserId() userId: string,
    @Param('id') id: string
  ): Promise<{ blockers: CheckDto[] }> {
    return this.reports.submit(await this.callers.load(userId), id)
  }

  @Post('reports/:id/review')
  @HttpCode(204)
  async review(
    @UserId() userId: string,
    @Param('id') id: string,
    @Body() body: { decision: 'approve' | 'deny'; reason?: string; review?: ReportReview }
  ): Promise<void> {
    await this.reports.review(await this.callers.load(userId), id, body)
  }

  @Post('reports/:id/reopen')
  @HttpCode(204)
  async reopen(@UserId() userId: string, @Param('id') id: string): Promise<void> {
    await this.reports.reopen(await this.callers.load(userId), id)
  }
}
