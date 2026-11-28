import { Body, Controller, Delete, Get, Param, Post, Patch, Put, UseGuards } from '@nestjs/common'
import type {
  BudgetChange,
  BudgetLineInput,
  PayrollRollupDto,
  PayrollRollupPreviewDto,
  PayrollRollupSaved,
} from '@ad/types'
import { AuthenticatedGuard } from '../auth/authenticated.guard'
import { CallerService, UserId } from '../core/caller'
import { BudgetService } from './budget.service'
import { PayrollRollupService } from './payroll-rollup.service'

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

/** Map Payroll Budget Line Items (#138): which budget lines hold each kind of payroll, on the workspace page. */
@Controller('workspaces/:id/payroll-rollup')
@UseGuards(AuthenticatedGuard)
export class PayrollRollupController {
  constructor(
    private readonly rollup: PayrollRollupService,
    private readonly callers: CallerService
  ) {}

  @Get()
  async list(@UserId() userId: string, @Param('id') id: string): Promise<PayrollRollupDto> {
    return this.rollup.list(await this.callers.load(userId), id)
  }

  /** What saving a kind would change: the engagements whose line changes and their months that go back to draft. */
  @Post(':kind/preview')
  async preview(
    @UserId() userId: string,
    @Param('id') id: string,
    @Param('kind') kind: string,
    @Body() body: unknown
  ): Promise<PayrollRollupPreviewDto> {
    return this.rollup.preview(await this.callers.load(userId), id, kind, body)
  }

  @Put(':kind')
  async save(
    @UserId() userId: string,
    @Param('id') id: string,
    @Param('kind') kind: string,
    @Body() body: unknown
  ): Promise<PayrollRollupSaved> {
    return this.rollup.save(await this.callers.load(userId), id, kind, body)
  }
}
