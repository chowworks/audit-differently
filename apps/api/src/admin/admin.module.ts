import { Module } from '@nestjs/common'
import { AdminInboundController } from './admin-inbound.controller'
import { AdminInboundService } from './admin-inbound.service'
import { AdminUsersController } from './admin-users.controller'
import { AdminUsersService } from './admin-users.service'

@Module({
  controllers: [AdminUsersController, AdminInboundController],
  providers: [AdminUsersService, AdminInboundService],
})
export class AdminModule {}
