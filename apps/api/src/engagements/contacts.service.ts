import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { WRITE_ROLES, type EngagementContactInput, type EngagementDetail } from '@ad/types'
import { AccessLogService } from '../core/access-log.service'
import { allow, tenantWhere, workspaceRole, type Caller } from '../core/caller'
import { changesOf, type Fields } from '../core/changes'
import { PrismaService } from '../prisma/prisma.service'
import { EngagementsService } from './engagements.service'

/**
 * An award contact in the access log. Name, organization and job title are kept by value; email and phone are
 * personal data, so they are kept to their field name alone (Chow's decision, 2026-11-24).
 */
export const CONTACT_FIELDS: Fields = {
  name: { label: 'Name', show: 'text' },
  organization: { label: 'Organization', show: 'text' },
  jobTitle: { label: 'Job title', show: 'text' },
  email: { label: 'Email' },
  phone: { label: 'Phone' },
}

/** A short text field: trimmed, collapsed spacing, within a length, else null. */
function textOf(given: unknown, label: string, max: number): string | null {
  const text = typeof given === 'string' ? given.trim().replace(/\s+/g, ' ') : ''
  if (!text) return null
  if (text.length > max) throw new BadRequestException(`Keep the ${label} under ${max} characters`)
  return text
}

function nameOf(given: unknown): string {
  const name = textOf(given, 'name', 120)
  if (!name) throw new BadRequestException('Name the contact')
  return name
}

/** An email address: a plain shape check only, since the funder is not asked to confirm it. */
function emailOf(given: unknown): string | null {
  const text = typeof given === 'string' ? given.trim() : ''
  if (!text) return null
  if (text.length > 200) throw new BadRequestException('Keep the email under 200 characters')
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(text))
    throw new BadRequestException('Enter a valid email address, like name@example.org')
  return text
}

/** A phone number: digits and the usual punctuation only, kept as entered. */
function phoneOf(given: unknown): string | null {
  const text = typeof given === 'string' ? given.trim().replace(/\s+/g, ' ') : ''
  if (!text) return null
  if (text.length > 40) throw new BadRequestException('Keep the phone number under 40 characters')
  if (!/^[0-9+().\- ]+$/.test(text))
    throw new BadRequestException('Enter a phone number using digits and + ( ) - only')
  return text
}

/**
 * The fields of an award contact, checked together so every problem shows at once. Name is required, and at least
 * one of email or phone, so a saved contact can always be reached (Chow's decision, 2026-11-24).
 */
function valuesOf(input: EngagementContactInput) {
  const values = {
    name: nameOf(input?.name),
    organization: textOf(input?.organization, 'organization', 200),
    jobTitle: textOf(input?.jobTitle, 'job title', 120),
    email: emailOf(input?.email),
    phone: phoneOf(input?.phone),
  }
  if (!values.email && !values.phone)
    throw new BadRequestException('Give an email or a phone number, so the contact can be reached')
  return values
}

/**
 * The contacts on an award (G-09, issue #94): people at the funder and partner organizations. Several per award,
 * each with name, organization, job title, email and phone. Owners and bookkeepers add, change and remove them; an
 * auditor reads them on the engagement page. Email and phone are personal data, kept to their field name in the log.
 */
@Injectable()
export class ContactsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly engagements: EngagementsService,
    private readonly log: AccessLogService
  ) {}

  async add(
    caller: Caller,
    engagementId: string,
    input: EngagementContactInput
  ): Promise<EngagementDetail> {
    const c = await this.writable(caller, engagementId)
    const values = valuesOf(input)
    const sortOrder = await this.prisma.engagementContact.count({ where: { engagementId } })
    await this.log.change(
      caller,
      (tx) => tx.engagementContact.create({ data: { engagementId, sortOrder, ...values } }),
      () => ({
        workspaceId: c.workspaceId,
        resource: 'engagement',
        subjectId: c.id,
        action: 'create',
        description: `Added the contact ${values.name} to ${c.name}`,
        changes: changesOf(null, values, CONTACT_FIELDS),
      })
    )
    return this.engagements.detail(caller, c.id)
  }

  async update(
    caller: Caller,
    engagementId: string,
    contactId: string,
    input: EngagementContactInput
  ): Promise<EngagementDetail> {
    const { c, contact } = await this.contact(caller, engagementId, contactId)
    const values = valuesOf(input)
    const changes = changesOf(contact, values, CONTACT_FIELDS)
    if (changes.length === 0) return this.engagements.detail(caller, c.id)
    await this.log.change(
      caller,
      (tx) => tx.engagementContact.update({ where: { id: contact.id }, data: values }),
      () => ({
        workspaceId: c.workspaceId,
        resource: 'engagement',
        subjectId: c.id,
        action: 'update',
        description: `Changed the contact ${values.name} on ${c.name}`,
        changes,
      })
    )
    return this.engagements.detail(caller, c.id)
  }

  async remove(caller: Caller, engagementId: string, contactId: string): Promise<EngagementDetail> {
    const { c, contact } = await this.contact(caller, engagementId, contactId)
    await this.log.change(
      caller,
      (tx) => tx.engagementContact.delete({ where: { id: contact.id } }),
      {
        workspaceId: c.workspaceId,
        resource: 'engagement',
        subjectId: c.id,
        action: 'delete',
        description: `Removed the contact ${contact.name} from ${c.name}`,
        changes: changesOf(contact, null, CONTACT_FIELDS),
      }
    )
    return this.engagements.detail(caller, c.id)
  }

  /** The engagement, if the caller may change its contacts: another workspace's is a 404, an auditor's a 403. */
  private async writable(caller: Caller, engagementId: string) {
    const c = await this.prisma.engagement.findFirst({
      where: { id: engagementId, ...tenantWhere(caller) },
    })
    if (!c) throw new NotFoundException()
    allow(
      workspaceRole(caller, c.workspaceId, WRITE_ROLES),
      'Only an owner or bookkeeper changes the contacts'
    )
    return c
  }

  private async contact(caller: Caller, engagementId: string, contactId: string) {
    const c = await this.writable(caller, engagementId)
    const contact = await this.prisma.engagementContact.findFirst({
      where: { id: contactId, engagementId, ...tenantWhere(caller) },
    })
    if (!contact) throw new NotFoundException()
    return { c, contact }
  }
}
