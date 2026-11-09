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
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import type { AccountMappingDto, WorkspaceExpensesDto, WorkspaceExpensesSavedDto } from '@ad/types'
import { AuthenticatedGuard } from '../auth/authenticated.guard'
import { CallerService, UserId } from '../core/caller'
import { ExpensesService } from './expenses.service'

/**
 * The month's expenses from the books (owner's decision, 2026-11-09): the lines of the accounting export in the month's
 * payroll files, routed to engagements and budget lines, and each engagement's account mapping. Owners save; owners
 * and auditors read.
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

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('workspaces/:id/expenses/:period/save')
  async save(
    @UserId() userId: string,
    @Param('id') id: string,
    @Param('period') period: string
  ): Promise<WorkspaceExpensesSavedDto> {
    return this.expenses.save(await this.callers.load(userId), id, period)
  }
}
