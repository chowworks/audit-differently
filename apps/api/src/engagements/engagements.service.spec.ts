import { ForbiddenException, NotFoundException } from '@nestjs/common'
import type { EngagementInput, Role } from '@ad/types'
import { member, OTHER, scoped, stranger, W } from '../core/testing/callers'
import { EngagementsService } from './engagements.service'

/** Who may read and change an engagement, and that a foreign one is a 404 and nothing more. */
const engagement = () => ({
  id: 'e-1',
  workspaceId: W,
  kind: 'grant',
  name: 'Coding Pathway',
  funder: 'Demo Workforce Board',
  funderContact: null,
  solicitation: null,
  number: 'DEMO-1',
  status: 'active',
  periodStart: new Date('2026-07-01T00:00:00Z'),
  periodEnd: new Date('2027-06-30T00:00:00Z'),
  proposalSubmittedOn: null,
  awardedOn: null,
  requestedAmount: null,
  awardAmount: 125000,
  fundingSources: [],
  reportDueDay: 12,
  indirectTerms: null,
  reportTo: null,
  submissionMethod: null,
  preparerName: null,
  preparerOrganization: null,
  authorizerName: null,
  authorizerOrganization: null,
  eligibilityItems: [],
  waivers: {},
  workspace: { name: 'Riverbend Youth Services', fundingSources: [] },
  monthlyReports: [],
  documents: [],
  budgetLines: [],
  participants: [
    {
      id: 'p-1',
      participantId: '900001',
      displayName: 'Jordan Sample',
      enrollmentStatus: 'new',
      currentStatus: 'active',
      documents: [],
    },
  ],
  _count: { budgetLines: 0 },
})

function service() {
  const prisma = {
    engagement: {
      ...scoped(engagement()),
      create: jest.fn().mockResolvedValue({ id: 'e-1' }),
      update: jest.fn(),
    },
    monthlyReport: {
      create: jest.fn(async ({ data }: { data: object }) => ({
        id: 'r-1',
        status: 'draft',
        submittedAt: null,
        ...data,
      })),
    },
    participant: {
      create: jest.fn(async ({ data }: { data: object }) => ({
        id: 'p-2',
        currentStatus: 'active',
        documents: [],
        ...data,
      })),
    },
  }
  const checks = { refresh: jest.fn().mockResolvedValue([]) }
  const log = { log: jest.fn().mockResolvedValue(undefined) }
  const writes = [
    prisma.engagement.create,
    prisma.engagement.update,
    prisma.monthlyReport.create,
    prisma.participant.create,
  ]
  return {
    service: new EngagementsService(prisma as never, checks as never, log as never),
    prisma,
    log,
    writes,
  }
}

const input: EngagementInput = {
  workspaceId: W,
  kind: 'grant',
  name: 'Coding Pathway',
  eligibilityItems: [{ key: 'enrollment-form', label: 'Enrollment form', required: true }],
}
const newcomer = { participantId: '900002', displayName: 'Riley Example' }

describe('EngagementsService', () => {
  it('answers a member of another workspace with 404 and writes nothing', async () => {
    const { service: s, log, writes } = service()
    const who = stranger()
    await expect(s.create(who, input)).rejects.toThrow(ForbiddenException)
    await expect(s.get(who, 'e-1')).rejects.toThrow(NotFoundException)
    await expect(s.update(who, 'e-1', { name: 'x' })).rejects.toThrow(NotFoundException)
    await expect(s.createReport(who, 'e-1', '2026-09')).rejects.toThrow(NotFoundException)
    await expect(s.createParticipant(who, 'e-1', newcomer)).rejects.toThrow(NotFoundException)
    for (const w of writes) expect(w).not.toHaveBeenCalled()
    expect(log.log).not.toHaveBeenCalled()
  })

  it('scopes the list to the caller workspaces', async () => {
    const { service: s, prisma } = service()
    await s.list(stranger())
    expect(prisma.engagement.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: { in: [OTHER] } } })
    )
  })

  it('lets an auditor read an engagement and change nothing', async () => {
    const { service: s, log, writes } = service()
    const who = member('auditor')
    const detail = await s.get(who, 'e-1')
    expect(detail.canManage).toBe(false)
    expect(detail.participants).toHaveLength(1)
    // The participant rows it returns are logged.
    expect(log.log).toHaveBeenCalledWith(
      who,
      expect.objectContaining({ workspaceId: W, resource: 'participant', action: 'list' })
    )
    await expect(s.create(who, input)).rejects.toThrow(ForbiddenException)
    await expect(s.update(who, 'e-1', { name: 'x' })).rejects.toThrow(ForbiddenException)
    await expect(s.createReport(who, 'e-1', '2026-09')).rejects.toThrow(ForbiddenException)
    await expect(s.createParticipant(who, 'e-1', newcomer)).rejects.toThrow(ForbiddenException)
    for (const w of writes) expect(w).not.toHaveBeenCalled()
  })

  it('creates one without a checklist, so the defaults apply (the setup flow sends none)', async () => {
    const { service: s, prisma } = service()
    await s.create(member('bookkeeper'), { ...input, eligibilityItems: undefined })
    const data = prisma.engagement.create.mock.calls[0]![0].data
    expect(data).not.toHaveProperty('eligibilityItems')
  })

  it.each(['owner', 'bookkeeper'] as Role[])('lets a %s create and change one', async (role) => {
    const { service: s, prisma } = service()
    const who = member(role)
    expect((await s.create(who, input)).canManage).toBe(true)
    expect(prisma.engagement.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ workspaceId: W, status: 'proposed' }),
      })
    )
    await s.update(who, 'e-1', {
      eligibilityItems: [{ key: 'proof-of-age', label: 'Proof of age', required: true }],
      waivers: { 'budget-narrative': 'this funder does not use one' },
      // Another workspace named in the body changes nothing: the engagement stays where it is.
      workspaceId: OTHER,
    })
    const [{ data }] = prisma.engagement.update.mock.calls[0] as [{ data: Record<string, unknown> }]
    expect(data).toEqual({
      eligibilityItems: [{ key: 'proof-of-age', label: 'Proof of age', required: true }],
      waivers: { 'budget-narrative': 'this funder does not use one' },
      status: 'active',
    })
    expect(data).not.toHaveProperty('workspaceId')
    await s.createReport(who, 'e-1', '2026-09')
    expect(prisma.monthlyReport.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ engagementId: 'e-1' }) })
    )
    await s.createParticipant(who, 'e-1', newcomer)
    expect(prisma.participant.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ engagementId: 'e-1' }) })
    )
  })
})
