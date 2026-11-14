import { Throttle } from '@nestjs/throttler'
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Res,
  UploadedFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common'
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express'
import type { Response } from 'express'
import type {
  AccountMappingDto,
  BooksBillInput,
  BooksPaymentInput,
  WorkspaceExpensesDto,
  WorkspaceExpensesSavedDto,
} from '@ad/types'
import { AuthenticatedGuard } from '../auth/authenticated.guard'
import { CallerService, UserId } from '../core/caller'
import { ExpensesService, MAX_BOOKS_RECEIPTS } from './expenses.service'
import { sendInline } from '../payroll/payroll-match.controller'

/**
 * The month's expenses from the books (owner's decision, 2026-11-09): the lines of the accounting export in the month's
 * payroll files, routed to engagements and budget lines, and each engagement's account mapping. Owners save and
 * read; no one else sees it (owner's decision, 2026-11-14).
 */
@Controller()
@UseGuards(AuthenticatedGuard)
export class ExpensesController {
  constructor(
    private readonly expenses: ExpensesService,
    private readonly callers: CallerService
  ) {}

  /** An account mapping file (the payroll zip's "Account mapping" folder): read, kept for its engagement. */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('workspaces/:id/account-mappings')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024, files: 1 } }))
  async addMapping(
    @UserId() userId: string,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File | undefined
  ): Promise<AccountMappingDto> {
    return this.expenses.addMapping(await this.callers.load(userId), id, file)
  }

  @Patch('workspaces/:id/account-mappings/:mappingId')
  async setMapping(
    @UserId() userId: string,
    @Param('id') id: string,
    @Param('mappingId') mappingId: string,
    @Body() body: { engagementId?: unknown; category?: unknown; budgetLineId?: unknown }
  ): Promise<AccountMappingDto> {
    return this.expenses.setMapping(await this.callers.load(userId), id, mappingId, body ?? {})
  }

  @Delete('workspaces/:id/account-mappings/:mappingId')
  @HttpCode(204)
  async removeMapping(
    @UserId() userId: string,
    @Param('id') id: string,
    @Param('mappingId') mappingId: string
  ): Promise<void> {
    await this.expenses.removeMapping(await this.callers.load(userId), id, mappingId)
  }

  @Get('workspaces/:id/expenses/:period')
  async list(
    @UserId() userId: string,
    @Param('id') id: string,
    @Param('period') period: string
  ): Promise<WorkspaceExpensesDto> {
    return this.expenses.expenses(await this.callers.load(userId), id, period)
  }

  /** One of the month's receipts as uploaded: to view. Logged. */
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('workspaces/:id/expenses/:period/receipts/:documentId/file')
  async receiptFile(
    @UserId() userId: string,
    @Param('id') id: string,
    @Param('period') period: string,
    @Param('documentId') documentId: string,
    @Res() res: Response
  ): Promise<void> {
    sendInline(
      res,
      await this.expenses.receiptFile(await this.callers.load(userId), id, period, documentId)
    )
  }

  /** Removes one of the month's receipts from File Management: owners only, a hard delete. Logged. */
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Delete('workspaces/:id/expenses/:period/receipts/:documentId')
  async removeReceipt(
    @UserId() userId: string,
    @Param('id') id: string,
    @Param('period') period: string,
    @Param('documentId') documentId: string
  ): Promise<WorkspaceExpensesDto> {
    return this.expenses.removeReceipt(await this.callers.load(userId), id, period, documentId)
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('workspaces/:id/expenses/:period/save')
  async save(
    @UserId() userId: string,
    @Param('id') id: string,
    @Param('period') period: string
  ): Promise<WorkspaceExpensesSavedDto> {
    return this.expenses.save(await this.callers.load(userId), id, period)
  }

  /** Receipts for the month's bills (the zip's "Receipts" folder), or one bill's receipt (`transactionId`). */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('workspaces/:id/expenses/:period/receipts')
  @UseInterceptors(
    FilesInterceptor('files', MAX_BOOKS_RECEIPTS, {
      limits: { fileSize: 10 * 1024 * 1024, files: MAX_BOOKS_RECEIPTS },
    })
  )
  async addReceipts(
    @UserId() userId: string,
    @Param('id') id: string,
    @Param('period') period: string,
    @UploadedFiles() files: Express.Multer.File[] | undefined,
    @Body() body: { transactionId?: unknown }
  ): Promise<WorkspaceExpensesDto> {
    return this.expenses.addReceipts(
      await this.callers.load(userId),
      id,
      period,
      files,
      body?.transactionId
    )
  }

  /** An owner's word on one bill: its receipt, or dropped for want of one. */
  @Put('workspaces/:id/expenses/bills')
  async setBill(
    @UserId() userId: string,
    @Param('id') id: string,
    @Body() body: BooksBillInput
  ): Promise<WorkspaceExpensesDto> {
    return this.expenses.setBill(await this.callers.load(userId), id, body)
  }

  /** An owner's word on one bill's payment: the statement line that paid it, or null to match it again. */
  @Put('workspaces/:id/expenses/payments')
  async setPayment(
    @UserId() userId: string,
    @Param('id') id: string,
    @Body() body: BooksPaymentInput
  ): Promise<WorkspaceExpensesDto> {
    return this.expenses.setPayment(await this.callers.load(userId), id, body)
  }
}
