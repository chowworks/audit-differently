import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common'
import type { ActivityEntry, AdminWorkspaceDetail, WorkspaceDetail, WorkspaceDto } from '@ad/types'
import { AdminGuard } from '../auth/admin.guard'
import { AuthenticatedGuard } from '../auth/authenticated.guard'
import { CallerService, UserId } from '../core/caller'
import {
  parseCreateWorkspaceBody,
  parseListsBody,
  parseMemberBody,
  parseRenameBody,
  parseRoleBody,
  parseSuggestionBody,
} from './workspace-body'
import { WorkspacesService } from './workspaces.service'

@Controller('workspaces')
@UseGuards(AuthenticatedGuard)
export class WorkspacesController {
  constructor(
    private readonly workspaces: WorkspacesService,
    private readonly callers: CallerService
  ) {}

  @Get()
  async list(@UserId() userId: string): Promise<WorkspaceDto[]> {
    return this.workspaces.list(await this.callers.load(userId))
  }

  /** Platform admins only (Admin tools): a workspace for a customer, with its first owner invited by email. */
  @Post()
  @UseGuards(AdminGuard)
  async create(@UserId() userId: string, @Body() body: unknown): Promise<AdminWorkspaceDetail> {
    const input = parseCreateWorkspaceBody(body)
    return this.workspaces.create(await this.callers.loadAdmin(userId), input)
  }

  @Get(':id')
  async get(@UserId() userId: string, @Param('id') id: string): Promise<WorkspaceDetail> {
    return this.workspaces.get(await this.callers.load(userId), id)
  }

  /** An owner renames their workspace. */
  @Patch(':id')
  async rename(
    @UserId() userId: string,
    @Param('id') id: string,
    @Body() body: unknown
  ): Promise<WorkspaceDetail> {
    const name = parseRenameBody(body)
    const caller = await this.callers.load(userId)
    await this.workspaces.rename(caller, id, name)
    return this.workspaces.get(caller, id)
  }

  @Patch(':id/lists')
  async setLists(
    @UserId() userId: string,
    @Param('id') id: string,
    @Body() given: unknown
  ): Promise<WorkspaceDetail> {
    const body = parseListsBody(given)
    const caller = await this.callers.load(userId)
    // Each card saves its own list: the budget items, the tags, or the receipts address (and its AI setting).
    if (body.readEmailedReceiptsWithAi !== undefined)
      await this.workspaces.setReadEmailedReceiptsWithAi(caller, id, body.readEmailedReceiptsWithAi)
    if (body.tagTypes !== undefined) await this.workspaces.setTagTypes(caller, id, body.tagTypes)
    if (body.receiptsAddress !== undefined)
      await this.workspaces.setReceiptsAddress(caller, id, body.receiptsAddress)
    return this.workspaces.get(caller, id)
  }

  @Get(':id/activity')
  async activity(@UserId() userId: string, @Param('id') id: string): Promise<ActivityEntry[]> {
    return this.workspaces.activity(await this.callers.load(userId), id)
  }

  @Post(':id/suggestions')
  async suggest(
    @UserId() userId: string,
    @Param('id') id: string,
    @Body() body: unknown
  ): Promise<WorkspaceDetail> {
    const text = parseSuggestionBody(body)
    return this.workspaces.suggest(await this.callers.load(userId), id, text)
  }

  @Post(':id/members')
  async addMember(
    @UserId() userId: string,
    @Param('id') id: string,
    @Body() body: unknown
  ): Promise<WorkspaceDetail> {
    const input = parseMemberBody(body)
    const caller = await this.callers.load(userId)
    await this.workspaces.addMember(caller, id, input)
    return this.workspaces.get(caller, id)
  }

  @Patch(':id/members/:userId')
  async setRole(
    @UserId() userId: string,
    @Param('id') id: string,
    @Param('userId') member: string,
    @Body() body: unknown
  ): Promise<WorkspaceDetail> {
    const role = parseRoleBody(body)
    const caller = await this.callers.load(userId)
    await this.workspaces.setRole(caller, id, member, role)
    return this.workspaces.get(caller, id)
  }

  @Delete(':id/members/:userId')
  async removeMember(
    @UserId() userId: string,
    @Param('id') id: string,
    @Param('userId') member: string
  ): Promise<WorkspaceDetail> {
    const caller = await this.callers.load(userId)
    await this.workspaces.removeMember(caller, id, member)
    return this.workspaces.get(caller, id)
  }
}
