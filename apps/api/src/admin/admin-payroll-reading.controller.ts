import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common'
import type { PayrollReadingDto, PayrollSettingChangeDto } from '@ad/types'
import { AdminGuard } from '../auth/admin.guard'
import { AuthenticatedGuard } from '../auth/authenticated.guard'
import { CallerService, UserId } from '../core/caller'
import { PayrollReadingService } from '../payroll/payroll-reading.service'

/** Admin tools → Payroll reading: the words and day windows the payroll matchers read files by, for the whole system. */
@Controller('admin/payroll-reading')
@UseGuards(AuthenticatedGuard, AdminGuard)
export class AdminPayrollReadingController {
  constructor(
    private readonly reading: PayrollReadingService,
    private readonly callers: CallerService
  ) {}

  @Get()
  async get(@UserId() userId: string): Promise<PayrollReadingDto> {
    await this.callers.loadAdmin(userId)
    return this.reading.get()
  }

  /** Every save of the reading words and the proof highlighting, newest first, with what it changed. */
  @Get('history')
  async history(@UserId() userId: string): Promise<PayrollSettingChangeDto[]> {
    await this.callers.loadAdmin(userId)
    return this.reading.history()
  }

  @Put()
  async set(@UserId() userId: string, @Body() body: unknown): Promise<PayrollReadingDto> {
    return this.reading.set(await this.callers.loadAdmin(userId), body)
  }
}
