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
  engagement: {
    name: 'Coding Pathway',
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

function controller(who: Caller) {
  const prisma = {
    participant: scoped(participant),
    document: {
      ...scoped(document('d-1', W), document('d-other', OTHER)),
      create: jest.fn(async ({ data }: { data: object }) => ({ id: 'd-new', ...data })),
    },
    participantDocument: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      update: jest.fn(),
      deleteMany: jest.fn(),
    },
    monthlyReport: { findMany: jest.fn().mockResolvedValue([{ id: 'r-1' }]) },
  }
  const callers = { load: jest.fn().mockResolvedValue(who) }
  const checks = { refresh: jest.fn().mockResolvedValue([]) }
  const log = fakeLog(prisma)
  const service = new ParticipantsService(prisma as never, checks as never, log as never)
  return {
    controller: new ParticipantsController(service, callers as never),
    service,
    prisma,
    checks,
    log,
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

  it('lets a bookkeeper attach a document of this workspace, logged, and refreshes the open months', async () => {
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

  it('logs nothing when there was nothing to detach', async () => {
    const who = member('bookkeeper')
    const { controller: c, prisma, log } = controller(who)
    await c.detach(who.userId, 'p-1', 'd-1')
    expect(prisma.participantDocument.deleteMany).not.toHaveBeenCalled()
    expect(log.entries).toEqual([])
  })
})
