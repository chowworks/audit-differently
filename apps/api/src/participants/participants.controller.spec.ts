import { ForbiddenException, NotFoundException } from '@nestjs/common'
import type { Caller } from '../core/caller'
import { member, OTHER, scoped, stranger, W } from '../core/testing/callers'
import { ParticipantsController } from './participants.controller'

/** Attaching an eligibility record to a participant: members of the workspace who may write, nobody else. */
const participant = {
  id: 'p-1',
  workspaceId: W,
  engagementId: 'e-1',
  engagement: {
    eligibilityItems: [{ key: 'enrollment-form', label: 'Enrollment form', required: true }],
  },
}
const document = (id: string, workspaceId: string) => ({ id, workspaceId })

function controller(who: Caller) {
  const prisma = {
    participant: scoped(participant),
    document: scoped(document('d-1', W), document('d-other', OTHER)),
    participantDocument: { upsert: jest.fn(), deleteMany: jest.fn() },
    monthlyReport: { findMany: jest.fn().mockResolvedValue([{ id: 'r-1' }]) },
  }
  const callers = { load: jest.fn().mockResolvedValue(who) }
  const checks = { refresh: jest.fn().mockResolvedValue([]) }
  const log = { log: jest.fn().mockResolvedValue(undefined) }
  return {
    controller: new ParticipantsController(
      prisma as never,
      callers as never,
      checks as never,
      log as never
    ),
    prisma,
    checks,
    log,
  }
}

const attach = { documentId: 'd-1', purpose: 'enrollment-form' }

describe('ParticipantsController', () => {
  it('answers a member of another workspace with 404 and changes nothing', async () => {
    const who = stranger()
    const { controller: c, prisma, log } = controller(who)
    await expect(c.attach(who.userId, 'p-1', attach)).rejects.toThrow(NotFoundException)
    await expect(c.detach(who.userId, 'p-1', 'd-1')).rejects.toThrow(NotFoundException)
    expect(prisma.participantDocument.upsert).not.toHaveBeenCalled()
    expect(prisma.participantDocument.deleteMany).not.toHaveBeenCalled()
    expect(log.log).not.toHaveBeenCalled()
  })

  it('refuses an auditor', async () => {
    const who = member('auditor')
    const { controller: c, prisma } = controller(who)
    await expect(c.attach(who.userId, 'p-1', attach)).rejects.toThrow(ForbiddenException)
    await expect(c.detach(who.userId, 'p-1', 'd-1')).rejects.toThrow(ForbiddenException)
    expect(prisma.participantDocument.upsert).not.toHaveBeenCalled()
    expect(prisma.participantDocument.deleteMany).not.toHaveBeenCalled()
  })

  it('lets a bookkeeper attach a document of this workspace, logged, and refreshes the open months', async () => {
    const who = member('bookkeeper')
    const { controller: c, prisma, checks, log } = controller(who)
    await c.attach(who.userId, 'p-1', attach)
    expect(prisma.participantDocument.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: { participantId: 'p-1', documentId: 'd-1', purpose: 'enrollment-form' },
      })
    )
    expect(log.log).toHaveBeenCalledWith(
      who,
      expect.objectContaining({ workspaceId: W, resource: 'participant', subjectId: 'p-1' })
    )
    expect(checks.refresh).toHaveBeenCalledWith('r-1')
    // A document of another workspace is not there to attach.
    await expect(c.attach(who.userId, 'p-1', { ...attach, documentId: 'd-other' })).rejects.toThrow(
      NotFoundException
    )
    await c.detach(who.userId, 'p-1', 'd-1')
    expect(prisma.participantDocument.deleteMany).toHaveBeenCalledWith({
      where: { participantId: 'p-1', documentId: 'd-1' },
    })
  })
})
