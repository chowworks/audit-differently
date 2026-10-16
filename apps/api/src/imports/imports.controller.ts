import { Throttle } from '@nestjs/throttler'
import {
  BadRequestException,
  Body,
  Controller,
  Param,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import type {
  ImportFileDto,
  ImportPreviewDto,
  ImportResultDto,
  ImportSuggestionDto,
} from '@ad/types'
import { AuthenticatedGuard } from '../auth/authenticated.guard'
import { CallerService, UserId } from '../core/caller'
import { ImportsService, type ImportFile } from './imports.service'
import { MAX_IMPORT_BYTES } from './table'

/** The file and the mapping, as each step sends them: the file again every time, since it is never stored. */
const upload = FileInterceptor('file', { limits: { fileSize: MAX_IMPORT_BYTES, files: 1 } })

function fileOf(file: Express.Multer.File | undefined): ImportFile {
  if (!file) throw new BadRequestException('Choose a file to import')
  return file
}

function mappingOf(body: { mapping?: unknown }): unknown {
  if (typeof body?.mapping !== 'string') throw new BadRequestException('The mapping is missing')
  try {
    return JSON.parse(body.mapping)
  } catch {
    throw new BadRequestException('The mapping is not valid JSON')
  }
}

/** Import transactions into an engagement's ledger from a file the team exports (CSV or Excel). */
@Controller('engagements/:id/imports')
@UseGuards(AuthenticatedGuard)
@Throttle({ default: { limit: 30, ttl: 60_000 } })
export class ImportsController {
  constructor(
    private readonly imports: ImportsService,
    private readonly callers: CallerService
  ) {}

  @Post('read')
  @UseInterceptors(upload)
  async read(
    @UserId() userId: string,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File | undefined
  ): Promise<ImportFileDto> {
    return this.imports.read(await this.callers.load(userId), id, fileOf(file))
  }

  /** "Suggest the mapping with AI": only when the person presses it; the column names alone go to the model. */
  @Post('suggest')
  @UseInterceptors(upload)
  async suggest(
    @UserId() userId: string,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File | undefined
  ): Promise<ImportSuggestionDto> {
    return this.imports.suggest(await this.callers.load(userId), id, fileOf(file))
  }

  @Post('preview')
  @UseInterceptors(upload)
  async preview(
    @UserId() userId: string,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: { mapping?: unknown }
  ): Promise<ImportPreviewDto> {
    return this.imports.preview(await this.callers.load(userId), id, fileOf(file), mappingOf(body))
  }

  @Post()
  @UseInterceptors(upload)
  async import(
    @UserId() userId: string,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: { mapping?: unknown }
  ): Promise<ImportResultDto> {
    return this.imports.import(await this.callers.load(userId), id, fileOf(file), mappingOf(body))
  }
}
