import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common'
import type { ExpenseMatchingChangeDto, ExpenseMatchingDto } from '@ad/types'
import { AdminGuard } from '../auth/admin.guard'
import { AuthenticatedGuard } from '../auth/authenticated.guard'
import { CallerService, UserId } from '../core/caller'
import { ExpenseMatchingService } from '../expenses/expense-matching.service'

/** Admin tools → File Matching, its expense matching: the day windows the books' bills are matched to their proof by. */
@Controller('admin/expense-matching')
@UseGuards(AuthenticatedGuard, AdminGuard)
export class AdminExpenseMatchingController {
  constructor(
    private readonly matching: ExpenseMatchingService,
    private readonly callers: CallerService
  ) {}

  @Get()
  async get(@UserId() userId: string): Promise<ExpenseMatchingDto> {
    await this.callers.loadAdmin(userId)
    return this.matching.get()
  }

  /** Every save, newest first, with what it changed. */
  @Get('history')
  async history(@UserId() userId: string): Promise<ExpenseMatchingChangeDto[]> {
    await this.callers.loadAdmin(userId)
    return this.matching.history()
  }

  @Put()
  async set(@UserId() userId: string, @Body() body: unknown): Promise<ExpenseMatchingDto> {
    return this.matching.set(await this.callers.loadAdmin(userId), body)
  }
}
