import { Prisma } from '@prisma/client'
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common'
import {
  DEFAULT_BUDGET_ITEMS,
  DEFAULT_ELIGIBILITY_ITEMS,
  DEFAULT_TAG_TYPES,
  type EngagementInput,
  type Role,
} from '@ad/types'
import { member, OTHER, scoped, stranger, W } from '../core/testing/callers'
import { expectNoneOf, fakeLog } from '../core/testing/log'
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
  tracks: ['proposal', 'award-letter', 'contract'],
  periodStart: new Date('2026-07-01T00:00:00Z'),
  periodEnd: new Date('2027-06-30T00:00:00Z'),
  proposalSubmittedOn: null,
  awardedOn: null,
  requestedAmount: null,
  awardAmount: 125000,
  tags: [] as string[],
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
  workspace: { name: 'Riverbend Youth Services', tagTypes: DEFAULT_TAG_TYPES },
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
    workspace: scoped({ id: W, budgetItems: DEFAULT_BUDGET_ITEMS, tagTypes: DEFAULT_TAG_TYPES }),
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
  const log = fakeLog(prisma)
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
    expect(log.entries).toEqual([])
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
    // Opening it writes one line, with the participant rows it lists counted.
    expect(log.entries).toEqual([
      {
        workspaceId: W,
        resource: 'engagement',
        subjectId: 'e-1',
        action: 'read',
        description: 'Viewed Coding Pathway: 0 records, 1 participant',
      },
    ])
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

  it('starts a line of $0 for each budget item it uses, in the list order, and logs them', async () => {
    const { service: s, prisma, log } = service()
    await s.create(member('bookkeeper'), { ...input, budgetItems: ['wex', 'travel'] })
    expect(prisma.engagement.create.mock.calls[0]![0].data.budgetLines).toEqual({
      create: [
        { category: 'travel', reportLine: 'program-costs', amount: '0.00', sortOrder: 2 },
        { category: 'wex', reportLine: 'wex', amount: '0.00', sortOrder: 9 },
      ],
    })
    expect(log.entries.at(-1)!.changes).toContainEqual({
      field: 'Budget lines',
      after: 'Travel, Work Experience (WEX)',
    })
    // None asked for: no line, as before.
    await s.create(member('bookkeeper'), input)
    expect(prisma.engagement.create.mock.calls[1]![0].data).not.toHaveProperty('budgetLines')
  })

  it("refuses a budget item the workspace does not have, and an auditor's engagement", async () => {
    const { service: s, prisma, log } = service()
    await expect(
      s.create(member('owner'), { ...input, budgetItems: ['travel', 'yacht'] })
    ).rejects.toThrow(BadRequestException)
    await expect(
      s.create(member('auditor'), { ...input, budgetItems: ['travel'] })
    ).rejects.toThrow(ForbiddenException)
    expect(prisma.engagement.create).not.toHaveBeenCalled()
    expect(log.entries).toEqual([])
  })

  it('keeps the records it is told to, logs the change, and refuses any other record', async () => {
    const { service: s, prisma, log } = service()
    const who = member('bookkeeper')
    await s.create(who, { ...input, tracks: [] })
    expect(prisma.engagement.create.mock.calls[0]![0].data).toMatchObject({ tracks: [] })
    // Stored in the list's own order, whatever order it came in.
    await s.update(who, 'e-1', { tracks: ['contract', 'proposal'] })
    expect(prisma.engagement.update.mock.calls[0]![0].data).toMatchObject({
      tracks: ['proposal', 'contract'],
    })
    expect(log.entries.at(-1)!.changes).toContainEqual({
      field: 'Records kept',
      before: 'Proposal, Award letter, Signed contract',
      after: 'Proposal, Signed contract',
    })
    await expect(s.update(who, 'e-1', { tracks: ['audit' as never] })).rejects.toThrow(
      BadRequestException
    )
  })

  it('keeps an engagement code in capitals, logs it, and refuses a malformed or doubled one', async () => {
    const { service: s, prisma, log } = service()
    const who = member('bookkeeper')
    await s.update(who, 'e-1', { code: ' cp-26 ' })
    expect(prisma.engagement.update.mock.calls[0]![0].data).toMatchObject({ code: 'CP-26' })
    expect(log.entries.at(-1)!.changes).toContainEqual({
      field: 'Engagement code',
      before: null,
      after: 'CP-26',
    })
    for (const bad of ['x', 'has space', '-CP', 'C'.repeat(21)])
      await expect(s.update(who, 'e-1', { code: bad })).rejects.toThrow(BadRequestException)
    prisma.engagement.update.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('taken', {
        code: 'P2002',
        clientVersion: 'x',
        meta: { target: ['workspaceId', 'code'] },
      })
    )
    await expect(s.update(who, 'e-1', { code: 'YB' })).rejects.toThrow(
      'Another engagement in this workspace uses the code YB'
    )
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

  it("logs each change in the screen's words, with amounts and dates but no names, reasons or participants", async () => {
    const { service: s, log } = service()
    const who = member('bookkeeper')
    await s.create(who, { ...input, awardAmount: 90000, preparerName: 'Pat Preparer' })
    await s.update(who, 'e-1', { waivers: { 'award-letter': 'Issued by phone to Pat' } })
    await s.update(who, 'e-1', { awardAmount: 130000, funderContact: 'casey@funder.example' })
    await s.createReport(who, 'e-1', '2026-09')
    await s.createParticipant(who, 'e-1', newcomer)
    // One line per action, and none for the engagement each change hands back: that is not the page being opened.
    expect(log.log).not.toHaveBeenCalled()
    expect(log.entries.map((e) => [e.resource, e.action, e.subjectId, e.description])).toEqual([
      ['engagement', 'create', 'e-1', 'Created the engagement Coding Pathway'],
      ['engagement', 'update', 'e-1', 'Recorded that Coding Pathway has no award letter'],
      ['engagement', 'update', 'e-1', 'Changed the details of Coding Pathway'],
      ['report', 'create', 'r-1', 'Started September 2026 of Coding Pathway'],
      ['participant', 'create', 'p-2', 'Added a participant to Coding Pathway'],
    ])
    const changes = log.entries
    expect(changes[0]!.changes).toEqual(
      expect.arrayContaining([
        { field: 'Kind', after: 'Grant' },
        { field: 'Status', after: 'awarded' },
        { field: 'Award amount', after: '90000.00' },
        { field: 'Prepared by' },
        { field: 'Participant files' },
      ])
    )
    expect(changes[1]!.changes).toEqual([{ field: 'No award letter' }])
    expect(changes[2]!.changes).toEqual([
      { field: 'Funding organization contact' },
      { field: 'Award amount', before: '125000.00', after: '130000.00' },
    ])
    expect(changes[4]!.changes).toEqual([
      { field: 'Name' },
      { field: 'Participant number' },
      { field: 'Enrollment' },
    ])
    expectNoneOf(log.entries, ['Pat Preparer', 'to Pat', 'casey@', 'Riley', '900002'])
  })

  it("tags a new participant from the workspace's list, logging the field by name alone", async () => {
    const { service: s, prisma, log } = service()
    const who = member('bookkeeper')
    const tags = ['funding-source:youth-workforce-fund']
    expect((await s.createParticipant(who, 'e-1', { ...newcomer, tags })).tags).toEqual(tags)
    expect(prisma.participant.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ tags }) })
    )
    expect(log.entries[0]!.changes).toEqual(expect.arrayContaining([{ field: 'Tags' }]))
    expectNoneOf(log.entries, ['Youth Workforce'])
    await expect(
      s.createParticipant(who, 'e-1', { ...newcomer, participantId: '900003', tags: ['under 18'] })
    ).rejects.toThrow(BadRequestException)
  })

  it('answers a waiver change with the engagement and a new participant with itself, each with one line', async () => {
    const { service: s, log } = service()
    const who = member('bookkeeper')
    const saved = await s.update(who, 'e-1', { waivers: { proposal: 'invited directly' } })
    expect(saved).toMatchObject({ id: 'e-1', participantCount: 1, canManage: true })
    const added = await s.createParticipant(who, 'e-1', newcomer)
    expect(added).toEqual({
      id: 'p-2',
      participantId: '900002',
      displayName: 'Riley Example',
      enrollmentStatus: 'new',
      currentStatus: 'active',
      tags: [],
      documents: [],
    })
    expect(log.log).not.toHaveBeenCalled()
    expect(log.entries.map((e) => [e.resource, e.action])).toEqual([
      ['engagement', 'update'],
      ['participant', 'create'],
    ])
  })

  it('returns the new month with the checks its first run opened', async () => {
    const { service: s, prisma } = service()
    const checks = { refresh: jest.fn().mockResolvedValue([{ severity: 'blocker' }]) }
    const s2 = new EngagementsService(prisma as never, checks as never, fakeLog(prisma) as never)
    expect((await s.createReport(member('owner'), 'e-1', '2026-09')).openBlockers).toBe(0)
    expect((await s2.createReport(member('owner'), 'e-1', '2026-10')).openBlockers).toBe(1)
  })

  it('names a waiver as RecordModal does: recorded, reason changed, reason removed', async () => {
    const { service: s, log, prisma } = service()
    const who = member('owner')
    prisma.engagement.findFirst.mockResolvedValue({
      ...engagement(),
      waivers: { 'award-letter': 'none issued', proposal: 'invited directly' },
    })
    await s.update(who, 'e-1', { waivers: { proposal: 'invited directly' } })
    await s.update(who, 'e-1', {
      waivers: { 'award-letter': 'a new reason', proposal: 'invited directly' },
    })
    await s.update(who, 'e-1', {
      waivers: {
        'award-letter': 'none issued',
        proposal: 'invited directly',
        contract: 'by letter',
      },
    })
    expect(log.entries.map((e) => e.description)).toEqual([
      'Removed the reason Coding Pathway has no award letter',
      'Changed why Coding Pathway has no award letter',
      'Recorded that Coding Pathway has no signed contract',
    ])
    expect(log.entries[2]!.changes).toEqual([{ field: 'No signed contract' }])
  })

  it("picks the engagement's funding sources from the workspace's tags, logging them in its words", async () => {
    const { service: s, prisma, log } = service()
    const who = member('bookkeeper')
    await s.create(who, { ...input, tags: ['funding-source:adult-training-fund'] })
    expect(prisma.engagement.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ tags: ['funding-source:adult-training-fund'] }),
      })
    )
    expect(log.entries[0]!.changes).toEqual(
      expect.arrayContaining([{ field: 'Tags', after: 'Funding source: Adult Training Fund' }])
    )
    await s.update(who, 'e-1', { tags: ['funding-source:youth-workforce-fund'] })
    expect(log.entries[1]!.changes).toEqual([
      { field: 'Tags', before: null, after: 'Funding source: Youth Workforce Fund' },
    ])
    await expect(s.update(who, 'e-1', { tags: ['Youth Workforce Fund'] })).rejects.toThrow(
      BadRequestException
    )
  })

  /** What the Details modal sends on Save: every field, as the form holds it. */
  const detailsForm = (): Partial<EngagementInput> => ({
    kind: 'grant',
    name: 'Coding Pathway',
    solicitation: '',
    funder: 'Demo Workforce Board',
    funderContact: '',
    tags: [],
    requestedAmount: null,
    proposalSubmittedOn: '',
    awardedOn: '',
    awardAmount: 125000,
    number: 'DEMO-1',
    periodStart: '2026-07-01',
    periodEnd: '2027-06-30',
    reportDueDay: 12,
    reportTo: '',
    submissionMethod: '',
    preparerName: '',
    preparerOrganization: '',
    authorizerName: '',
    authorizerOrganization: '',
    // The engagement holds no checklist of its own, so the modal shows (and sends back) the defaults.
    eligibilityItems: DEFAULT_ELIGIBILITY_ITEMS.map((i) => ({ ...i })),
    waivers: {},
  })

  it('writes nothing and logs nothing for a Save that changes nothing', async () => {
    const { service: s, log, prisma } = service()
    const detail = await s.update(member('owner'), 'e-1', detailsForm())
    expect(detail.id).toBe('e-1')
    expect(prisma.engagement.update).not.toHaveBeenCalled()
    expect(log.entries).toEqual([])
  })

  it('keeps an unchanged default checklist out of the row and out of the line', async () => {
    const { service: s, log, prisma } = service()
    await s.update(member('owner'), 'e-1', { ...detailsForm(), awardAmount: 130000 })
    const [{ data }] = prisma.engagement.update.mock.calls[0] as [{ data: Record<string, unknown> }]
    expect(data).not.toHaveProperty('eligibilityItems')
    expect(log.entries.map((e) => [e.description, e.changes])).toEqual([
      [
        'Changed the details of Coding Pathway',
        [{ field: 'Award amount', before: '125000.00', after: '130000.00' }],
      ],
    ])
  })

  it('words a Details Save that only ticks "No signed contract" as the waiver', async () => {
    const { service: s, log } = service()
    await s.update(member('owner'), 'e-1', {
      ...detailsForm(),
      waivers: { contract: 'the award letter is the agreement', proposal: '' },
    })
    expect(log.entries.map((e) => e.description)).toEqual([
      'Recorded that Coding Pathway has no signed contract',
    ])
  })

  it('logs a changed checklist by name alone', async () => {
    const { service: s, log } = service()
    const items = DEFAULT_ELIGIBILITY_ITEMS.map((i) => ({ ...i, required: true }))
    await s.update(member('owner'), 'e-1', { ...detailsForm(), eligibilityItems: items })
    expect(log.entries.map((e) => [e.description, e.changes])).toEqual([
      ['Changed the details of Coding Pathway', [{ field: 'Participant files' }]],
    ])
  })

  it('logs nothing on a refused or invalid change', async () => {
    const { service: s, log, writes } = service()
    await expect(s.update(member('auditor'), 'e-1', { awardAmount: 1 })).rejects.toThrow(
      ForbiddenException
    )
    await expect(
      s.update(member('owner'), 'e-1', { periodStart: '2028-01-01', periodEnd: '2027-01-01' })
    ).rejects.toThrow(BadRequestException)
    await expect(s.create(member('owner'), { ...input, name: ' ' })).rejects.toThrow(
      BadRequestException
    )
    await expect(s.createReport(member('owner'), 'e-1', '2030-01')).rejects.toThrow(
      BadRequestException
    )
    await expect(
      s.createParticipant(member('owner'), 'e-1', { participantId: '', displayName: '' })
    ).rejects.toThrow(BadRequestException)
    for (const w of writes) expect(w).not.toHaveBeenCalled()
    expect(log.entries).toEqual([])
  })

  it('logs the list once per workspace, each with its own counts', async () => {
    const { service: s, prisma, log } = service()
    const row = (id: string, workspaceId: string, documents: number) => ({
      ...engagement(),
      id,
      workspaceId,
      participants: [],
      documents: Array.from({ length: documents }, (_, i) => ({
        id: `${id}-d${i}`,
        workspaceId,
        engagementId: id,
        storageKey: `${workspaceId}/${id}/general/${i}.pdf`,
        fileName: `${i}.pdf`,
        kind: 'invoice',
        sensitivity: 'financial',
        period: null,
        size: 1,
        sha256: 'x',
        contentType: 'application/pdf',
        uploadedAt: new Date('2026-10-01T00:00:00Z'),
        uploadedById: 'u',
      })),
    })
    prisma.engagement.findMany.mockResolvedValue([
      row('e-1', W, 2),
      row('e-2', W, 1),
      row('e-3', OTHER, 0),
    ] as never)
    const both = {
      ...member('owner'),
      memberships: [
        { workspaceId: W, workspaceName: W, role: 'owner' as const },
        { workspaceId: OTHER, workspaceName: OTHER, role: 'auditor' as const },
      ],
      workspaceIds: [W, OTHER],
    }
    expect(await s.list(both)).toHaveLength(3)
    expect(log.entries.map((e) => [e.workspaceId, e.resource, e.action, e.description])).toEqual([
      [W, 'engagement', 'list', 'Viewed the list of engagements: 2 engagements, 3 records'],
      [OTHER, 'engagement', 'list', 'Viewed the list of engagements: 1 engagement, 0 records'],
    ])
  })
})
