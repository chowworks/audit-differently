import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common'
import type { ActivityEntry, Role, WorkspaceDetail, WorkspaceDto } from '@ad/types'
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

  @Post()
  async create(
    @UserId() userId: string,
    @Body() body: { name: string; acceptedTermsVersion?: string }
  ): Promise<WorkspaceDetail> {
    return this.workspaces.create(
      await this.callers.load(userId),
      body.name,
      body.acceptedTermsVersion
    )
  }

  @Get(':id')
  async get(@UserId() userId: string, @Param('id') id: string): Promise<WorkspaceDetail> {
    return this.workspaces.get(await this.callers.load(userId), id)
  }

  @Patch(':id/lists')
  async setLists(
    @UserId() userId: string,
    @Param('id') id: string,
    @Body() body: { fundingSources: string[] }
  ): Promise<WorkspaceDetail> {
    return this.workspaces.setLists(await this.callers.load(userId), id, body.fundingSources)
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
    return this.workspaces.addMember(await this.callers.load(userId), id, body)
  }

  @Patch(':id/members/:userId')
  async setRole(
    @UserId() userId: string,
    @Param('id') id: string,
    @Param('userId') member: string,
    @Body() body: { role: Role }
  ): Promise<WorkspaceDetail> {
    return this.workspaces.setRole(await this.callers.load(userId), id, member, body.role)
  }

  @Delete(':id/members/:userId')
  async removeMember(
    @UserId() userId: string,
    @Param('id') id: string,
    @Param('userId') member: string
  ): Promise<WorkspaceDetail> {
    return this.workspaces.removeMember(await this.callers.load(userId), id, member)
  }
}
