import { Body, Controller, Delete, Param, Patch, Post, UseGuards } from '@nestjs/common'
import type { EngagementContactInput, EngagementDetail } from '@ad/types'
import { AuthenticatedGuard } from '../auth/authenticated.guard'
import { CallerService, UserId } from '../core/caller'
import { ContactsService } from './contacts.service'

/**
 * The contacts on an award (G-09, issue #94). Each action answers with the engagement as its page shows it, so the
 * award page refreshes its contacts.
 */
@Controller('engagements/:id/contacts')
@UseGuards(AuthenticatedGuard)
export class ContactsController {
  constructor(
    private readonly contacts: ContactsService,
    private readonly callers: CallerService
  ) {}

  @Post()
  async add(
    @UserId() userId: string,
    @Param('id') id: string,
    @Body() body: EngagementContactInput
  ): Promise<EngagementDetail> {
    return this.contacts.add(await this.callers.load(userId), id, body)
  }

  @Patch(':contactId')
  async update(
    @UserId() userId: string,
    @Param('id') id: string,
    @Param('contactId') contactId: string,
    @Body() body: EngagementContactInput
  ): Promise<EngagementDetail> {
    return this.contacts.update(await this.callers.load(userId), id, contactId, body)
  }

  @Delete(':contactId')
  async remove(
    @UserId() userId: string,
    @Param('id') id: string,
    @Param('contactId') contactId: string
  ): Promise<EngagementDetail> {
    return this.contacts.remove(await this.callers.load(userId), id, contactId)
  }
}
