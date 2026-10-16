import { ConflictException, ForbiddenException, Logger, NotFoundException } from '@nestjs/common'
import type { Caller } from '../core/caller'
import { AdminInboundService } from './admin-inbound.service'

const admin: Caller = {
  userId: 'user_admin',
  displayName: 'A',
  email: 'admin@example.org',
  memberships: [],
  workspaceIds: [],
  admin: true,
}
const notAdmin: Caller = { ...admin, admin: false }

const row = (over: Record<string, unknown> = {}) => ({
  id: 'IR-1',
  status: 'failed',
  receivedAt: new Date('2026-10-01T12:00:00Z'),
  toAddress: 'riverbend@receipts.example.org',
  fromAddress: 'sam@example.org',
  subject: 'Receipt CP26',
  workspaceId: null as string | null,
  attempts: 5,
  error: 'The email provider refused the key',
  rejectReason: null as string | null,
  workspace: null as { name: string } | null,
  ...over,
})

function setup(found: ReturnType<typeof row> | null, updated = 1) {
  // What a transaction writes is kept only when it commits, as in Postgres.
  const kept: { updates: unknown[]; lines: unknown[] } = { updates: [], lines: [] }
  const tx = (staged: typeof kept) => ({
    inboundReceipt: {
      updateMany: jest.fn(async (args: unknown) => {
        staged.updates.push(args)
        return { count: updated }
      }),
    },
  })
  const run = async (fn: (t: unknown) => Promise<unknown>, line?: unknown) => {
    const staged = { updates: [] as unknown[], lines: [] as unknown[] }
    const out = await fn(tx(staged))
    if (line) staged.lines.push(line)
    kept.updates.push(...staged.updates)
    kept.lines.push(...staged.lines)
    return out
  }
  const prisma = {
    inboundReceipt: {
      findMany: jest.fn().mockResolvedValue(found ? [found] : []),
      findFirst: jest.fn().mockResolvedValue(found),
    },
    $transaction: jest.fn((fn: (t: unknown) => Promise<unknown>) => run(fn)),
  }
  const log = {
    change: jest.fn((...args: unknown[]) =>
      run(args[1] as (t: unknown) => Promise<unknown>, args[2])
    ),
  }
  const lines: string[] = []
  jest.spyOn(Logger.prototype, 'log').mockImplementation((m: unknown) => void lines.push(String(m)))
  return { svc: new AdminInboundService(prisma as never, log as never), prisma, log, kept, lines }
}

afterEach(() => jest.restoreAllMocks())

describe('AdminInboundService', () => {
  it('refuses anyone but the platform admin', async () => {
    const { svc, prisma } = setup(row())
    await expect(svc.list(notAdmin)).rejects.toThrow(ForbiddenException)
    await expect(svc.runAgain(notAdmin, 'IR-1')).rejects.toThrow(ForbiddenException)
    expect(prisma.inboundReceipt.findMany).not.toHaveBeenCalled()
  })

  it("lists rows with no workspace and a workspace's refused or failed ones, metadata only", async () => {
    const { svc, prisma } = setup(row({ workspaceId: 'W1', workspace: { name: 'Riverbend' } }))
    const out = await svc.list(admin)
    expect(prisma.inboundReceipt.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { OR: [{ workspaceId: null }, { status: { in: ['rejected', 'failed'] } }] },
        orderBy: { receivedAt: 'desc' },
      })
    )
    const select = prisma.inboundReceipt.findMany.mock.calls[0][0].select
    expect(select.documentIds).toBeUndefined()
    expect(select.filedAttachments).toBeUndefined()
    expect(out.items[0]).toMatchObject({ workspaceName: 'Riverbend', canRunAgain: true })
  })

  it('finds no row a rerun may not reach: a workspace row that is not refused or failed is a 404', async () => {
    const { svc, prisma, kept } = setup(null)
    await expect(svc.runAgain(admin, 'IR-filed')).rejects.toThrow(NotFoundException)
    expect(prisma.inboundReceipt.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'IR-filed',
          OR: [{ workspaceId: null }, { status: { in: ['rejected', 'failed'] } }],
        },
      })
    )
    expect(kept.updates).toEqual([])
  })

  it('reruns a failed row with no workspace, with no access-log line, and says so in the API log', async () => {
    const { svc, log, kept, lines } = setup(row())
    const out = await svc.runAgain(admin, 'IR-1')
    expect(out).toMatchObject({ status: 'received', attempts: 0, error: null, reason: null })
    expect(kept.updates).toEqual([
      {
        where: { id: 'IR-1', status: 'failed', workspaceId: null },
        data: expect.objectContaining({ status: 'received', attempts: 0, error: null }),
      },
    ])
    expect(log.change).not.toHaveBeenCalled()
    expect(lines).toEqual([
      'admin@example.org (platform admin) ran emailed receipt IR-1 again (was failed)',
    ])
  })

  it("reruns a workspace's refused row and writes its access-log line in the same transaction", async () => {
    const { svc, kept, log } = setup(
      row({
        status: 'rejected',
        rejectReason: 'not a member',
        workspaceId: 'W1',
        workspace: { name: 'Riverbend' },
      })
    )
    await svc.runAgain(admin, 'IR-1')
    expect(kept.updates).toHaveLength(1)
    // Written first: the database admits the row back in the queue only once its line is there.
    expect(log.change.mock.calls[0][3]).toEqual({ lineFirst: true })
    expect(kept.lines).toEqual([
      expect.objectContaining({
        workspaceId: 'W1',
        subjectId: 'IR-1',
        description: 'Ran an emailed receipt again (by a platform admin)',
      }),
    ])
    // Sender and subject are never in the line.
    expect(JSON.stringify(kept.lines)).not.toMatch(/sam@example.org|CP26/)
  })

  it('keeps neither the rerun nor the line when the worker took the row a moment ago', async () => {
    const { svc, kept } = setup(row({ workspaceId: 'W1', workspace: { name: 'R' } }), 0)
    await expect(svc.runAgain(admin, 'IR-1')).rejects.toThrow(ConflictException)
    expect(kept).toEqual({ updates: [], lines: [] })
  })

  it("does not rerun a workspace's row that is waiting, nor one being worked on", async () => {
    for (const r of [
      row({ status: 'received', workspaceId: 'W1', workspace: { name: 'R' } }),
      row({ status: 'processing' }),
    ]) {
      const { svc, kept } = setup(r)
      await expect(svc.runAgain(admin, 'IR-1')).rejects.toThrow(ConflictException)
      expect(kept.updates).toEqual([])
    }
  })

  it('reruns a row with no workspace that is stuck waiting', async () => {
    const { svc, kept } = setup(row({ status: 'received', attempts: 5 }))
    await svc.runAgain(admin, 'IR-1')
    expect(kept.updates).toHaveLength(1)
  })
})
