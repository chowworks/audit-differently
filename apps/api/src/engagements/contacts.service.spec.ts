import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common'
import { member, scoped, stranger, W } from '../core/testing/callers'
import { expectNoneOf, fakeLog } from '../core/testing/log'
import { ContactsService } from './contacts.service'

/** Who may change an award's contacts (G-09), and that email and phone never reach the access log by value. */
const engagement = () => ({ id: 'e-1', workspaceId: W, name: 'Coding Pathway' })
const contact = () => ({
  id: 'ct-1',
  workspaceId: W,
  engagementId: 'e-1',
  name: 'Dana Rivers',
  organization: 'Demo Workforce Board',
  jobTitle: 'Grants manager',
  email: 'dana@demo-board.example',
  phone: '(555) 010-2200',
  sortOrder: 0,
})

function service(contacts = [contact()]) {
  const rows = scoped(...contacts)
  const prisma = {
    engagement: scoped(engagement()),
    engagementContact: {
      findFirst: rows.findFirst,
      count: jest.fn(async () => contacts.length),
      create: jest.fn(async ({ data }: { data: object }) => ({ id: 'ct-2', ...data })),
      update: jest.fn(async ({ data }: { data: object }) => ({ ...contact(), ...data })),
      delete: jest.fn(async () => contact()),
    },
  }
  const engagements = { detail: jest.fn().mockResolvedValue({ id: 'e-1' }) }
  const log = fakeLog(prisma)
  return {
    service: new ContactsService(prisma as never, engagements as never, log as never),
    prisma,
    log,
  }
}

const good = { name: 'Morgan Lee', email: 'morgan@demo-board.example', phone: '555-0101' }

describe('ContactsService', () => {
  it('adds a contact, logging the name but not the email or phone', async () => {
    const { service: s, prisma, log } = service([])
    await s.add(member('bookkeeper'), 'e-1', {
      name: 'Morgan Lee',
      organization: 'Demo Workforce Board',
      jobTitle: 'Contract specialist',
      email: 'morgan@demo-board.example',
      phone: '(555) 010-2255',
    })
    expect(prisma.engagementContact.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ engagementId: 'e-1', name: 'Morgan Lee', sortOrder: 0 }),
      })
    )
    const [entry] = log.entries
    expect([entry!.resource, entry!.action, entry!.description]).toEqual([
      'engagement',
      'create',
      'Added the contact Morgan Lee to Coding Pathway',
    ])
    expect(entry!.changes).toEqual([
      { field: 'Name', after: 'Morgan Lee' },
      { field: 'Organization', after: 'Demo Workforce Board' },
      { field: 'Job title', after: 'Contract specialist' },
      { field: 'Email' },
      { field: 'Phone' },
    ])
    // The email and phone values never reach the log.
    expectNoneOf(log.entries, ['morgan@demo-board.example', '010-2255'])
  })

  it('requires a name and at least one way to reach the contact', async () => {
    const { service: s } = service()
    const who = member('owner')
    await expect(s.add(who, 'e-1', { ...good, name: '  ' })).rejects.toThrow(BadRequestException)
    await expect(s.add(who, 'e-1', { name: 'Morgan Lee' })).rejects.toThrow(BadRequestException)
    await expect(s.add(who, 'e-1', { name: 'Morgan Lee', email: 'not-an-email' })).rejects.toThrow(
      BadRequestException
    )
    await expect(s.add(who, 'e-1', { name: 'Morgan Lee', phone: 'call me maybe' })).rejects.toThrow(
      BadRequestException
    )
  })

  it('lets an owner add, and a phone alone is enough to reach', async () => {
    const { service: s, prisma } = service([])
    await s.add(member('owner'), 'e-1', { name: 'Morgan Lee', phone: '555-0101' })
    expect(prisma.engagementContact.create).toHaveBeenCalled()
  })

  it('changes a contact, keeping email and phone out of the log', async () => {
    const { service: s, log } = service()
    await s.update(member('owner'), 'e-1', 'ct-1', { ...good, email: 'new@demo-board.example' })
    const [entry] = log.entries
    expect(entry!.description).toBe('Changed the contact Morgan Lee on Coding Pathway')
    expect(entry!.changes).toContainEqual({ field: 'Email' })
    expectNoneOf(log.entries, ['new@demo-board.example', 'dana@demo-board.example'])
  })

  it('removes a contact', async () => {
    const { service: s, prisma, log } = service()
    await s.remove(member('owner'), 'e-1', 'ct-1')
    expect(prisma.engagementContact.delete).toHaveBeenCalledWith({ where: { id: 'ct-1' } })
    expect(log.entries[0]!.description).toBe('Removed the contact Dana Rivers from Coding Pathway')
  })

  it('refuses an auditor (403) and another workspace (404)', async () => {
    const { service: s } = service()
    await expect(s.add(member('auditor'), 'e-1', good)).rejects.toThrow(ForbiddenException)
    await expect(s.add(stranger(), 'e-1', good)).rejects.toThrow(NotFoundException)
    await expect(s.update(stranger(), 'e-1', 'ct-1', good)).rejects.toThrow(NotFoundException)
  })

  it('404 for a contact that is not on this engagement', async () => {
    const { service: s } = service()
    await expect(s.update(member('owner'), 'e-1', 'nope', good)).rejects.toThrow(NotFoundException)
  })
})
