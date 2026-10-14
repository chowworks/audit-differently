import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common'
import type { Role } from '@ad/types'
import type { Caller } from '../core/caller'
import { member, OTHER, scoped, stranger, W } from '../core/testing/callers'
import { expectNoneOf, fakeLog } from '../core/testing/log'
import { tenantContext, withTenantContext } from '../core/tenant-context'
import { WorkspacesService } from './workspaces.service'

/** The platform admin on an admin route (CallerService.loadAdmin): a member of no workspace. */
const admin = (over: Partial<Caller> = {}): Caller => ({
  userId: 'u-admin',
  displayName: 'The admin',
  email: 'admin@example.org',
  memberships: [],
  workspaceIds: [],
  admin: true,
  ...over,
})
const newWorkspace = {
  name: 'Riverbend Youth Services',
  ownerEmail: ' Pat@Example.org ',
  ownerName: 'Pat',
}

/** Who may do what to a workspace: its members read it, owners run it, nobody outside sees it. */
const workspace = () => ({
  id: W,
  name: 'Riverbend Youth Services',
  fundingSources: [],
  createdAt: new Date('2026-10-01T00:00:00Z'),
  termsAcceptedAt: null,
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
    workspace: {
      ...scoped(workspace()),
      create: jest.fn(async ({ data }: { data: { name: string } }) => ({ id: W, ...data })),
      update: jest.fn(),
    },
    membership: {
      // An invited person (a pending placeholder) is not a member yet; the people in the fixture are.
      findFirst: jest.fn(async ({ where }: { where: { userId: string } }) =>
        where.userId.startsWith('pending-')
          ? null
          : {
              id: 'm-1',
              role: 'bookkeeper',
              user: { displayName: 'Dana', email: 'dana@example.org' },
            }
      ),
      // keepAnOwner asks first whether the person is an owner (yes), then how many other owners there are.
      count: jest.fn(async ({ where }: { where: { userId: unknown } }) =>
        typeof where.userId === 'string' ? 1 : 0
      ),
      create: jest.fn(async ({ data }: { data: { workspaceId: string } }) => ({
        id: 'm-2',
        ...data,
      })),
      update: jest.fn().mockResolvedValue({ id: 'm-1', workspaceId: W }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    suggestion: {
      create: jest.fn(async ({ data }: { data: { workspaceId: string } }) => ({
        id: 's-1',
        ...data,
      })),
    },
    dataAccessLog: { findMany: jest.fn().mockResolvedValue([]) },
    engagement: { findMany: jest.fn(), count: jest.fn() },
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
    prisma.workspace.create,
  ]
  const log = fakeLog(prisma)
  // The admin's verified Clerk addresses, asked only on the admin path.
  const clerk = { verifiedEmails: jest.fn().mockResolvedValue([] as string[]) }
  return {
    service: new WorkspacesService(prisma as never, log as never, clerk as never),
    prisma,
    log,
    clerk,
    writes,
  }
}

const invite = { email: 'jules@example.org', role: 'auditor' as Role }

describe('WorkspacesService', () => {
  it('shows a member of another workspace nothing: 404 from every route, no query, no write', async () => {
    const { service: s, prisma, log, writes } = service()
    const who = stranger()
    await expect(s.get(who, W)).rejects.toThrow(NotFoundException)
    await expect(s.activity(who, W)).rejects.toThrow(NotFoundException)
    await expect(s.suggest(who, W, 'a fund')).rejects.toThrow(NotFoundException)
    await expect(s.setLists(who, W, ['x'])).rejects.toThrow(NotFoundException)
    await expect(s.addMember(who, W, invite)).rejects.toThrow(NotFoundException)
    await expect(s.setRole(who, W, 'u-bookkeeper-ws-1', 'owner')).rejects.toThrow(NotFoundException)
    await expect(s.removeMember(who, W, 'u-bookkeeper-ws-1')).rejects.toThrow(NotFoundException)
    for (const w of writes) expect(w).not.toHaveBeenCalled()
    expect(log.entries).toEqual([])
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

  it("logs each change to people and lists in the screen's words", async () => {
    const { service: s, prisma, log } = service()
    const owner = member('owner')
    await s.setLists(owner, W, ['Youth Fund'])
    await s.suggest(member('bookkeeper'), W, 'Call Jordan Sample about the fund')
    await s.addMember(owner, W, { ...invite, displayName: 'Jules' })
    await s.setRole(owner, W, 'u-bookkeeper-ws-1', 'owner')
    // The count fake says everyone is the last owner; here the person removed is not one.
    prisma.membership.count.mockResolvedValueOnce(0)
    await s.removeMember(owner, W, 'u-bookkeeper-ws-1')
    await s.create(admin(), newWorkspace)
    expect(log.entries.map((e) => [e.workspaceId, e.resource, e.action, e.description])).toEqual([
      [W, 'workspace', 'update', 'Changed the sources of funds'],
      [W, 'workspace', 'create', 'Suggested an addition to the lists'],
      [W, 'member', 'create', 'Invited jules@example.org as auditor'],
      [W, 'member', 'update', 'Changed the role of dana@example.org from bookkeeper to owner'],
      [W, 'member', 'delete', 'Removed dana@example.org from the workspace'],
      [
        W,
        'workspace',
        'create',
        'Created the workspace Riverbend Youth Services with first owner pat@example.org (by a platform admin)',
      ],
    ])
    expect(log.entries.map((e) => e.changes)).toEqual([
      [{ field: 'Sources of funds', before: null, after: 'Youth Fund' }],
      [{ field: 'Suggestion' }],
      [{ field: 'Role', after: 'Auditor' }],
      [{ field: 'Role', before: 'Bookkeeper', after: 'Owner' }],
      [{ field: 'Role', before: 'Bookkeeper' }],
      undefined,
    ])
    // People are named by email: the display names given (Jules) or on file (Dana, Sam) never appear.
    expectNoneOf(log.entries, ['Jordan', 'Jules', 'Dana', 'Sam', 'Pat'])
  })

  it('lets only a platform admin create a workspace: a member, an owner included, gets 403', async () => {
    const { service: s, writes, log } = service()
    for (const who of [member('owner'), member('bookkeeper'), stranger()])
      await expect(s.create(who, newWorkspace)).rejects.toThrow(ForbiddenException)
    for (const w of writes) expect(w).not.toHaveBeenCalled()
    expect(log.entries).toEqual([])
  })

  it('creates the workspace, its first owner and its line in one change, and accepts no Terms for it', async () => {
    const { service: s, prisma, log } = service()
    await expect(s.create(admin(), { ...newWorkspace, name: ' ' })).rejects.toThrow(
      BadRequestException
    )
    await expect(s.create(admin(), { ...newWorkspace, ownerEmail: 'nope' })).rejects.toThrow(
      BadRequestException
    )
    const contexts: unknown[] = []
    prisma.user.create.mockImplementation(async ({ data }: { data: { id: string } }) => {
      contexts.push(tenantContext())
      return data
    })
    const made = await withTenantContext(() => s.create(admin(), newWorkspace), {
      userId: 'u-admin',
      admin: true,
    })
    // No Terms on file: the first owner's acceptance is recorded later (MeController).
    expect(prisma.workspace.create).toHaveBeenCalledWith({
      data: { name: 'Riverbend Youth Services', fundingSources: expect.any(Array) },
    })
    expect(made.termsAcceptedAt).toBeNull()
    // The owner has not signed in: an invitation's placeholder, made under the admin's own flag, not as system.
    expect(prisma.user.create).toHaveBeenCalledWith({
      data: {
        id: expect.stringMatching(/^pending-/),
        email: 'pat@example.org',
        displayName: 'Pat',
      },
    })
    expect(contexts).toEqual([{ userId: 'u-admin', admin: true }])
    expect(prisma.membership.create).toHaveBeenCalledWith({
      data: { userId: expect.stringMatching(/^pending-/), workspaceId: W, role: 'owner' },
    })
    expect(log.change).toHaveBeenCalledTimes(1)
    expect(log.trusted).not.toHaveBeenCalled()
    expect(log.actors).toEqual([admin()])
    expect(log.entries).toEqual([
      {
        workspaceId: W,
        resource: 'workspace',
        subjectId: W,
        action: 'create',
        description:
          'Created the workspace Riverbend Youth Services with first owner pat@example.org (by a platform admin)',
      },
    ])
    // A failed line is a failed create (the real `change` rolls the workspace back).
    log.change.mockRejectedValueOnce(new Error('log down'))
    await expect(s.create(admin(), newWorkspace)).rejects.toThrow('log down')
  })

  it('names an owner who has signed in before by their own account', async () => {
    const { service: s, prisma } = service()
    prisma.user.findFirst.mockResolvedValue({ id: 'user_pat', email: 'pat@example.org' })
    await s.create(admin(), newWorkspace)
    expect(prisma.user.create).not.toHaveBeenCalled()
    expect(prisma.membership.create).toHaveBeenCalledWith({
      data: { userId: 'user_pat', workspaceId: W, role: 'owner' },
    })
  })

  it("lets the platform admin run any workspace's people and lists, with every rule and line kept", async () => {
    const { service: s, prisma, log } = service()
    const a = admin()
    expect((await s.adminList(a)).map((w) => [w.name, w.memberCount])).toEqual([
      ['Riverbend Youth Services', 2],
    ])
    const detail = await s.adminGet(a, W)
    expect(detail.members.map((m) => m.email)).toEqual(['sam@example.org', 'dana@example.org'])
    expect(detail).not.toHaveProperty('engagementCount')
    await s.setLists(a, W, ['Youth Fund'])
    await withTenantContext(() => s.addMember(a, W, invite), { userId: 'u-admin', admin: true })
    await s.setRole(a, W, 'u-bookkeeper-ws-1', 'owner')
    // Keep an owner holds for the admin too.
    await expect(s.removeMember(a, W, 'u-owner-ws-1')).rejects.toThrow(BadRequestException)
    // Every line the admin leaves says a platform admin did it.
    expect(log.entries.map((e) => e.description)).toEqual([
      'Changed the sources of funds (by a platform admin)',
      'Invited jules@example.org as auditor (by a platform admin)',
      'Changed the role of dana@example.org from bookkeeper to owner (by a platform admin)',
    ])
    expect(log.actors).toEqual([a, a, a])
    // Nothing below the workspace is asked for.
    expect(prisma.dataAccessLog.findMany).not.toHaveBeenCalled()
    expect(prisma.engagement.findMany).not.toHaveBeenCalled()
    expect(prisma.engagement.count).not.toHaveBeenCalled()
  })

  it('gives the admin flag nothing of the access log or suggestions, and a non-admin no admin view', async () => {
    const { service: s, prisma } = service()
    await expect(s.activity(admin(), W)).rejects.toThrow(ForbiddenException)
    await expect(s.suggest(admin(), W, 'a fund')).rejects.toThrow(ForbiddenException)
    expect(prisma.dataAccessLog.findMany).not.toHaveBeenCalled()
    await expect(s.adminList(member('owner'))).rejects.toThrow(ForbiddenException)
    await expect(s.adminGet(member('owner'), W)).rejects.toThrow(ForbiddenException)
  })

  it('keeps an admin who is a member to their member rights on the member routes', async () => {
    const { service: s, writes } = service()
    // CallerService.load (every route but the admin ones) never sets `admin`.
    const both = admin({ admin: undefined, ...member('auditor') })
    await expect(s.setLists(both, W, ['x'])).rejects.toThrow(ForbiddenException)
    await expect(s.addMember(both, W, invite)).rejects.toThrow(ForbiddenException)
    await expect(s.get(both, OTHER)).rejects.toThrow(NotFoundException)
    for (const w of writes) expect(w).not.toHaveBeenCalled()
  })

  describe('the platform admin seating themself', () => {
    /** The fixture's membership lookup says the admin is not in the workspace yet. */
    const notYetIn = (prisma: ReturnType<typeof service>['prisma']) =>
      prisma.membership.findFirst.mockImplementation(async ({ where }) =>
        where.userId === 'u-admin' || where.userId.startsWith('pending-')
          ? null
          : {
              id: 'm-1',
              role: 'bookkeeper',
              user: { displayName: 'Dana', email: 'dana@example.org' },
            }
      )

    it('seats the admin as themself when the address is a second verified one of theirs, and says so', async () => {
      const { service: s, prisma, log, clerk } = service()
      notYetIn(prisma)
      clerk.verifiedEmails.mockResolvedValue(['admin@example.org', 'admin.work@example.org'])
      await s.addMember(admin(), W, { email: ' Admin.Work@example.org ', role: 'owner' })
      expect(clerk.verifiedEmails).toHaveBeenCalledWith('u-admin')
      expect(prisma.user.create).not.toHaveBeenCalled()
      expect(prisma.membership.create).toHaveBeenCalledWith({
        data: { userId: 'u-admin', workspaceId: W, role: 'owner' },
      })
      expect(log.entries.map((e) => [e.subjectId, e.description])).toEqual([
        ['u-admin', 'admin@example.org (platform admin) added themself as owner'],
      ])
    })

    it('knows the address on the admin’s own account without asking Clerk', async () => {
      const { service: s, prisma, log, clerk } = service()
      notYetIn(prisma)
      await s.addMember(admin(), W, { email: 'admin@example.org', role: 'auditor' })
      expect(clerk.verifiedEmails).not.toHaveBeenCalled()
      expect(log.entries[0]?.description).toBe(
        'admin@example.org (platform admin) added themself as auditor'
      )
    })

    it('creates a workspace with the admin as its first owner, themself', async () => {
      const { service: s, prisma, log, clerk } = service()
      clerk.verifiedEmails.mockResolvedValue(['admin.work@example.org'])
      await s.create(admin(), {
        name: 'Riverbend Youth Services',
        ownerEmail: 'admin.work@example.org',
      })
      expect(prisma.user.create).not.toHaveBeenCalled()
      expect(prisma.membership.create).toHaveBeenCalledWith({
        data: { userId: 'u-admin', workspaceId: W, role: 'owner' },
      })
      expect(log.entries.map((e) => e.description)).toEqual([
        'Created the workspace Riverbend Youth Services with admin@example.org (platform admin) as its first owner, themself',
      ])
    })

    it('says so when the admin changes their own role', async () => {
      const { service: s, log } = service()
      const a = admin({ userId: 'u-bookkeeper-ws-1' })
      await s.setRole(a, W, 'u-bookkeeper-ws-1', 'owner')
      expect(log.entries.map((e) => e.description)).toEqual([
        'admin@example.org (platform admin) changed their own role from bookkeeper to owner',
      ])
    })

    it("never asks Clerk on an owner's invitation, and writes the owner's line unmarked", async () => {
      const { service: s, clerk, log } = service()
      await s.addMember(member('owner'), W, invite)
      expect(clerk.verifiedEmails).not.toHaveBeenCalled()
      expect(log.entries.map((e) => e.description)).toEqual([
        'Invited jules@example.org as auditor',
      ])
    })
  })

  it("makes the admin's placeholder inside the change, so a refused invitation leaves none unlogged", async () => {
    const { service: s, prisma, log } = service()
    // The placeholder is made, then the person turns out to be in the workspace already.
    prisma.membership.findFirst.mockResolvedValue({ id: 'm-x', role: 'auditor' } as never)
    await expect(s.addMember(admin(), W, invite)).rejects.toThrow('already in this workspace')
    // Inside the change (the fake's outer client refuses writes then), so the real one rolls it back.
    expect(prisma.user.create).toHaveBeenCalledTimes(1)
    expect(log.change.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.user.create.mock.invocationCallOrder[0]!
    )
    expect(prisma.membership.create).not.toHaveBeenCalled()
    expect(log.entries).toEqual([])
  })

  describe('renaming a workspace', () => {
    it('lets an owner rename theirs, trimmed, with the line in the words of the screen', async () => {
      const { service: s, prisma, log } = service()
      await s.rename(member('owner'), W, '  Riverbend Youth  ')
      expect(prisma.workspace.update).toHaveBeenCalledWith({
        where: { id: W },
        data: { name: 'Riverbend Youth' },
      })
      expect(log.entries).toEqual([
        {
          workspaceId: W,
          resource: 'workspace',
          subjectId: W,
          action: 'update',
          description: 'Renamed the workspace from Riverbend Youth Services to Riverbend Youth',
          changes: [
            {
              field: 'Workspace name',
              before: 'Riverbend Youth Services',
              after: 'Riverbend Youth',
            },
          ],
        },
      ])
    })

    it('lets the platform admin rename any, marked as theirs', async () => {
      const { service: s, log } = service()
      await s.rename(admin(), W, 'Harbor Youth')
      expect(log.entries.map((e) => e.description)).toEqual([
        'Renamed the workspace from Riverbend Youth Services to Harbor Youth (by a platform admin)',
      ])
    })

    it('needs a name of at most 120 characters, and writes nothing when it is unchanged', async () => {
      const { service: s, prisma } = service()
      const owner = member('owner')
      for (const bad of ['', '   ', 'x'.repeat(121), 42, null])
        await expect(s.rename(owner, W, bad)).rejects.toThrow(BadRequestException)
      await s.rename(owner, W, 'x'.repeat(120))
      await s.rename(owner, W, ' Riverbend Youth Services ')
      expect(prisma.workspace.update).toHaveBeenCalledTimes(1)
    })

    it('refuses a bookkeeper or auditor (403) and a stranger (404)', async () => {
      const { service: s, prisma } = service()
      await expect(s.rename(member('bookkeeper'), W, 'x')).rejects.toThrow(ForbiddenException)
      await expect(s.rename(member('auditor'), W, 'x')).rejects.toThrow(ForbiddenException)
      await expect(s.rename(stranger(), W, 'x')).rejects.toThrow(NotFoundException)
      expect(prisma.workspace.update).not.toHaveBeenCalled()
    })
  })
})
