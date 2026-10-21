import { Body, Controller, Delete, Get, Param, Patch, Post, Put, UseGuards } from '@nestjs/common'
import type { StaffAddInput, StaffInput, StaffListDto } from '@ad/types'
import { AuthenticatedGuard } from '../auth/authenticated.guard'
import { CallerService, UserId } from '../core/caller'
import { StaffService } from './staff.service'

/** The staff list and the engagements each person works on: owners change it, owners and auditors read it. */
@Controller()
@UseGuards(AuthenticatedGuard)
export class StaffController {
  constructor(
    private readonly staff: StaffService,
    private readonly callers: CallerService
  ) {}

  @Get('workspaces/:id/staff')
  async list(@UserId() userId: string, @Param('id') id: string): Promise<StaffListDto> {
    return this.staff.list(await this.callers.load(userId), id)
  }

  /** The paste import: every row at once. */
  @Post('workspaces/:id/staff')
  async add(
    @UserId() userId: string,
    @Param('id') id: string,
    @Body() body: StaffAddInput
  ): Promise<StaffListDto> {
    return this.staff.add(await this.callers.load(userId), id, body)
  }

  @Patch('staff/:staffId')
  async update(
    @UserId() userId: string,
    @Param('staffId') staffId: string,
    @Body() body: StaffInput
  ): Promise<StaffListDto> {
    return this.staff.update(await this.callers.load(userId), staffId, body)
  }

  @Delete('staff/:staffId')
  async remove(@UserId() userId: string, @Param('staffId') staffId: string): Promise<StaffListDto> {
    return this.staff.remove(await this.callers.load(userId), staffId)
  }

  @Put('staff/:staffId/engagements/:engagementId')
  async assign(
    @UserId() userId: string,
    @Param('staffId') staffId: string,
    @Param('engagementId') engagementId: string
  ): Promise<StaffListDto> {
    return this.staff.assign(await this.callers.load(userId), staffId, engagementId)
  }

  @Delete('staff/:staffId/engagements/:engagementId')
  async unassign(
    @UserId() userId: string,
    @Param('staffId') staffId: string,
    @Param('engagementId') engagementId: string
  ): Promise<StaffListDto> {
    return this.staff.unassign(await this.callers.load(userId), staffId, engagementId)
  }
}
