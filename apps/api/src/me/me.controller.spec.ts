import { expectNoneOf, fakeLog } from '../core/testing/log'
import { tenantContext } from '../core/tenant-context'
import { MeController } from './me.controller'

/**
 * An invited person's first sign-in: the account takes the placeholder's memberships, and each workspace joined
 * leaves a line, written as the person and named by their email. The claim and the lines are one transaction
 * (AccessLogService.trusted; the database spec access-log.db.spec.ts runs it on real Postgres).
 */
function setup(opts: { existing?: unknown; pending?: unknown; email?: string | null } = {}) {
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue(opts.existing ?? null),
      findFirst: jest.fn().mockResolvedValue(opts.pending ?? null),
      delete: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({}),
    },
    membership: {
      create: jest.fn(async ({ data }: { data: Record<string, string> }) => ({
        id: 'm-new',
        ...data,
      })),
      findMany: jest.fn().mockResolvedValue([]),
    },
  }
  const clerk = {
    profile: jest.fn().mockResolvedValue({
      email: opts.email === undefined ? 'pat@example.org' : opts.email,
      displayName: 'Pat Example',
    }),
  }
  const terms = {
    version: 'v1',
    hasAccepted: jest.fn().mockResolvedValue(true),
    hasAcceptedBefore: jest.fn(),
  }
  const log = fakeLog(prisma)
  const contexts: unknown[] = []
  // The real fake, after noting what the claim runs as.
  const trusted = log.trusted.getMockImplementation()!
  log.trusted.mockImplementationOnce(async (...args) => {
    contexts.push(tenantContext())
    return trusted(...args)
  })
  const me = new MeController(prisma as never, clerk as never, terms as never, log as never)
  return { me, prisma, log, contexts }
}

const pending = {
  id: 'pending-1',
  email: 'pat@example.org',
  displayName: 'Pat Example',
  memberships: [
    { workspaceId: 'ws-1', role: 'auditor', workspace: { name: 'Riverbend Youth Services' } },
    { workspaceId: 'ws-2', role: 'bookkeeper', workspace: { name: 'Harbor Tech Collective' } },
  ],
}

describe('MeController: joining a workspace', () => {
  it('logs one line per workspace joined, as the person, named by email', async () => {
    const { me, prisma, log, contexts } = setup({ pending })
    await me.me({ userId: 'user_pat' })
    expect(contexts).toEqual([{ allWorkspaces: true }])
    expect(prisma.user.delete).toHaveBeenCalledWith({ where: { id: 'pending-1' } })
    expect(prisma.membership.create).toHaveBeenCalledTimes(2)
    expect(log.entries).toEqual([
      {
        workspaceId: 'ws-1',
        resource: 'member',
        subjectId: 'user_pat',
        action: 'create',
        description: 'Joined Riverbend Youth Services as auditor',
        changes: [{ field: 'Role', after: 'Auditor' }],
      },
      {
        workspaceId: 'ws-2',
        resource: 'member',
        subjectId: 'user_pat',
        action: 'create',
        description: 'Joined Harbor Tech Collective as bookkeeper',
        changes: [{ field: 'Role', after: 'Bookkeeper' }],
      },
    ])
    expect(log.actors).toEqual([
      { userId: 'user_pat', email: 'pat@example.org' },
      { userId: 'user_pat', email: 'pat@example.org' },
    ])
    expectNoneOf(log.entries, ['Pat Example'])
  })

  it('logs nothing for a first sign-in with no invitation', async () => {
    const { me, prisma, log } = setup()
    await me.me({ userId: 'user_new' })
    expect(prisma.user.create).toHaveBeenCalledWith({
      data: { id: 'user_new', email: 'pat@example.org', displayName: 'Pat Example' },
    })
    expect(log.entries).toEqual([])
  })

  it('fails the sign-in when a line cannot be written (trusted() rolls the claim back)', async () => {
    const { me, log } = setup({ pending })
    log.trusted.mockReset()
    log.trusted.mockRejectedValue(new Error('log down'))
    await expect(me.me({ userId: 'user_pat' })).rejects.toThrow('log down')
  })

  it('does not look again once the person belongs somewhere', async () => {
    const { me, log, prisma } = setup({ existing: { id: 'user_pat', memberships: [{ id: 'm' }] } })
    await me.me({ userId: 'user_pat' })
    expect(log.trusted).not.toHaveBeenCalled()
    expect(prisma.user.findFirst).not.toHaveBeenCalled()
  })
})
