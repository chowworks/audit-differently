import { Throttle } from '@nestjs/throttler'
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common'
import { FilesInterceptor } from '@nestjs/platform-express'
import type { Response } from 'express'
import type {
  PayLineLinkInput,
  PayrollMatchProgress,
  PayrollReconciliationDto,
  StaffListDto,
  StaffSuggestionDto,
  WorkspacePayrollFilesDto,
  WorkspacePayrollOutputDto,
  WorkspacePayrollPeriodDto,
  WorkspacePayrollRunDto,
  WorkspacePayrollSaveInput,
  WorkspacePayrollStartInput,
} from '@ad/types'
import { AuthenticatedGuard } from '../auth/authenticated.guard'
import { EngagementsService } from '../engagements/engagements.service'
import { StaffService } from '../staff/staff.service'
import { CallerService, UserId } from '../core/caller'
import { MAX_UPLOAD_BYTES } from '../documents/documents.service'
import { sendInline } from './payroll-match.controller'
import { MAX_PAYROLL_FILES } from './payroll.service'
import { WorkspacePayrollService } from './workspace-payroll.service'

/**
 * "Match payroll & timecards" for the whole workspace and a month, and its reconciliation. Each month has one set of
 * payroll files; an owner changes it (replace all, add files, remove a file, match again) by a run that is checked and
 * then saved. Owners run it and change the reconciliation; owners and auditors read them.
 */
@Controller()
@UseGuards(AuthenticatedGuard)
export class WorkspacePayrollController {
  constructor(
    private readonly payroll: WorkspacePayrollService,
    private readonly callers: CallerService,
    private readonly staff: StaffService,
    private readonly engagementsService: EngagementsService
  ) {}

  @Get('workspaces/:id/payroll')
  async periods(
    @UserId() userId: string,
    @Param('id') id: string
  ): Promise<WorkspacePayrollPeriodDto[]> {
    return this.payroll.periods(await this.callers.load(userId), id)
  }

  /** "Bookkeepers see staff payroll", the owners' setting. */
  @Patch('workspaces/:id/payroll')
  async setting(
    @UserId() userId: string,
    @Param('id') id: string,
    @Body() body: { bookkeepersSeeStaffPayroll?: unknown }
  ): Promise<{ bookkeepersSeeStaffPayroll: boolean }> {
    return this.payroll.setBookkeepersSeeStaffPayroll(
      await this.callers.load(userId),
      id,
      body?.bookkeepersSeeStaffPayroll
    )
  }

  @Get('workspaces/:id/payroll/:period/reconciliation')
  async reconciliation(
    @UserId() userId: string,
    @Param('id') id: string,
    @Param('period') period: string
  ): Promise<PayrollReconciliationDto> {
    return this.payroll.reconciliation(await this.callers.load(userId), id, period)
  }

  /** The engagement cards: each engagement's staff payroll charge against the pay in the saved files. */
  @Get('workspaces/:id/payroll/:period/engagements')
  async engagements(
    @UserId() userId: string,
    @Param('id') id: string,
    @Param('period') period: string
  ): Promise<WorkspacePayrollOutputDto> {
    return this.payroll.engagements(await this.callers.load(userId), id, period)
  }

  /** People the month's registers name who are not on the staff list; `runId` reads an open match's files instead. */
  @Get('workspaces/:id/payroll/:period/staff-suggestions')
  async staffSuggestions(
    @UserId() userId: string,
    @Param('id') id: string,
    @Param('period') period: string,
    @Query('runId') runId?: string
  ): Promise<StaffSuggestionDto[]> {
    return this.payroll.staffSuggestions(await this.callers.load(userId), id, period, runId)
  }

  /** The month's set of payroll files. */
  @Get('workspaces/:id/payroll/:period/files')
  async files(
    @UserId() userId: string,
    @Param('id') id: string,
    @Param('period') period: string
  ): Promise<WorkspacePayrollFilesDto> {
    return this.payroll.files(await this.callers.load(userId), id, period)
  }

  /** Remove a file: a run that takes it out of the month's set, matched again from the rest, to check and save. */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('workspaces/:id/payroll/:period/files/:documentId/remove')
  async removeFile(
    @UserId() userId: string,
    @Param('id') id: string,
    @Param('period') period: string,
    @Param('documentId') documentId: string
  ): Promise<WorkspacePayrollRunDto> {
    return this.payroll.removeFile(await this.callers.load(userId), id, period, documentId)
  }

  /** Match again: the month's set as it is (a participant added, a person's engagements changed), to check and save. */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('workspaces/:id/payroll/:period/match-again')
  async matchAgain(
    @UserId() userId: string,
    @Param('id') id: string,
    @Param('period') period: string
  ): Promise<WorkspacePayrollRunDto> {
    return this.payroll.matchAgain(await this.callers.load(userId), id, period)
  }

  /** Replace all (`{ mode: 'replace', expected }`) or Add files (`{ mode: 'add' }`, the default): a run to upload into. */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('workspaces/:id/payroll/:period/match')
  async start(
    @UserId() userId: string,
    @Param('id') id: string,
    @Param('period') period: string,
    @Body() body: WorkspacePayrollStartInput
  ): Promise<WorkspacePayrollRunDto> {
    return this.payroll.start(await this.callers.load(userId), id, period, body ?? {})
  }

  /** The caller's unsaved run of the month, if any: the page picks it up where it was. */
  @Get('workspaces/:id/payroll/:period/match')
  async latest(
    @UserId() userId: string,
    @Param('id') id: string,
    @Param('period') period: string
  ): Promise<WorkspacePayrollRunDto | null> {
    return this.payroll.latest(await this.callers.load(userId), id, period)
  }

  @Post('workspaces/:id/payroll/lines/:lineId/link')
  async link(
    @UserId() userId: string,
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body() body: PayLineLinkInput
  ): Promise<PayrollReconciliationDto> {
    return this.payroll.linkLine(await this.callers.load(userId), id, lineId, body)
  }

  @Post('workspaces/:id/payroll/lines/:lineId/not-funded')
  async notFunded(
    @UserId() userId: string,
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body() body: { reason?: unknown }
  ): Promise<PayrollReconciliationDto> {
    return this.payroll.markNotFunded(await this.callers.load(userId), id, lineId, body?.reason)
  }

  @Delete('workspaces/:id/payroll/lines/:lineId/not-funded')
  async clearNotFunded(
    @UserId() userId: string,
    @Param('id') id: string,
    @Param('lineId') lineId: string
  ): Promise<PayrollReconciliationDto> {
    return this.payroll.clearNotFunded(await this.callers.load(userId), id, lineId)
  }

  // A month's 1,000 files go up in 50 batches of 20.
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post('workspace-payroll-match/:runId/files')
  @UseInterceptors(
    FilesInterceptor('files', MAX_PAYROLL_FILES, {
      limits: { fileSize: MAX_UPLOAD_BYTES, files: MAX_PAYROLL_FILES },
    })
  )
  async add(
    @UserId() userId: string,
    @Param('runId') runId: string,
    @UploadedFiles() files: Express.Multer.File[] | undefined,
    @Body() body: { kinds?: string | string[] }
  ): Promise<WorkspacePayrollRunDto> {
    return this.payroll.add(await this.callers.load(userId), runId, files ?? [], body?.kinds)
  }

  /** Polled while the job reads: counts only. */
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Get('workspace-payroll-match/:runId/progress')
  async progress(
    @UserId() userId: string,
    @Param('runId') runId: string
  ): Promise<PayrollMatchProgress> {
    return this.payroll.progress(await this.callers.load(userId), runId)
  }

  @Get('workspace-payroll-match/:runId')
  async get(
    @UserId() userId: string,
    @Param('runId') runId: string
  ): Promise<WorkspacePayrollRunDto> {
    return this.payroll.get(await this.callers.load(userId), runId)
  }

  /**
   * Resolve on someone a register pays who is on no list: added to the staff list with a role and the engagements they
   * work on. Answers the run as it now matches and the staff list.
   */
  @Post('workspace-payroll-match/:runId/staff')
  async addStaff(
    @UserId() userId: string,
    @Param('runId') runId: string,
    @Body() body: { name?: unknown; role?: unknown; engagementIds?: unknown }
  ): Promise<{ run: WorkspacePayrollRunDto; staff: StaffListDto }> {
    const caller = await this.callers.load(userId)
    let staff: StaffListDto | null = null
    const run = await this.payroll.afterAdding(caller, runId, async (workspaceId) => {
      const name = typeof body?.name === 'string' ? body.name : ''
      const role = typeof body?.role === 'string' && body.role.trim() ? body.role : null
      staff = await this.staff.add(caller, workspaceId, { staff: [{ name, role }] })
      const key = name.replace(/\s+/g, ' ').trim().toLowerCase()
      const person = staff.staff.find((s) => s.name.toLowerCase() === key)
      const ids = Array.isArray(body?.engagementIds) ? body.engagementIds : []
      for (const id of ids)
        if (person && typeof id === 'string')
          staff = await this.staff.assign(caller, person.id, id).catch((e: Error) => {
            throw new BadRequestException(
              `${person.name} is on the staff list, but tagging an engagement failed: ${e.message}`
            )
          })
    })
    return { run, staff: staff! }
  }

  /** Resolve on a pay stub naming someone on no participant list: added to an engagement of the run's workspace. */
  @Post('workspace-payroll-match/:runId/participants')
  async addParticipant(
    @UserId() userId: string,
    @Param('runId') runId: string,
    @Body()
    body: {
      engagementId?: unknown
      participantId: string
      displayName: string
      enrollmentStatus?: string
      tags?: unknown
    }
  ): Promise<WorkspacePayrollRunDto> {
    const caller = await this.callers.load(userId)
    return this.payroll.afterAdding(caller, runId, async (workspaceId) => {
      const engagementId = typeof body?.engagementId === 'string' ? body.engagementId : ''
      // An engagement of this workspace only: any other is not there.
      if (!(await this.payroll.isEngagementOf(caller, workspaceId, engagementId)))
        throw new BadRequestException('Choose an engagement')
      await this.engagementsService.createParticipant(caller, engagementId, body)
    })
  }

  /** Reads up to three files of the match with AI, when the owner ticked it; the run as it now matches. */
  @Throttle({ default: { limit: 40, ttl: 60_000 } })
  @Post('workspace-payroll-match/:runId/ai-read')
  async aiRead(
    @UserId() userId: string,
    @Param('runId') runId: string,
    @Body() body: unknown
  ): Promise<WorkspacePayrollRunDto> {
    return this.payroll.aiRead(await this.callers.load(userId), runId, body)
  }

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('workspace-payroll-match/:runId/files/:fileId')
  async file(
    @UserId() userId: string,
    @Param('runId') runId: string,
    @Param('fileId') fileId: string,
    @Res() res: Response
  ): Promise<void> {
    sendInline(res, await this.payroll.file(await this.callers.load(userId), runId, fileId))
  }

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('workspace-payroll-match/:runId/files/:fileId/copy')
  async copy(
    @UserId() userId: string,
    @Param('runId') runId: string,
    @Param('fileId') fileId: string,
    @Query('target') target: string,
    @Query('id') id: string,
    @Query('slot') slot: string,
    @Res() res: Response
  ): Promise<void> {
    sendInline(
      res,
      await this.payroll.copy(await this.callers.load(userId), runId, fileId, target, id, slot)
    )
  }

  @Post('workspace-payroll-match/:runId/save')
  async save(
    @UserId() userId: string,
    @Param('runId') runId: string,
    @Body() body: WorkspacePayrollSaveInput
  ): Promise<PayrollReconciliationDto> {
    return this.payroll.save(await this.callers.load(userId), runId, body)
  }

  @Delete('workspace-payroll-match/:runId')
  @HttpCode(204)
  async discard(@UserId() userId: string, @Param('runId') runId: string): Promise<void> {
    await this.payroll.discard(await this.callers.load(userId), runId)
  }
}
