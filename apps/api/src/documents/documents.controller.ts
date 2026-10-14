import { Throttle } from '@nestjs/throttler'
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import type { Response } from 'express'
import type { DocumentDto } from '@ad/types'
import { AuthenticatedGuard } from '../auth/authenticated.guard'
import { CallerService, UserId } from '../core/caller'
import { runAsSystem } from '../core/tenant-context'
import { PrismaService } from '../prisma/prisma.service'
import { LocalDiskStorage } from '../storage/local-disk-storage'
import type { UploadResult } from './document.dto'
import { DocumentsService, MAX_UPLOAD_BYTES, type UploadBody } from './documents.service'

@Controller('documents')
export class DocumentsController {
  constructor(
    private readonly documents: DocumentsService,
    private readonly callers: CallerService,
    private readonly prisma: PrismaService,
    private readonly local: LocalDiskStorage
  ) {}

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post()
  @UseGuards(AuthenticatedGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } }))
  async upload(
    @UserId() userId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: UploadBody
  ): Promise<UploadResult> {
    if (!file) throw new NotFoundException('No file in the upload')
    return this.documents.upload(await this.callers.load(userId), file, body)
  }

  /**
   * The workspace's documents, newest first, for attaching. `for` and `id` (`?for=expense&id=…`) say which record
   * the proof is for; they word the access log line and never decide whether it is written.
   */
  @Get('/of-workspace/:workspaceId')
  @UseGuards(AuthenticatedGuard)
  async ofWorkspace(
    @UserId() userId: string,
    @Param('workspaceId') workspaceId: string,
    @Query('for') purposeFor?: string,
    @Query('id') id?: string
  ): Promise<DocumentDto[]> {
    return this.documents.list(await this.callers.load(userId), workspaceId, {
      for: purposeFor,
      id,
    })
  }

  @Delete(':id')
  @HttpCode(204)
  @UseGuards(AuthenticatedGuard)
  async remove(@UserId() userId: string, @Param('id') id: string): Promise<void> {
    await this.documents.remove(await this.callers.load(userId), id)
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get(':id/url')
  @UseGuards(AuthenticatedGuard)
  async url(
    @UserId() userId: string,
    @Param('id') id: string
  ): Promise<{ url: string; expiresInSeconds: number }> {
    return this.documents.url(await this.callers.load(userId), id)
  }

  /** Local development only: the file behind a token that /documents/:id/url issued (and logged). */
  @Get('local/:token')
  async serveLocal(@Param('token') token: string, @Res() res: Response): Promise<void> {
    if (process.env.R2_DOCUMENTS_BUCKET) throw new NotFoundException()
    const t = this.local.verify(token)
    if (!t) throw new NotFoundException('This link has expired')
    const doc = await runAsSystem(() =>
      this.prisma.document.findUnique({ where: { storageKey: t.key } })
    )
    if (!doc) throw new NotFoundException()
    const bytes = await this.local.read(t.key)
    const name = (t.downloadName ?? doc.fileName).replace(/"/g, '')
    res.setHeader('Content-Type', doc.contentType)
    res.setHeader(
      'Content-Disposition',
      `${t.downloadName ? 'attachment' : 'inline'}; filename="${name}"`
    )
    res.setHeader('Cache-Control', 'no-store')
    res.send(bytes)
  }
}
