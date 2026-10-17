import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common'
import type { AdminReceiptsAddressesDto, ReleaseReceiptsAddressBody } from '@ad/types'
import { AdminGuard } from '../auth/admin.guard'
import { AuthenticatedGuard } from '../auth/authenticated.guard'
import { CallerService, UserId } from '../core/caller'
import { AdminReceiptsAddressesService } from './admin-receipts-addresses.service'

/**
 * Admin tools → Email administration → Receipts addresses: every receipts address used, and releasing a previously
 * used one.
 */
@Controller('admin/receipts-addresses')
@UseGuards(AuthenticatedGuard, AdminGuard)
export class AdminReceiptsAddressesController {
  constructor(
    private readonly addresses: AdminReceiptsAddressesService,
    private readonly callers: CallerService
  ) {}

  @Get()
  async list(@UserId() userId: string): Promise<AdminReceiptsAddressesDto> {
    return this.addresses.list(await this.callers.loadAdmin(userId))
  }

  @Post(':id/release')
  async release(
    @UserId() userId: string,
    @Param('id') id: string,
    @Body() body: Partial<ReleaseReceiptsAddressBody> | undefined
  ): Promise<AdminReceiptsAddressesDto> {
    return this.addresses.release(
      await this.callers.loadAdmin(userId),
      id,
      body?.receivedSinceRemoval
    )
  }
}
