import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common'
import type { HighlightSettingDto } from '@ad/types'
import { AdminGuard } from '../auth/admin.guard'
import { AuthenticatedGuard } from '../auth/authenticated.guard'
import { CallerService, UserId } from '../core/caller'
import { HighlightSettingsService } from '../payroll/highlight-settings.service'

/** Admin tools → Highlights: what is highlighted on each payroll proof type, for the whole system. */
@Controller('admin/highlights')
@UseGuards(AuthenticatedGuard, AdminGuard)
export class AdminHighlightsController {
  constructor(
    private readonly highlights: HighlightSettingsService,
    private readonly callers: CallerService
  ) {}

  @Get()
  async list(@UserId() userId: string): Promise<HighlightSettingDto[]> {
    await this.callers.loadAdmin(userId)
    return this.highlights.list()
  }

  @Put(':kind')
  async set(
    @UserId() userId: string,
    @Param('kind') kind: string,
    @Body() body: { fields?: unknown }
  ): Promise<HighlightSettingDto[]> {
    return this.highlights.set(await this.callers.loadAdmin(userId), kind, body?.fields)
  }
}
