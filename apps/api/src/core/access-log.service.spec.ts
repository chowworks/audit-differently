import { member, OTHER, W } from './testing/callers'
import { fakeLog } from './testing/log'
import { runAsSystem, withTenantContext } from './tenant-context'
import { AccessLogService } from './access-log.service'

/** A change and its line in the access log are one transaction: both happen, or neither. */
function setup() {
  const tx = {
    dataAccessLog: { create: jest.fn() },
    expense: { delete: jest.fn() },
    membership: { create: jest.fn() },
    $executeRaw: jest.fn(),
  }
  const prisma = {
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    dataAccessLog: { create: jest.fn() },
  }
  return { log: new AccessLogService(prisma as never), prisma, tx }
}

const entry = {
  workspaceId: W,
  resource: 'expense' as const,
  subjectId: 'x-1',
  action: 'delete' as const,
  description: 'Removed ledger line RYS-1 from September 2026',
  changes: [{ field: 'Total cost', before: '100.00' }],
}

describe('AccessLogService', () => {
  it('writes the change and its line in the same transaction, as the caller', async () => {
    const { log, prisma, tx } = setup()
    const who = member('bookkeeper')
    tx.expense.delete.mockResolvedValue({ id: 'x-1' })
    const out = await log.change(who, (t) => t.expense.delete({ where: { id: 'x-1' } }), entry)
    expect(out).toEqual({ id: 'x-1' })
    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    expect(prisma.dataAccessLog.create).not.toHaveBeenCalled()
    expect(tx.dataAccessLog.create).toHaveBeenCalledWith({
      data: {
        workspaceId: W,
        actorId: who.userId,
        actorName: 'bookkeeper@ws-1.example.org',
        resource: 'expense',
        subjectId: 'x-1',
        action: 'delete',
        description: entry.description,
        changes: entry.changes,
      },
    })
  })

  it('works the line out from what the change returned', async () => {
    const { log, tx } = setup()
    tx.expense.delete.mockResolvedValue({ id: 'x-9' })
    await log.change(
      member('owner'),
      (t) => t.expense.delete({ where: { id: 'x-9' } }),
      (made) => ({ ...entry, subjectId: made.id, changes: [] })
    )
    expect(tx.dataAccessLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ subjectId: 'x-9', changes: undefined }),
    })
  })

  it('writes no line when the change fails, and fails the change when the line cannot be written', async () => {
    const failed = setup()
    failed.tx.expense.delete.mockRejectedValue(new Error('refused'))
    await expect(
      failed.log.change(member('owner'), (t) => t.expense.delete({ where: { id: 'x-1' } }), entry)
    ).rejects.toThrow('refused')
    expect(failed.tx.dataAccessLog.create).not.toHaveBeenCalled()

    // Thrown inside the transaction, so Postgres rolls the change back with it.
    const unlogged = setup()
    unlogged.tx.dataAccessLog.create.mockRejectedValue(new Error('log down'))
    await expect(
      unlogged.log.change(member('owner'), (t) => t.expense.delete({ where: { id: 'x-1' } }), entry)
    ).rejects.toThrow('log down')
  })

  it('names the person by email, never by display name; by account id when there is no email', async () => {
    const { log, tx } = setup()
    tx.expense.delete.mockResolvedValue({ id: 'x-1' })
    const who = { ...member('owner'), displayName: 'Sam Whitfield' }
    await log.change(who, (t) => t.expense.delete({ where: { id: 'x-1' } }), entry)
    expect(tx.dataAccessLog.create.mock.calls[0][0].data.actorName).toBe('owner@ws-1.example.org')
    expect(JSON.stringify(tx.dataAccessLog.create.mock.calls)).not.toContain('Sam Whitfield')
    const { prisma } = setup()
    await new AccessLogService(prisma as never).log({ ...who, email: null }, entry)
    expect(prisma.dataAccessLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ actorName: who.userId }),
    })
  })

  it('refuses, inside the transaction, a line filed in another workspace than the row written', async () => {
    const { log, tx } = setup()
    tx.expense.delete.mockResolvedValue({ id: 'x-1', workspaceId: OTHER })
    await expect(
      log.change(member('owner'), (t) => t.expense.delete({ where: { id: 'x-1' } }), entry)
    ).rejects.toThrow(/the row written is in ws-2/)
    expect(tx.dataAccessLog.create).not.toHaveBeenCalled()
  })
})

describe('AccessLogService.trusted', () => {
  const line = {
    workspaceId: W,
    resource: 'member' as const,
    action: 'create' as const,
    description: 'Joined Riverbend Youth Services as auditor',
  }

  it('runs only as trusted work', async () => {
    const { log, prisma } = setup()
    await expect(
      log.trusted(
        member('owner'),
        async () => 1,
        () => []
      )
    ).rejects.toThrow(/runAsSystem/)
    await expect(
      withTenantContext(
        () =>
          log.trusted(
            member('owner'),
            async () => 1,
            () => []
          ),
        {
          userId: 'u-1',
        }
      )
    ).rejects.toThrow(/runAsSystem/)
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('writes the work, then the lines as the person, in one transaction', async () => {
    const { log, prisma, tx } = setup()
    const order: string[] = []
    tx.membership.create.mockImplementation(async () => {
      order.push('membership')
      return { workspaceId: W }
    })
    tx.$executeRaw.mockImplementation(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        order.push(`context ${values.join(',') || 'system'}`)
      }
    )
    tx.dataAccessLog.create.mockImplementation(async () => void order.push('line'))
    const who = { userId: 'user_1', email: 'pat@example.org' }
    await runAsSystem(() =>
      log.trusted(
        who,
        async (t, refresh) => {
          await refresh()
          return t.membership.create({ data: {} as never })
        },
        (seat) => [{ ...line, workspaceId: seat.workspaceId }]
      )
    )
    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    expect(order).toEqual(['context system', 'membership', 'context user_1,user_1', 'line'])
    expect(tx.dataAccessLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: W,
        actorId: 'user_1',
        actorName: 'pat@example.org',
        description: line.description,
      }),
    })
  })

  it('fails the work when a line cannot be written', async () => {
    const { log, tx } = setup()
    tx.dataAccessLog.create.mockRejectedValue(new Error('log down'))
    await expect(
      runAsSystem(() =>
        log.trusted(
          { userId: 'user_1', email: 'pat@example.org' },
          async () => 'claimed',
          () => [line]
        )
      )
    ).rejects.toThrow('log down')
  })
})

describe('fakeLog', () => {
  it('fails a change whose write goes through the outer prisma instead of tx', async () => {
    const db = { expense: { delete: jest.fn().mockResolvedValue({ id: 'x-1' }) } }
    const log = fakeLog(db)
    await expect(
      log.change(member('owner'), () => db.expense.delete({ where: { id: 'x-1' } }), entry)
    ).rejects.toThrow(/outer prisma/)
    expect(log.entries).toEqual([])
    await log.change(
      member('owner'),
      (tx) => (tx as typeof db).expense.delete({ where: { id: 'x-1' } }),
      entry
    )
    expect(db.expense.delete).toHaveBeenCalledTimes(1)
    expect(log.entries).toEqual([entry])
    // Outside a change the outer prisma writes as before.
    await db.expense.delete({ where: { id: 'x-1' } })
  })
})
