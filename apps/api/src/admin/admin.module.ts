import { Module } from '@nestjs/common'
import { PayrollModule } from '../payroll/payroll.module'
import { AdminHighlightsController } from './admin-highlights.controller'
import { AdminInboundController } from './admin-inbound.controller'
import { AdminInboundService } from './admin-inbound.service'
import { AdminMatchStatsController } from './admin-match-stats.controller'
import { AdminMatchStatsService } from './admin-match-stats.service'
import { AdminReceiptsAddressesController } from './admin-receipts-addresses.controller'
import { AdminReceiptsAddressesService } from './admin-receipts-addresses.service'
import { AdminUsersController } from './admin-users.controller'
import { AdminUsersService } from './admin-users.service'

@Module({
  imports: [PayrollModule],
  controllers: [
    AdminUsersController,
    AdminInboundController,
    AdminHighlightsController,
    AdminMatchStatsController,
    AdminReceiptsAddressesController,
  ],
  providers: [
    AdminUsersService,
    AdminInboundService,
    AdminMatchStatsService,
    AdminReceiptsAddressesService,
  ],
})
export class AdminModule {}
