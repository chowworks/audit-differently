import { Logger } from '@nestjs/common'
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
    accept: jest.fn(),
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
  return { me, prisma, log, contexts, terms }
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

/**
 * A workspace a platform admin created has no Terms on file. The first of its owners to have accepted the current
 * Terms is recorded on it, once, at POST /me/terms or at GET /me when they had accepted already.
 */
describe('MeController: the first owner accepts the Terms for a workspace', () => {
  const seat = {
    workspaceId: 'ws-1',
    role: 'owner',
    workspace: { name: 'Riverbend Youth Services', termsAcceptedById: null },
  }
  function owner(opts: { accepted?: boolean; recorded?: boolean } = {}) {
    const s = setup({
      existing: { id: 'user_pat', email: 'pat@example.org', memberships: [{ id: 'm' }] },
    })
    // GET /me's list, and the lookup of the owner's workspaces with no Terms on file.
    s.prisma.membership.findMany.mockResolvedValue(opts.recorded ? [] : [seat])
    const updateMany = jest.fn().mockResolvedValue({ count: 1 })
    Object.assign(s.prisma, { workspace: { updateMany } })
    s.terms.hasAccepted.mockResolvedValue(opts.accepted ?? true)
    return { ...s, updateMany }
  }

  it('records the version, time and person at POST /me/terms, with a line as the owner', async () => {
    const { me, updateMany, log } = owner()
    await me.acceptTerms({ userId: 'user_pat' }, { version: 'v1' })
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'ws-1', termsAcceptedById: null },
      data: {
        termsVersion: 'v1',
        termsAcceptedAt: expect.any(Date),
        termsAcceptedById: 'user_pat',
      },
    })
    expect(log.entries).toEqual([
      {
        workspaceId: 'ws-1',
        resource: 'workspace',
        subjectId: 'ws-1',
        action: 'update',
        description:
          'Accepted the Terms & Conditions as the first owner of Riverbend Youth Services',
      },
    ])
    expect(log.actors).toEqual([{ userId: 'user_pat', email: 'pat@example.org' }])
  })

  it('records it once: another owner first leaves nothing to write and no line', async () => {
    const { me, updateMany, log } = owner()
    updateMany.mockResolvedValue({ count: 0 })
    await me.acceptTerms({ userId: 'user_pat' }, { version: 'v1' })
    expect(log.entries).toEqual([])
  })

  it('writes nothing when every workspace the person owns has its Terms on file', async () => {
    const { me, updateMany, log } = owner({ recorded: true })
    await me.acceptTerms({ userId: 'user_pat' }, { version: 'v1' })
    expect(updateMany).not.toHaveBeenCalled()
    expect(log.entries).toEqual([])
  })

  it('records it at GET /me for an owner who had accepted already, and not before they accept', async () => {
    const accepted = owner()
    await accepted.me.me({ userId: 'user_pat' })
    expect(accepted.updateMany).toHaveBeenCalledTimes(1)
    const not = owner({ accepted: false })
    await not.me.me({ userId: 'user_pat' })
    expect(not.updateMany).not.toHaveBeenCalled()
  })

  it('still answers GET /me when recording the Terms on the workspace fails, and logs it', async () => {
    const { me, updateMany, log } = owner()
    updateMany.mockRejectedValue(new Error('database down'))
    const errors: string[] = []
    jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation((m: unknown) => void errors.push(String(m)))
    const answer = await me.me({ userId: 'user_pat' })
    expect(answer).toEqual(expect.objectContaining({ userId: 'user_pat', termsAccepted: true }))
    expect(log.entries).toEqual([])
    expect(errors).toEqual([expect.stringContaining('database down')])
    jest.restoreAllMocks()
  })
})
