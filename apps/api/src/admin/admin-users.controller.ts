import { Body, Controller, Get, Param, Put, Query, UseGuards } from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import type { AdminListDto, AdminUserDto, PlatformRoleChangeDto } from '@ad/types'
import { AdminGuard } from '../auth/admin.guard'
import { AuthenticatedGuard } from '../auth/authenticated.guard'
import { UserId } from '../core/caller'
import { AdminUsersService } from './admin-users.service'

/** Admin tools: the platform admins. Who works in a workspace is its people (admin-workspaces.controller.ts). */
@Controller('admin')
@UseGuards(AuthenticatedGuard, AdminGuard)
export class AdminUsersController {
  constructor(private readonly users: AdminUsersService) {}

  /** One Clerk list call per search. */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get('users')
  search(@Query('q') q?: string): Promise<AdminUserDto[]> {
    return this.users.search(q)
  }

  /** Reads every account a page at a time (up to 20 Clerk calls); the service keeps it for 30 seconds. */
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('admins')
  admins(): Promise<AdminListDto> {
    return this.users.admins()
  }

  @Get('role-changes')
  changes(): Promise<PlatformRoleChangeDto[]> {
    return this.users.changes()
  }

  @Put('users/:id/role')
  setRole(
    @UserId() userId: string,
    @Param('id') id: string,
    @Body() body: { role?: unknown }
  ): Promise<AdminUserDto> {
    return this.users.setRole(userId, id, body?.role ?? null)
  }
}
