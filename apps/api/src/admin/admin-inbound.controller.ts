import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common'
import type { AdminInboundDto, AdminInboundReceiptDto } from '@ad/types'
import { AdminGuard } from '../auth/admin.guard'
import { AuthenticatedGuard } from '../auth/authenticated.guard'
import { CallerService, UserId } from '../core/caller'
import { AdminInboundService } from './admin-inbound.service'

/** Admin tools → Email administration: emailed receipts that went nowhere, or were refused or failed. */
@Controller('admin/inbound')
@UseGuards(AuthenticatedGuard, AdminGuard)
export class AdminInboundController {
  constructor(
    private readonly inbound: AdminInboundService,
    private readonly callers: CallerService
  ) {}

  @Get()
  async list(@UserId() userId: string): Promise<AdminInboundDto> {
    return this.inbound.list(await this.callers.loadAdmin(userId))
  }

  @Post(':id/run-again')
  async runAgain(
    @UserId() userId: string,
    @Param('id') id: string
  ): Promise<AdminInboundReceiptDto> {
    return this.inbound.runAgain(await this.callers.loadAdmin(userId), id)
  }
}
