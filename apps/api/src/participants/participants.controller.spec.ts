import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common'
import type { Caller } from '../core/caller'
import { member, OTHER, scoped, stranger, W } from '../core/testing/callers'
import { expectNoneOf, fakeLog } from '../core/testing/log'
import { StagedFile } from '../documents/staged-file'
import { ParticipantsController } from './participants.controller'
import { ParticipantsService } from './participants.service'

/** Attaching an eligibility record to a participant: members of the workspace who may write, nobody else. */
const participant = {
  id: 'p-1',
  workspaceId: W,
  engagementId: 'e-1',
  participantId: '900001',
  displayName: 'Jordan Sample',
  enrollmentStatus: 'new',
  currentStatus: 'active',
  tags: ['funding-source:youth-workforce-fund'],
  documents: [],
  engagement: {
    name: 'Coding Pathway',
    workspace: {
      tagTypes: [
        {
          key: 'funding-source',
          label: 'Funding source',
          appliesTo: ['engagement', 'expense', 'payroll', 'participant'],
          values: [
            { key: 'youth-workforce-fund', label: 'Youth Workforce Fund' },
            { key: 'adult-training-fund', label: 'Adult Training Fund' },
          ],
        },
        {
          key: 'age-group',
          label: 'Age group',
          appliesTo: ['participant'],
          values: [{ key: 'under-18', label: 'Under 18' }],
        },
        {
          key: 'site',
          label: 'Site',
          appliesTo: ['expense'],
          values: [{ key: 'north', label: 'North campus' }],
        },
      ],
    },
    eligibilityItems: [
      { key: 'enrollment-form', label: 'Enrollment form', required: true },
      {
        key: 'proof-of-age',
        label: 'Proof of age (birth certificate or state ID)',
        required: true,
      },
      { key: 'iss-plan', label: 'ISS plan, signed', required: false },
    ],
  },
}
const document = (id: string, workspaceId: string) => ({
  id,
  workspaceId,
  kind: 'eligibility-record',
})

/** A month of the engagement as its row stands. */
const month = (id: string, period: string, status: string, extra: object = {}) => ({
  id,
  workspaceId: W,
  engagementId: 'e-1',
  period,
  status,
  submittedAt: null as Date | null,
  authorizedByName: null as string | null,
  authorizedAt: null as Date | null,
  closingNote: null as string | null,
  sentBackReason: null as string | null,
  ...extra,
})
type Found = { code: string; severity: string; participantId?: string; message: string }

/**
 * The fake: `months` the engagement's months; `findings` what the rules find in a month before the change and after
 * it (none, when not given).
 */
function controller(
  who: Caller,
  months = [month('r-1', '2026-10', 'draft')],
  findings: Record<string, { before?: Found[]; after?: Found[] }> = {}
) {
  const prisma = {
    participant: { ...scoped(participant), update: jest.fn(), delete: jest.fn() },
    // What depends on the participant, for a removal: their payments and their file's records.
    wexPayment: { count: jest.fn().mockResolvedValue(0) },
    document: {
      ...scoped(document('d-1', W), document('d-other', OTHER)),
      create: jest.fn(async ({ data }: { data: object }) => ({ id: 'd-new', ...data })),
    },
    participantDocument: {
      count: jest.fn().mockResolvedValue(0),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      update: jest.fn(),
      deleteMany: jest.fn(),
    },
    monthlyReport: {
      findMany: jest.fn(async (args: { where: { status?: { in: string[] } } }) =>
        months
          .filter((m) => !args.where.status || args.where.status.in.includes(m.status))
          .map((m) => ({ id: m.id }))
      ),
      // A copy, as Prisma reads a row.
      findFirst: jest.fn(async (args: { where: { id: string } }) => {
        const m = months.find((x) => x.id === args.where.id)
        return m ? { ...m } : null
      }),
      update: jest.fn(async (args: { where: { id: string }; data: object }) =>
        Object.assign(
          months.find((x) => x.id === args.where.id)!,
          args.data
        )
      ),
    },
    reportReopening: {
      findFirst: jest.fn(async () => null),
      create: jest.fn(async ({ data }: { data: object }) => ({ id: 'ro-1', ...data })),
    },
  }
  const callers = { load: jest.fn().mockResolvedValue(who) }
  const checks = {
    refresh: jest.fn(async (id: string) => findings[id]?.after ?? []),
    findings: jest.fn(async (id: string) => findings[id]?.before ?? []),
  }
  const log = fakeLog(prisma)
  const service = new ParticipantsService(prisma as never, checks as never, log as never)
  return {
    controller: new ParticipantsController(service, callers as never),
    service,
    prisma,
    checks,
    log,
    months,
  }
}

/** A birth certificate uploaded from the participant's file, staged as POST /documents stages it. */
function staged() {
  const storage = {
    upload: jest.fn(),
    delete: jest.fn().mockResolvedValue(undefined),
    getSignedUrl: jest.fn(),
    deleteByPrefix: jest.fn(),
    putFile: jest.fn(),
    read: jest.fn(),
  }
  const file = new StagedFile(
    storage,
    {
      workspaceId: W,
      engagementId: 'e-1',
      period: null,
      kind: 'eligibility-record',
      sensitivity: 'personal',
      fileName: 'Jordan Sample birth certificate.pdf',
      contentType: 'application/pdf',
      size: 3,
      sha256: 'f'.repeat(64),
      storageKey: `${W}/e-1/general/new.pdf`,
      uploadedById: 'u-bookkeeper-ws-1',
    },
    Buffer.from('%PDF')
  )
  return { file, storage }
}

const attach = { documentId: 'd-1', purpose: 'enrollment-form' }

describe('ParticipantsController', () => {
  it('answers a member of another workspace with 404 and changes nothing', async () => {
    const who = stranger()
    const { controller: c, service: s, prisma, log } = controller(who)
    const { file, storage } = staged()
    await expect(c.attach(who.userId, 'p-1', attach)).rejects.toThrow(NotFoundException)
    await expect(c.detach(who.userId, 'p-1', 'd-1')).rejects.toThrow(NotFoundException)
    await expect(s.attach(who, 'p-1', 'proof-of-age', file)).rejects.toThrow(NotFoundException)
    expect(prisma.participantDocument.create).not.toHaveBeenCalled()
    expect(prisma.participantDocument.deleteMany).not.toHaveBeenCalled()
    expect(storage.upload).not.toHaveBeenCalled()
    expect(log.entries).toEqual([])
  })

  it('refuses an auditor, and logs nothing for the refusal', async () => {
    const who = member('auditor')
    const { controller: c, service: s, prisma, log } = controller(who)
    const { file, storage } = staged()
    await expect(c.attach(who.userId, 'p-1', attach)).rejects.toThrow(ForbiddenException)
    await expect(c.detach(who.userId, 'p-1', 'd-1')).rejects.toThrow(ForbiddenException)
    await expect(s.attach(who, 'p-1', 'proof-of-age', file)).rejects.toThrow(ForbiddenException)
    expect(prisma.participantDocument.create).not.toHaveBeenCalled()
    expect(prisma.participantDocument.deleteMany).not.toHaveBeenCalled()
    expect(storage.upload).not.toHaveBeenCalled()
    expect(log.entries).toEqual([])
  })

  it('refuses an item the checklist does not have, before storing anything', async () => {
    const who = member('bookkeeper')
    const { service: s, log } = controller(who)
    const { file, storage } = staged()
    await expect(s.attach(who, 'p-1', 'shoe-size', file)).rejects.toThrow(BadRequestException)
    expect(storage.upload).not.toHaveBeenCalled()
    expect(log.entries).toEqual([])
  })

  it('lets a bookkeeper attach a document of this workspace, logged, and refreshes every month', async () => {
    const who = member('bookkeeper')
    const { controller: c, prisma, checks, log } = controller(who)
    await c.attach(who.userId, 'p-1', attach)
    expect(prisma.participantDocument.create).toHaveBeenCalledWith({
      data: { participantId: 'p-1', documentId: 'd-1', purpose: 'enrollment-form' },
    })
    expect(log.entries).toEqual([
      {
        workspaceId: W,
        resource: 'participant',
        subjectId: 'p-1',
        action: 'update',
        description: "Attached enrollment form to a participant's file in Coding Pathway",
      },
    ])
    expect(checks.refresh).toHaveBeenCalledWith('r-1')
    // Every month, closed and submitted ones included: a month whose proof changed is checked again.
    expect(prisma.monthlyReport.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { engagementId: expect.any(String) } })
    )
    // A document of another workspace is not there to attach.
    await expect(c.attach(who.userId, 'p-1', { ...attach, documentId: 'd-other' })).rejects.toThrow(
      NotFoundException
    )
    prisma.participantDocument.findFirst.mockResolvedValue({ purpose: 'enrollment-form' })
    await c.detach(who.userId, 'p-1', 'd-1')
    expect(prisma.participantDocument.deleteMany).toHaveBeenCalledWith({
      where: { participantId: 'p-1', documentId: 'd-1' },
    })
    expect(log.entries.map((e) => e.description)).toEqual([
      "Attached enrollment form to a participant's file in Coding Pathway",
      "Detached enrollment form from a participant's file in Coding Pathway",
    ])
    // The log says which kind of record, never whose.
    expectNoneOf(log.entries, ['Jordan', '900001'])
  })

  it('uploads a record into the file in one transaction, naming the checklist item the row shows', async () => {
    const who = member('bookkeeper')
    const { service: s, prisma, log } = controller(who)
    const { file, storage } = staged()
    await s.attach(who, 'p-1', 'proof-of-age', file)
    expect(storage.upload).toHaveBeenCalledTimes(1)
    expect(prisma.participantDocument.create).toHaveBeenCalledWith({
      data: { participantId: 'p-1', documentId: 'd-new', purpose: 'proof-of-age' },
    })
    expect(log.entries).toEqual([
      {
        workspaceId: W,
        resource: 'participant',
        subjectId: 'p-1',
        action: 'update',
        description:
          "Uploaded proof of age (birth certificate or state ID) to a participant's file in Coding Pathway",
      },
    ])
    expectNoneOf(log.entries, ['Jordan', '900001', 'birth certificate.pdf'])
  })

  it('logs nothing for the same item again, and a move for another item', async () => {
    const who = member('bookkeeper')
    const { controller: c, prisma, log } = controller(who)
    prisma.participantDocument.findFirst.mockResolvedValue({ purpose: 'enrollment-form' })
    await c.attach(who.userId, 'p-1', attach)
    expect(log.entries).toEqual([])
    await c.attach(who.userId, 'p-1', { documentId: 'd-1', purpose: 'iss-plan' })
    expect(prisma.participantDocument.update).toHaveBeenCalledWith({
      where: { participantId_documentId: { participantId: 'p-1', documentId: 'd-1' } },
      data: { purpose: 'iss-plan' },
    })
    expect(log.entries.map((e) => e.description)).toEqual([
      "Moved an eligibility record on a participant's file in Coding Pathway from enrollment form to ISS plan, signed",
    ])
  })

  describe("a participant's tags", () => {
    const tags = ['funding-source:youth-workforce-fund', 'age-group:under-18']

    it('lets a bookkeeper tag from the list, logging the field by name only: personal data', async () => {
      const who = member('bookkeeper')
      const { controller: c, prisma, log } = controller(who)
      const answer = await c.setTags(who.userId, 'p-1', { tags })
      expect(answer.id).toBe('p-1')
      expect(prisma.participant.update).toHaveBeenCalledWith({
        where: { id: 'p-1' },
        data: { tags },
      })
      expect(log.entries).toEqual([
        {
          workspaceId: W,
          resource: 'participant',
          subjectId: 'p-1',
          action: 'update',
          description: 'Changed the tags of a participant in Coding Pathway',
          changes: [{ field: 'Tags' }],
        },
      ])
      expectNoneOf(log.entries, ['Jordan', '900001', 'Under 18', 'under-18', 'Youth Workforce'])
    })

    it('refuses free text and a type that is not for participants, and logs nothing for an unchanged save', async () => {
      const who = member('owner')
      const { controller: c, prisma, log } = controller(who)
      for (const bad of [['under 18'], ['site:north'], 'age-group:under-18'])
        await expect(c.setTags(who.userId, 'p-1', { tags: bad })).rejects.toThrow(
          BadRequestException
        )
      // No list at all is not "no tags": it would erase them.
      for (const body of [{}, { tags: null }])
        await expect(c.setTags(who.userId, 'p-1', body as never)).rejects.toThrow(
          BadRequestException
        )
      await c.setTags(who.userId, 'p-1', { tags: participant.tags })
      expect(prisma.participant.update).not.toHaveBeenCalled()
      expect(log.entries).toEqual([])
    })

    it('refuses an auditor (403) and a member of another workspace (404)', async () => {
      for (const [who, error] of [
        [member('auditor'), ForbiddenException],
        [stranger(), NotFoundException],
      ] as const) {
        const { controller: c, prisma, log } = controller(who)
        await expect(c.setTags(who.userId, 'p-1', { tags })).rejects.toThrow(error)
        expect(prisma.participant.update).not.toHaveBeenCalled()
        expect(log.entries).toEqual([])
      }
    })
  })

  it('puts back to draft the closed and submitted months whose checks the change altered, and no other', async () => {
    const who = member('bookkeeper')
    const missing: Found = {
      code: 'eligibility-missing',
      severity: 'blocker',
      participantId: 'p-1',
      message: "A participant's file is missing the enrollment form",
    }
    const note: Found = { code: 'note', severity: 'info', message: 'Something to know' }
    const {
      controller: c,
      prisma,
      checks,
      log,
      months,
    } = controller(
      who,
      [
        month('r-1', '2026-07', 'submitted', {
          submittedAt: new Date('2026-08-10'),
          authorizedByName: 'Dana Director',
        }),
        month('r-2', '2026-08', 'submitted', {
          submittedAt: new Date('2026-09-10'),
          authorizedByName: 'Dana Director',
        }),
        month('r-3', '2026-09', 'closed', { authorizedByName: 'Dana Director' }),
        month('r-4', '2026-10', 'closed', { authorizedByName: 'Dana Director' }),
        month('r-5', '2026-11', 'draft'),
      ],
      {
        // The record clears July's and September's blocking check; August's and October's checks say the same,
        // only an information note differs; November is a draft.
        'r-1': { before: [missing] },
        'r-2': { before: [missing], after: [missing, note] },
        'r-3': { before: [missing] },
        'r-4': { before: [], after: [note] },
        'r-5': { before: [missing] },
      }
    )
    await c.attach(who.userId, 'p-1', attach)
    // Compared with what the rules found before the change, closed and submitted months only.
    expect(checks.findings.mock.calls.map(([id]) => id)).toEqual(['r-1', 'r-2', 'r-3', 'r-4'])
    expect(months.map((m) => m.status)).toEqual(['draft', 'submitted', 'draft', 'closed', 'draft'])
    expect(months[2]!.sentBackReason).toMatch(
      /^Sent back because a participant's eligibility file changed on [A-Z][a-z]+ \d{1,2}, \d{4}\.$/
    )
    expect(prisma.reportReopening.create).toHaveBeenCalledTimes(1)
    expect(prisma.reportReopening.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        monthlyReportId: 'r-1',
        reopenedByEmail: who.email,
        reason: expect.stringMatching(/^A participant's eligibility file changed on /),
        submittedAt: new Date('2026-08-10'),
        approvedByName: 'Dana Director',
      }),
    })
    expect(log.entries.map((e) => e.description)).toEqual([
      "Attached enrollment form to a participant's file in Coding Pathway",
      "Reopened July 2026 of Coding Pathway because a participant's eligibility file changed",
      "Sent back the month-end closing of September 2026 of Coding Pathway because a participant's eligibility file changed",
    ])
    expect(log.actors).toEqual([who, who, who])
    expectNoneOf(log.entries, ['Jordan', '900001', 'Dana Director'])
  })

  it('logs nothing when there was nothing to detach', async () => {
    const who = member('bookkeeper')
    const { controller: c, prisma, log } = controller(who)
    await c.detach(who.userId, 'p-1', 'd-1')
    expect(prisma.participantDocument.deleteMany).not.toHaveBeenCalled()
    expect(log.entries).toEqual([])
  })

  describe("a participant's details and removal", () => {
    it('corrects the details, logging the fields by name only, and runs the checks again', async () => {
      const who = member('bookkeeper')
      const { service, prisma, log, checks } = controller(who)
      // The participant, then no other participant with the new number.
      prisma.participant.findFirst = jest
        .fn()
        .mockResolvedValueOnce({ ...participant })
        .mockResolvedValueOnce(null)
        .mockResolvedValue({ ...participant })
      await service.update(who, 'p-1', {
        displayName: 'Jordan Q. Sample',
        participantId: '900009',
        enrollmentStatus: 'carryover',
      })
      expect(prisma.participant.update).toHaveBeenCalledWith({
        where: { id: 'p-1' },
        data: {
          displayName: 'Jordan Q. Sample',
          participantId: '900009',
          enrollmentStatus: 'carryover',
        },
      })
      expect(log.entries).toEqual([
        {
          workspaceId: W,
          resource: 'participant',
          subjectId: 'p-1',
          action: 'update',
          description: "Changed a participant's details in Coding Pathway",
          changes: [{ field: 'Name' }, { field: 'Participant number' }, { field: 'Enrollment' }],
        },
      ])
      expectNoneOf(log.entries, ['Jordan', '900001', '900009', 'carryover'])
      expect(checks.refresh).toHaveBeenCalledWith('r-1')
    })

    it('refuses a blank name, a number another participant has, and an unknown enrollment, all at once', async () => {
      const who = member('owner')
      const { service, prisma, log } = controller(who)
      prisma.participant.findFirst = jest
        .fn()
        .mockResolvedValueOnce({ ...participant })
        .mockResolvedValueOnce({ id: 'p-2' })
      await expect(
        service.update(who, 'p-1', {
          displayName: ' ',
          participantId: '900002',
          enrollmentStatus: 'maybe',
        })
      ).rejects.toThrow(
        /Name the participant\. Another participant of this engagement has that number\. Say whether/
      )
      expect(prisma.participant.update).not.toHaveBeenCalled()
      expect(log.entries).toEqual([])
    })

    it('removes a participant with nothing depending on them, logged by field name only', async () => {
      const who = member('bookkeeper')
      const { service, prisma, log } = controller(who)
      await service.remove(who, 'p-1')
      expect(prisma.participant.delete).toHaveBeenCalledWith({ where: { id: 'p-1' } })
      expect(log.entries).toEqual([
        expect.objectContaining({
          action: 'delete',
          description: 'Removed a participant from Coding Pathway',
          changes: expect.arrayContaining([{ field: 'Name' }, { field: 'Participant number' }]),
        }),
      ])
      expectNoneOf(log.entries, ['Jordan', '900001'])
    })

    it('refuses a removal while they have payments or records, saying what to take off first', async () => {
      const who = member('owner')
      const { service, prisma, log } = controller(who)
      prisma.wexPayment.count.mockResolvedValue(2)
      prisma.participantDocument.count.mockResolvedValue(1)
      await expect(service.remove(who, 'p-1')).rejects.toThrow(
        'This participant has 2 work-experience payments and 1 record in their eligibility file: remove them first'
      )
      expect(prisma.participant.delete).not.toHaveBeenCalled()
      expect(log.entries).toEqual([])
    })

    it('lets an auditor change nothing, and answers another workspace with 404', async () => {
      const aud = member('auditor')
      const a = controller(aud)
      await expect(a.service.update(aud, 'p-1', { displayName: 'X' })).rejects.toThrow(
        ForbiddenException
      )
      await expect(a.service.remove(aud, 'p-1')).rejects.toThrow(ForbiddenException)
      const other = stranger()
      const o = controller(other)
      await expect(o.service.remove(other, 'p-1')).rejects.toThrow(NotFoundException)
      expect(a.prisma.participant.delete).not.toHaveBeenCalled()
    })
  })
})
