import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common'
import type { Role } from '@ad/types'
import { member, OTHER, scoped, stranger, W } from '../core/testing/callers'
import { WorkspacesService } from './workspaces.service'

/** Who may do what to a workspace: its members read it, owners run it, nobody outside sees it. */
const workspace = () => ({
  id: W,
  name: 'Riverbend Youth Services',
  fundingSources: [],
  _count: { memberships: 2, engagements: 1 },
  memberships: [
    {
      userId: 'u-owner-ws-1',
      role: 'owner',
      user: { displayName: 'Sam', email: 'sam@example.org' },
    },
    {
      userId: 'u-bookkeeper-ws-1',
      role: 'bookkeeper',
      user: { displayName: 'Dana', email: 'dana@example.org' },
    },
  ],
  suggestions: [],
})

function service() {
  const prisma = {
    workspace: { ...scoped(workspace()), create: jest.fn(), update: jest.fn() },
    membership: {
      // An invited person (a pending placeholder) is not a member yet; the people in the fixture are.
      findFirst: jest.fn(async ({ where }: { where: { userId: string } }) =>
        where.userId.startsWith('pending-') ? null : { id: 'm-1' }
      ),
      // keepAnOwner asks first whether the person is an owner (yes), then how many other owners there are.
      count: jest.fn(async ({ where }: { where: { userId: unknown } }) =>
        typeof where.userId === 'string' ? 1 : 0
      ),
      create: jest.fn(),
      update: jest.fn(),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    suggestion: { create: jest.fn() },
    dataAccessLog: { findMany: jest.fn().mockResolvedValue([]) },
    user: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(async ({ data }: { data: { id: string } }) => data),
    },
  }
  const writes = [
    prisma.workspace.update,
    prisma.membership.create,
    prisma.membership.update,
    prisma.membership.deleteMany,
    prisma.suggestion.create,
    prisma.user.create,
  ]
  return { service: new WorkspacesService(prisma as never), prisma, writes }
}

const invite = { email: 'jules@example.org', role: 'auditor' as Role }

describe('WorkspacesService', () => {
  it('shows a member of another workspace nothing: 404 from every route, no query, no write', async () => {
    const { service: s, prisma, writes } = service()
    const who = stranger()
    await expect(s.get(who, W)).rejects.toThrow(NotFoundException)
    await expect(s.activity(who, W)).rejects.toThrow(NotFoundException)
    await expect(s.suggest(who, W, 'a fund')).rejects.toThrow(NotFoundException)
    await expect(s.setLists(who, W, ['x'])).rejects.toThrow(NotFoundException)
    await expect(s.addMember(who, W, invite)).rejects.toThrow(NotFoundException)
    await expect(s.setRole(who, W, 'u-bookkeeper-ws-1', 'owner')).rejects.toThrow(NotFoundException)
    await expect(s.removeMember(who, W, 'u-bookkeeper-ws-1')).rejects.toThrow(NotFoundException)
    for (const w of writes) expect(w).not.toHaveBeenCalled()
    expect(prisma.dataAccessLog.findMany).not.toHaveBeenCalled()
    expect(await s.list(who)).toEqual([])
    expect(prisma.workspace.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: [OTHER] } } })
    )
  })

  it.each(['bookkeeper', 'auditor'] as Role[])(
    'lets a %s read the workspace, and nothing of its lists or people; the access log is for the auditor',
    async (role) => {
      const { service: s, writes } = service()
      const who = member(role)
      expect((await s.get(who, W)).canManage).toBe(false)
      if (role === 'auditor') expect(await s.activity(who, W)).toEqual([])
      else await expect(s.activity(who, W)).rejects.toThrow(ForbiddenException)
      await expect(s.setLists(who, W, ['x'])).rejects.toThrow(ForbiddenException)
      await expect(s.addMember(who, W, invite)).rejects.toThrow(ForbiddenException)
      await expect(s.setRole(who, W, 'u-bookkeeper-ws-1', 'owner')).rejects.toThrow(
        ForbiddenException
      )
      await expect(s.removeMember(who, W, 'u-owner-ws-1')).rejects.toThrow(ForbiddenException)
      for (const w of writes) expect(w).not.toHaveBeenCalled()
    }
  )

  it('takes a suggestion from a bookkeeper and none from an auditor', async () => {
    const { service: s, prisma } = service()
    await expect(s.suggest(member('auditor'), W, 'a fund')).rejects.toThrow(ForbiddenException)
    expect(prisma.suggestion.create).not.toHaveBeenCalled()
    await s.suggest(member('bookkeeper'), W, '  a fund ')
    expect(prisma.suggestion.create).toHaveBeenCalledWith({
      data: { workspaceId: W, userId: 'u-bookkeeper-ws-1', kind: 'list', text: 'a fund' },
    })
  })

  it('lets an owner edit the lists and manage people', async () => {
    const { service: s, prisma } = service()
    const owner = member('owner')
    expect((await s.get(owner, W)).canManage).toBe(true)
    await s.setLists(owner, W, ['Youth Fund', ' Youth Fund ', ''])
    expect(prisma.workspace.update).toHaveBeenCalledWith({
      where: { id: W },
      data: { fundingSources: ['Youth Fund'] },
    })
    await s.addMember(owner, W, invite)
    expect(prisma.membership.create).toHaveBeenCalledWith({
      data: { userId: expect.stringMatching(/^pending-/), workspaceId: W, role: 'auditor' },
    })
    await expect(s.addMember(owner, W, { ...invite, role: 'funder' as Role })).rejects.toThrow(
      BadRequestException
    )
    await expect(s.setRole(owner, W, 'u-bookkeeper-ws-1', 'funder' as Role)).rejects.toThrow(
      BadRequestException
    )
    await s.setRole(owner, W, 'u-bookkeeper-ws-1', 'owner')
    expect(prisma.membership.update).toHaveBeenCalledWith({
      where: { id: 'm-1' },
      data: { role: 'owner' },
    })
  })

  it('keeps at least one owner', async () => {
    const { service: s, prisma } = service()
    const owner = member('owner')
    await expect(s.setRole(owner, W, 'u-owner-ws-1', 'bookkeeper')).rejects.toThrow(
      BadRequestException
    )
    await expect(s.removeMember(owner, W, 'u-owner-ws-1')).rejects.toThrow(BadRequestException)
    expect(prisma.membership.update).not.toHaveBeenCalled()
    expect(prisma.membership.deleteMany).not.toHaveBeenCalled()
  })
})
