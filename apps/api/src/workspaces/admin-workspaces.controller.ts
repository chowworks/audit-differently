import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common'
import type { AdminWorkspaceDetail, AdminWorkspaceDto } from '@ad/types'
import { AdminGuard } from '../auth/admin.guard'
import { AuthenticatedGuard } from '../auth/authenticated.guard'
import { CallerService, UserId } from '../core/caller'
import { parseListsBody, parseMemberBody, parseRenameBody, parseRoleBody } from './workspace-body'
import { WorkspacesService } from './workspaces.service'

/**
 * The platform admin's view of every workspace (Admin tools): its people and its lists, nothing below the workspace.
 * There is deliberately no route here for engagements, the access log or deleting. Creating a workspace is
 * POST /workspaces, under the same guard.
 */
@Controller('admin/workspaces')
@UseGuards(AuthenticatedGuard, AdminGuard)
export class AdminWorkspacesController {
  constructor(
    private readonly workspaces: WorkspacesService,
    private readonly callers: CallerService
  ) {}

  @Get()
  async list(@UserId() userId: string): Promise<AdminWorkspaceDto[]> {
    return this.workspaces.adminList(await this.callers.loadAdmin(userId))
  }

  @Get(':id')
  async get(@UserId() userId: string, @Param('id') id: string): Promise<AdminWorkspaceDetail> {
    return this.workspaces.adminGet(await this.callers.loadAdmin(userId), id)
  }

  @Patch(':id')
  async rename(
    @UserId() userId: string,
    @Param('id') id: string,
    @Body() body: unknown
  ): Promise<AdminWorkspaceDetail> {
    const name = parseRenameBody(body)
    const admin = await this.callers.loadAdmin(userId)
    await this.workspaces.rename(admin, id, name)
    return this.workspaces.adminGet(admin, id)
  }

  @Patch(':id/lists')
  async setLists(
    @UserId() userId: string,
    @Param('id') id: string,
    @Body() given: unknown
  ): Promise<AdminWorkspaceDetail> {
    const body = parseListsBody(given)
    const admin = await this.callers.loadAdmin(userId)
    // The receipts address is the owners' alone (WorkspacesService.setReceiptsAddress): refused before any list saves.
    if (body.receiptsAddress !== undefined)
      throw new ForbiddenException("Only the workspace's owners set its receipts address")
    // So is reading emailed receipts with AI: the yes for the workspace's own records is its owners' to give.
    if (body.readEmailedReceiptsWithAi !== undefined)
      throw new ForbiddenException(
        "Only the workspace's owners turn on reading emailed receipts with AI"
      )
    // Each card saves its own list: the budget items or the tags.
    if (body.tagTypes !== undefined) await this.workspaces.setTagTypes(admin, id, body.tagTypes)
    return this.workspaces.adminGet(admin, id)
  }

  @Post(':id/members')
  async addMember(
    @UserId() userId: string,
    @Param('id') id: string,
    @Body() body: unknown
  ): Promise<AdminWorkspaceDetail> {
    const input = parseMemberBody(body)
    const admin = await this.callers.loadAdmin(userId)
    await this.workspaces.addMember(admin, id, input)
    return this.workspaces.adminGet(admin, id)
  }

  @Patch(':id/members/:userId')
  async setRole(
    @UserId() userId: string,
    @Param('id') id: string,
    @Param('userId') member: string,
    @Body() body: unknown
  ): Promise<AdminWorkspaceDetail> {
    const role = parseRoleBody(body)
    const admin = await this.callers.loadAdmin(userId)
    await this.workspaces.setRole(admin, id, member, role)
    return this.workspaces.adminGet(admin, id)
  }

  @Delete(':id/members/:userId')
  async removeMember(
    @UserId() userId: string,
    @Param('id') id: string,
    @Param('userId') member: string
  ): Promise<AdminWorkspaceDetail> {
    const admin = await this.callers.loadAdmin(userId)
    await this.workspaces.removeMember(admin, id, member)
    return this.workspaces.adminGet(admin, id)
  }
}
