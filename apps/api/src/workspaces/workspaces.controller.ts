import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common'
import type {
  ActivityEntry,
  AdminWorkspaceDetail,
  CreateWorkspaceRequest,
  Role,
  WorkspaceDetail,
  WorkspaceDto,
} from '@ad/types'
import { AdminGuard } from '../auth/admin.guard'
import { AuthenticatedGuard } from '../auth/authenticated.guard'
import { CallerService, UserId } from '../core/caller'
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
  async create(
    @UserId() userId: string,
    @Body() body: CreateWorkspaceRequest
  ): Promise<AdminWorkspaceDetail> {
    return this.workspaces.create(await this.callers.loadAdmin(userId), body)
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
    @Body() body: { name?: unknown }
  ): Promise<WorkspaceDetail> {
    const caller = await this.callers.load(userId)
    await this.workspaces.rename(caller, id, body?.name)
    return this.workspaces.get(caller, id)
  }

  @Patch(':id/lists')
  async setLists(
    @UserId() userId: string,
    @Param('id') id: string,
    @Body()
    body: {
      budgetItems?: unknown
      tagTypes?: unknown
      receiptsAddress?: unknown
      readEmailedReceiptsWithAi?: unknown
    }
  ): Promise<WorkspaceDetail> {
    const caller = await this.callers.load(userId)
    // Each card saves its own list: the budget items, the tags, or the receipts address (and its AI setting).
    if (body.readEmailedReceiptsWithAi !== undefined)
      await this.workspaces.setReadEmailedReceiptsWithAi(caller, id, body.readEmailedReceiptsWithAi)
    if (body.budgetItems !== undefined)
      await this.workspaces.setBudgetItems(caller, id, body.budgetItems)
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
    @Body() body: { text: string }
  ): Promise<WorkspaceDetail> {
    return this.workspaces.suggest(await this.callers.load(userId), id, body.text)
  }

  @Post(':id/members')
  async addMember(
    @UserId() userId: string,
    @Param('id') id: string,
    @Body() body: { email: string; displayName?: string; role: Role }
  ): Promise<WorkspaceDetail> {
    const caller = await this.callers.load(userId)
    await this.workspaces.addMember(caller, id, body)
    return this.workspaces.get(caller, id)
  }

  @Patch(':id/members/:userId')
  async setRole(
    @UserId() userId: string,
    @Param('id') id: string,
    @Param('userId') member: string,
    @Body() body: { role: Role }
  ): Promise<WorkspaceDetail> {
    const caller = await this.callers.load(userId)
    await this.workspaces.setRole(caller, id, member, body.role)
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
