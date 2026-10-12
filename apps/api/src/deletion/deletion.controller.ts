import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import type { Response } from 'express'
import type { DeletionExportDto, DeletionSummaryDto } from '@ad/types'
import { AuthenticatedGuard } from '../auth/authenticated.guard'
import { CallerService, UserId } from '../core/caller'
import { DeletionService, type ConfirmBody, type PartFile } from './deletion.service'

/**
 * Headers of one part: the file, its exact size and sha256 (the browser checks what it received against both),
 * never cached.
 */
function start(res: Response, part: PartFile): Promise<void> {
  res.setHeader('Content-Type', 'application/zip')
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${part.fileName.replace(/["\r\n]/g, '')}"`
  )
  res.setHeader('Content-Length', String(part.bytes))
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Export-Bytes', String(part.bytes))
  res.setHeader('X-Export-Sha256', part.sha256)
  return part.send(res)
}

/** Deleting an engagement: the owner's full export first, then the delete. Owners only (403 for anyone else). */
@Controller('engagements')
@UseGuards(AuthenticatedGuard)
export class EngagementDeletionController {
  constructor(
    private readonly deletion: DeletionService,
    private readonly callers: CallerService
  ) {}

  @Get(':id/deletion-summary')
  async summary(@UserId() userId: string, @Param('id') id: string): Promise<DeletionSummaryDto> {
    return this.deletion.engagementSummary(await this.callers.load(userId), id)
  }

  /** Starts the export: the record and the list of parts. Nothing is sent yet. */
  @Post(':id/deletion')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async export(@UserId() userId: string, @Param('id') id: string): Promise<DeletionExportDto> {
    return this.deletion.exportEngagement(await this.callers.load(userId), id)
  }

  /** One part of the export as a download; the record is done when every part has finished. */
  @Get(':id/deletion/:deletionId/parts/:n')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async part(
    @UserId() userId: string,
    @Param('id') id: string,
    @Param('deletionId') deletionId: string,
    @Param('n') n: string,
    @Res() res: Response
  ): Promise<void> {
    await start(
      res,
      await this.deletion.downloadEngagementPart(
        await this.callers.load(userId),
        id,
        deletionId,
        Number(n)
      )
    )
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @UserId() userId: string,
    @Param('id') id: string,
    @Body() body: ConfirmBody
  ): Promise<void> {
    await this.deletion.deleteEngagement(await this.callers.load(userId), id, body)
  }
}

/** Deleting a workspace: only once no engagement remains; its own documents are exported first. */
@Controller('workspaces')
@UseGuards(AuthenticatedGuard)
export class WorkspaceDeletionController {
  constructor(
    private readonly deletion: DeletionService,
    private readonly callers: CallerService
  ) {}

  @Get(':id/deletion-summary')
  async summary(@UserId() userId: string, @Param('id') id: string): Promise<DeletionSummaryDto> {
    return this.deletion.workspaceSummary(await this.callers.load(userId), id)
  }

  /** Starts the export: the record and the list of parts. Nothing is sent yet. */
  @Post(':id/deletion')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async export(@UserId() userId: string, @Param('id') id: string): Promise<DeletionExportDto> {
    return this.deletion.exportWorkspace(await this.callers.load(userId), id)
  }

  /** One part of the export as a download; the record is done when every part has finished. */
  @Get(':id/deletion/:deletionId/parts/:n')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async part(
    @UserId() userId: string,
    @Param('id') id: string,
    @Param('deletionId') deletionId: string,
    @Param('n') n: string,
    @Res() res: Response
  ): Promise<void> {
    await start(
      res,
      await this.deletion.downloadWorkspacePart(
        await this.callers.load(userId),
        id,
        deletionId,
        Number(n)
      )
    )
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @UserId() userId: string,
    @Param('id') id: string,
    @Body() body: ConfirmBody
  ): Promise<void> {
    await this.deletion.deleteWorkspace(await this.callers.load(userId), id, body)
  }
}
