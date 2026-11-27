import { Throttle } from '@nestjs/throttler'
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import type { LineAliasesDto, LineAliasesMergeDto } from '@ad/types'
import { AuthenticatedGuard } from '../auth/authenticated.guard'
import { CallerService, UserId } from '../core/caller'
import { AliasesService } from './aliases.service'

/** The QuickBooks names list (#132): owners and bookkeepers keep it on the workspace page. */
@Controller('workspaces/:id/line-aliases')
@UseGuards(AuthenticatedGuard)
export class AliasesController {
  constructor(
    private readonly aliases: AliasesService,
    private readonly callers: CallerService
  ) {}

  @Get()
  async list(@UserId() userId: string, @Param('id') id: string): Promise<LineAliasesDto> {
    return this.aliases.list(await this.callers.load(userId), id)
  }

  @Post()
  async create(
    @UserId() userId: string,
    @Param('id') id: string,
    @Body() body: unknown
  ): Promise<LineAliasesDto> {
    return this.aliases.create(await this.callers.load(userId), id, body)
  }

  /** A row of the list saved as a whole: its entries for the engagements ticked, or for every engagement. */
  @Post('group')
  async saveGroup(
    @UserId() userId: string,
    @Param('id') id: string,
    @Body() body: unknown
  ): Promise<LineAliasesDto> {
    return this.aliases.saveGroup(await this.callers.load(userId), id, body)
  }

  /** A choice on Month End Close's expenses: kept as the workspace's entry or that engagement's override. */
  @Post('choose')
  async choose(
    @UserId() userId: string,
    @Param('id') id: string,
    @Body() body: unknown
  ): Promise<LineAliasesDto> {
    return this.aliases.choose(await this.callers.load(userId), id, body)
  }

  /** A file of the payroll zip's "Account mapping" folder, merged into the list. The file is not kept. */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('file')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024, files: 1 } }))
  async merge(
    @UserId() userId: string,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File | undefined
  ): Promise<LineAliasesMergeDto> {
    return this.aliases.merge(await this.callers.load(userId), id, file)
  }

  @Patch(':aliasId')
  async update(
    @UserId() userId: string,
    @Param('id') id: string,
    @Param('aliasId') aliasId: string,
    @Body() body: unknown
  ): Promise<LineAliasesDto> {
    return this.aliases.update(await this.callers.load(userId), id, aliasId, body)
  }

  @Delete(':aliasId')
  async remove(
    @UserId() userId: string,
    @Param('id') id: string,
    @Param('aliasId') aliasId: string
  ): Promise<LineAliasesDto> {
    return this.aliases.remove(await this.callers.load(userId), id, aliasId)
  }
}
