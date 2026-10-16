import { Body, Controller, Delete, Param, Patch, Post, UseGuards } from '@nestjs/common'
import type { BudgetChange, BudgetLineInput } from '@ad/types'
import { AuthenticatedGuard } from '../auth/authenticated.guard'
import { CallerService, UserId } from '../core/caller'
import { BudgetService } from './budget.service'

/**
 * The approved budget's lines (step 4). Each answers with the engagement as its page shows it, and the closed or
 * submitted months the change left with a blocking check.
 */
@Controller('engagements/:id/budget-lines')
@UseGuards(AuthenticatedGuard)
export class BudgetController {
  constructor(
    private readonly budget: BudgetService,
    private readonly callers: CallerService
  ) {}

  @Post()
  async add(
    @UserId() userId: string,
    @Param('id') id: string,
    @Body() body: BudgetLineInput
  ): Promise<BudgetChange> {
    return this.budget.add(await this.callers.load(userId), id, body)
  }

  @Patch(':lineId')
  async update(
    @UserId() userId: string,
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body() body: BudgetLineInput
  ): Promise<BudgetChange> {
    return this.budget.update(await this.callers.load(userId), id, lineId, body)
  }

  @Delete(':lineId')
  async remove(
    @UserId() userId: string,
    @Param('id') id: string,
    @Param('lineId') lineId: string
  ): Promise<BudgetChange> {
    return this.budget.remove(await this.callers.load(userId), id, lineId)
  }
}
