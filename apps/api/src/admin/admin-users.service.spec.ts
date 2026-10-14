import {
  BadRequestException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common'
import { CLERK_DOWN, ClerkService } from '../auth/clerk.service'
import { AdminUsersService } from './admin-users.service'

const people = {
  user_admin: { id: 'user_admin', email: 'admin@example.org', displayName: 'A', role: 'admin' },
  user_pat: { id: 'user_pat', email: 'pat@example.org', displayName: 'Pat', role: null },
}

function setup() {
  const clerk = {
    getUserSummary: jest.fn(async (id: string) => people[id as keyof typeof people] ?? null),
    setRole: jest.fn().mockResolvedValue(undefined),
    searchUsers: jest.fn().mockResolvedValue([]),
    listAdmins: jest.fn().mockResolvedValue({ admins: [], complete: true }),
  }
  // PlatformRoleChange rows: what a transaction writes is kept only when it commits, as in Postgres.
  const kept: Record<string, unknown>[] = []
  const create = jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
    kept.push(data)
    return data
  })
  const prisma = {
    platformRoleChange: { create, findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const staged: Record<string, unknown>[] = []
      const tx = {
        platformRoleChange: {
          create: async ({ data }: { data: Record<string, unknown> }) => void staged.push(data),
        },
      }
      const out = await fn(tx)
      kept.push(...staged)
      return out
    }),
  }
  const lines: string[] = []
  jest.spyOn(Logger.prototype, 'log').mockImplementation((m: unknown) => void lines.push(String(m)))
  return {
    users: new AdminUsersService(clerk as never, prisma as never),
    clerk,
    prisma,
    kept,
    lines,
  }
}

const admins = (n: number) => ({
  admins: Array.from({ length: n }, (_, i) => ({ id: `user_${i}`, role: 'admin' })),
  complete: true,
})

afterEach(() => jest.restoreAllMocks())

describe('AdminUsersService search', () => {
  const everyone = [
    { id: 'a', email: 'pat@example.org', displayName: 'Pat Lee', role: null },
    { id: 'b', email: 'sam@other.com', displayName: 'Sam', role: null },
    { id: 'c', email: null, displayName: 'Patricia', role: null },
  ]

  it('passes plain text to Clerk unchanged', async () => {
    const { users, clerk } = setup()
    await users.search('  pat ')
    expect(clerk.searchUsers).toHaveBeenCalledWith('pat')
  })

  it('lists up to 100 people for a bare *', async () => {
    const { users, clerk } = setup()
    clerk.searchUsers.mockResolvedValue(everyone)
    expect(await users.search('*')).toEqual(everyone)
    expect(clerk.searchUsers).toHaveBeenCalledWith('', 100)
  })

  it('matches a wildcard pattern against the whole email or name', async () => {
    const { users, clerk } = setup()
    clerk.searchUsers.mockResolvedValue(everyone)
    expect((await users.search('*@example.org')).map((u) => u.id)).toEqual(['a'])
    expect(clerk.searchUsers).toHaveBeenCalledWith('@example.org', 100)
    expect((await users.search('pat*')).map((u) => u.id)).toEqual(['a', 'c'])
    expect((await users.search('PAT*E*')).map((u) => u.id)).toEqual(['a'])
  })

  it('treats every other character literally', async () => {
    const { users, clerk } = setup()
    clerk.searchUsers.mockResolvedValue(everyone)
    expect(await users.search('.*')).toEqual([])
    expect(await users.search('(*')).toEqual([])
  })
})

describe('AdminUsersService', () => {
  it('makes someone an admin, and logs who changed whom, by email', async () => {
    const { users, clerk, lines } = setup()
    expect(await users.setRole('user_admin', 'user_pat', 'admin')).toEqual({
      ...people.user_pat,
      role: 'admin',
    })
    expect(clerk.setRole).toHaveBeenCalledWith('user_pat', 'admin')
    expect(lines).toEqual([
      'admin@example.org changed the platform role of pat@example.org: none -> admin',
    ])
  })

  it('takes it away with null', async () => {
    const { users, clerk, lines } = setup()
    await users.setRole('user_pat', 'user_admin', null)
    expect(clerk.setRole).toHaveBeenCalledWith('user_admin', null)
    expect(lines[0]).toMatch(/admin@example.org: admin -> none$/)
  })

  it.each(['owner', 'institution-admin', 'ADMIN', '', 1, undefined, { role: 'admin' }])(
    'gives no role but admin (refuses %p)',
    async (role) => {
      const { users, clerk } = setup()
      await expect(users.setRole('user_admin', 'user_pat', role)).rejects.toThrow(
        BadRequestException
      )
      expect(clerk.setRole).not.toHaveBeenCalled()
    }
  )

  it('refuses a change to your own role, so the last admin cannot be lost', async () => {
    const { users, clerk } = setup()
    await expect(users.setRole('user_admin', 'user_admin', null)).rejects.toThrow(
      'You cannot change your own role'
    )
    expect(clerk.setRole).not.toHaveBeenCalled()
  })

  it('keeps a row of each change, with who changed whom and the outcome', async () => {
    const { users, kept } = setup()
    await users.setRole('user_admin', 'user_pat', 'admin')
    expect(kept).toEqual([
      {
        actorId: 'user_admin',
        actorEmail: 'admin@example.org',
        targetId: 'user_pat',
        targetEmail: 'pat@example.org',
        oldRole: null,
        newRole: 'admin',
        outcome: 'done',
      },
    ])
  })

  it('keeps a failed row, and no done row, when Clerk does not answer; the admin gets a 503', async () => {
    const { users, clerk, kept } = setup()
    clerk.setRole.mockRejectedValue(new ServiceUnavailableException(CLERK_DOWN))
    await expect(users.setRole('user_admin', 'user_pat', 'admin')).rejects.toThrow(
      ServiceUnavailableException
    )
    expect(kept).toEqual([
      expect.objectContaining({ targetId: 'user_pat', outcome: 'failed', error: CLERK_DOWN }),
    ])
  })

  it('keeps no row for a request refused before Clerk is asked to change anything', async () => {
    const { users, kept } = setup()
    await expect(users.setRole('user_admin', 'user_admin', null)).rejects.toThrow()
    await expect(users.setRole('user_admin', 'user_pat', 'owner')).rejects.toThrow()
    expect(kept).toEqual([])
  })

  it('refuses a 21st admin, and still lets one be taken away at 20', async () => {
    const { users, clerk } = setup()
    clerk.listAdmins.mockResolvedValue(admins(20))
    await expect(users.setRole('user_admin', 'user_pat', 'admin')).rejects.toThrow(
      'There can be at most 20 platform admins'
    )
    expect(clerk.setRole).not.toHaveBeenCalled()
    await users.setRole('user_pat', 'user_admin', null)
    expect(clerk.setRole).toHaveBeenCalledWith('user_admin', null)
    clerk.listAdmins.mockResolvedValue(admins(19))
    await users.setRole('user_admin', 'user_pat', 'admin')
    expect(clerk.setRole).toHaveBeenCalledWith('user_pat', 'admin')
  })

  it('lists the 50 newest changes', async () => {
    const { users, prisma } = setup()
    prisma.platformRoleChange.findMany.mockResolvedValue([
      {
        id: 'c1',
        at: new Date('2026-10-14T10:00:00Z'),
        actorId: 'user_admin',
        actorEmail: 'admin@example.org',
        targetId: 'user_pat',
        targetEmail: 'pat@example.org',
        oldRole: null,
        newRole: 'admin',
        outcome: 'done',
        error: null,
      },
    ])
    expect(await users.changes()).toEqual([
      {
        id: 'c1',
        at: '2026-10-14T10:00:00.000Z',
        actorEmail: 'admin@example.org',
        targetEmail: 'pat@example.org',
        oldRole: null,
        newRole: 'admin',
        outcome: 'done',
        error: null,
      },
    ])
    expect(prisma.platformRoleChange.findMany).toHaveBeenCalledWith({
      orderBy: { at: 'desc' },
      take: 50,
    })
  })

  it('refuses someone Clerk does not know', async () => {
    const { users, clerk } = setup()
    await expect(users.setRole('user_admin', 'user_gone', 'admin')).rejects.toThrow(
      NotFoundException
    )
    expect(clerk.setRole).not.toHaveBeenCalled()
  })
})

describe('ClerkService.setRole', () => {
  it('merges the role into the public metadata, keeping every other key', async () => {
    const clerk = new ClerkService()
    const updateUserMetadata = jest.fn().mockResolvedValue({})
    const updateUser = jest.fn()
    Object.assign(clerk, { client: { users: { updateUserMetadata, updateUser } } })
    await clerk.setRole('user_pat', 'admin')
    await clerk.setRole('user_pat', null)
    // Clerk's updateUserMetadata merges (a null value removes only that key); updateUser would replace it all.
    expect(updateUserMetadata.mock.calls).toEqual([
      ['user_pat', { publicMetadata: { role: 'admin' } }],
      ['user_pat', { publicMetadata: { role: null } }],
    ])
    expect(updateUser).not.toHaveBeenCalled()
  })

  it('reads only admin as a role, and a Clerk failure as none', async () => {
    const clerk = new ClerkService()
    const getUser = jest
      .fn()
      .mockResolvedValueOnce({ publicMetadata: { role: 'admin', theme: 'dark' } })
      .mockResolvedValueOnce({ publicMetadata: { role: 'institution-admin' } })
      .mockRejectedValueOnce(new Error('Clerk down'))
    Object.assign(clerk, { client: { users: { getUser } } })
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    expect(await clerk.getRole('a')).toBe('admin')
    expect(await clerk.getRole('b')).toBeNull()
    expect(await clerk.getRole('c')).toBeNull()
  })
})

describe('ClerkService for the admin tools', () => {
  const clerkWith = (users: Record<string, jest.Mock>) => {
    const clerk = new ClerkService()
    Object.assign(clerk, { client: { users } })
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    return clerk
  }
  const fail = (status?: number) => Object.assign(new Error('Clerk says no'), { status })
  const user = (over: Record<string, unknown> = {}) => ({
    id: 'user_pat',
    firstName: 'Pat',
    lastName: null,
    publicMetadata: {},
    primaryEmailAddressId: 'e1',
    emailAddresses: [
      { id: 'e1', emailAddress: 'pat@example.org', verification: { status: 'unverified' } },
      { id: 'e2', emailAddress: 'Pat.Work@example.org', verification: { status: 'verified' } },
    ],
    ...over,
  })

  it('answers no such person only on a Clerk 404; any other failure is a 503', async () => {
    const getUser = jest
      .fn()
      .mockRejectedValueOnce(fail(404))
      .mockRejectedValueOnce(fail(500))
      .mockRejectedValueOnce(fail())
    const clerk = clerkWith({ getUser })
    expect(await clerk.getUserSummary('a')).toBeNull()
    await expect(clerk.getUserSummary('b')).rejects.toThrow(CLERK_DOWN)
    await expect(clerk.getUserSummary('c')).rejects.toThrow(ServiceUnavailableException)
  })

  it('turns a failed search, admin list or role change into a 503', async () => {
    const clerk = clerkWith({
      getUserList: jest.fn().mockRejectedValue(fail(429)),
      updateUserMetadata: jest.fn().mockRejectedValue(fail(500)),
    })
    await expect(clerk.searchUsers('pat')).rejects.toThrow(CLERK_DOWN)
    await expect(clerk.listAdmins()).rejects.toThrow(ServiceUnavailableException)
    await expect(clerk.setRole('user_pat', 'admin')).rejects.toThrow(ServiceUnavailableException)
  })

  it('shows a person by a verified address only, and lists every verified one', async () => {
    const getUser = jest.fn().mockResolvedValue(user())
    const clerk = clerkWith({
      getUser,
      getUserList: jest.fn().mockResolvedValue({ data: [user(), user({ emailAddresses: [] })] }),
    })
    expect((await clerk.getUserSummary('user_pat'))?.email).toBe('Pat.Work@example.org')
    expect((await clerk.searchUsers('pat')).map((u) => u.email)).toEqual([
      'Pat.Work@example.org',
      null,
    ])
    expect(await clerk.verifiedEmails('user_pat')).toEqual(['pat.work@example.org'])
  })
})
