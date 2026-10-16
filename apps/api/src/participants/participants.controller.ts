import { Body, Controller, Delete, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common'
import type { ParticipantDto } from '@ad/types'
import { AuthenticatedGuard } from '../auth/authenticated.guard'
import { CallerService, UserId } from '../core/caller'
import { ParticipantsService } from './participants.service'

@Controller('participants')
@UseGuards(AuthenticatedGuard)
export class ParticipantsController {
  constructor(
    private readonly participants: ParticipantsService,
    private readonly callers: CallerService
  ) {}

  @Patch(':id/tags')
  async setTags(
    @UserId() userId: string,
    @Param('id') id: string,
    @Body() body: { tags?: unknown }
  ): Promise<ParticipantDto> {
    return this.participants.setTags(await this.callers.load(userId), id, body?.tags)
  }

  @Post(':id/documents')
  @HttpCode(204)
  async attach(
    @UserId() userId: string,
    @Param('id') id: string,
    @Body() body: { documentId: string; purpose: string }
  ): Promise<void> {
    await this.participants.attach(
      await this.callers.load(userId),
      id,
      body.purpose,
      body.documentId
    )
  }

  @Delete(':id/documents/:documentId')
  @HttpCode(204)
  async detach(
    @UserId() userId: string,
    @Param('id') id: string,
    @Param('documentId') documentId: string
  ): Promise<void> {
    await this.participants.detach(await this.callers.load(userId), id, documentId)
  }
}
