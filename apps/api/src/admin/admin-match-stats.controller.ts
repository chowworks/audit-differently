import { Controller, Get, Query, UseGuards } from '@nestjs/common'
import type { AdminMatchStatsDto } from '@ad/types'
import { AdminGuard } from '../auth/admin.guard'
import { AuthenticatedGuard } from '../auth/authenticated.guard'
import { CallerService, UserId } from '../core/caller'
import { AdminMatchStatsService } from './admin-match-stats.service'

/** Admin tools → Matching statistics: how the payroll and receipt matchers run, across workspaces. Counts only. */
@Controller('admin/match-stats')
@UseGuards(AuthenticatedGuard, AdminGuard)
export class AdminMatchStatsController {
  constructor(
    private readonly stats: AdminMatchStatsService,
    private readonly callers: CallerService
  ) {}

  @Get()
  async list(
    @UserId() userId: string,
    @Query('days') days?: string,
    @Query('feature') feature?: string
  ): Promise<AdminMatchStatsDto> {
    return this.stats.list(await this.callers.loadAdmin(userId), days, feature)
  }
}
