import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Post,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import { Throttle } from '@nestjs/throttler'
import type { Response } from 'express'
import type { BudgetFileDto, BudgetFileVersionDto, BudgetUploadChange } from '@ad/types'
import { AuthenticatedGuard } from '../auth/authenticated.guard'
import { CallerService, UserId } from '../core/caller'
import { MAX_IMPORT_BYTES } from '../imports/table'
import { BudgetService } from './budget.service'

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
/** A budget file is read in memory: one file, as small as an import's. */
const upload = FileInterceptor('file', { limits: { fileSize: MAX_IMPORT_BYTES, files: 1 } })

function fileOf(file: Express.Multer.File | undefined): Express.Multer.File {
  if (!file) throw new BadRequestException('Choose a budget file to upload')
  return file
}

/** Sends a file as a download, under a name the header can carry. */
function send(res: Response, name: string, contentType: string, bytes: Buffer) {
  res.setHeader('Content-Type', contentType)
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, '')}"`
  )
  res.setHeader('Cache-Control', 'no-store')
  res.send(bytes)
}

/**
 * The approved budget's lines (step 4), set from an Excel file only (GitHub issue #98): the template, reading an
 * uploaded file, saving it, and the budget history. Owners and bookkeepers only. A save answers with the engagement as
 * its page shows it, and the closed or submitted months it put back to draft.
 */
@Controller('engagements/:id/budget-lines')
@UseGuards(AuthenticatedGuard)
export class BudgetController {
  constructor(
    private readonly budget: BudgetService,
    private readonly callers: CallerService
  ) {}

  /** The template, with the current lines. */
  @Get('file')
  async template(
    @UserId() userId: string,
    @Param('id') id: string,
    @Res() res: Response
  ): Promise<void> {
    const file = await this.budget.template(await this.callers.load(userId), id)
    send(res, file.name, XLSX, file.bytes)
  }

  /** An uploaded budget file, read in memory and checked: what Save would do, and every problem. Saves nothing. */
  @Post('file')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @UseInterceptors(upload)
  async readFile(
    @UserId() userId: string,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File | undefined
  ): Promise<BudgetFileDto> {
    return this.budget.readFile(await this.callers.load(userId), id, fileOf(file))
  }

  /** Saves an uploaded budget file: it replaces the whole budget, all or nothing, and is kept as the history. */
  @Post('upload')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @UseInterceptors(upload)
  async upload(
    @UserId() userId: string,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File | undefined
  ): Promise<BudgetUploadChange> {
    return this.budget.upload(await this.callers.load(userId), id, fileOf(file))
  }

  /** The budget history: every budget file saved, newest first. */
  @Get('files')
  async history(
    @UserId() userId: string,
    @Param('id') id: string
  ): Promise<BudgetFileVersionDto[]> {
    return this.budget.history(await this.callers.load(userId), id)
  }

  /** An earlier budget file, as it was uploaded. Logged. */
  @Get('files/:fileId')
  async historyFile(
    @UserId() userId: string,
    @Param('id') id: string,
    @Param('fileId') fileId: string,
    @Res() res: Response
  ): Promise<void> {
    const file = await this.budget.historyFile(await this.callers.load(userId), id, fileId)
    send(res, file.name, file.contentType, file.bytes)
  }
}
