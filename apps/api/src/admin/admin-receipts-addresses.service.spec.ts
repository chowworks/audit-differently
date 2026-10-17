import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import type { Caller } from '../core/caller'
import { REJECT } from '../inbound/inbound.service'
import { AdminReceiptsAddressesService } from './admin-receipts-addresses.service'

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
  id: 'RA-1',
  address: 'riverbend-old',
  workspaceId: 'W1',
  firstUsedAt: new Date('2026-08-01T12:00:00Z'),
  removedAt: new Date('2026-09-01T12:00:00Z') as Date | null,
  releasedAt: null as Date | null,
  releasedById: null as string | null,
  releasedByEmail: null as string | null,
  ...over,
})

/** `since`: what the aggregate over the kept refused emails answers, per history row. */
function setup(
  rows: ReturnType<typeof row>[],
  since: { id: string; received: number; last: Date | null }[] = [],
  released = 1
) {
  const prisma = {
    receiptsAddress: {
      findMany: jest.fn().mockResolvedValue(rows),
      findFirst: jest.fn(
        async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null
      ),
      updateMany: jest.fn().mockResolvedValue({ count: released }),
    },
    workspace: {
      findMany: jest.fn().mockResolvedValue([{ id: 'W1', name: 'Riverbend Youth' }]),
    },
    $queryRaw: jest.fn(async (q: Prisma.Sql) => {
      const only = q.values.find((v) => typeof v === 'string' && v.startsWith('RA-'))
      return only ? since.filter((s) => s.id === only) : since
    }),
    $transaction: jest.fn(),
  }
  prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn(prisma)
  )
  return { svc: new AdminReceiptsAddressesService(prisma as never), prisma }
}

describe('AdminReceiptsAddressesService', () => {
  const env = { ...process.env }
  beforeEach(() => (process.env.RECEIPTS_DOMAIN = 'receipts.example.org'))
  afterEach(() => (process.env = { ...env }))

  it('refuses anyone but the platform admin', async () => {
    const { svc, prisma } = setup([row()])
    await expect(svc.list(notAdmin)).rejects.toThrow(ForbiddenException)
    await expect(svc.release(notAdmin, 'RA-1', 0)).rejects.toThrow(ForbiddenException)
    expect(prisma.receiptsAddress.findMany).not.toHaveBeenCalled()
    expect(prisma.receiptsAddress.updateMany).not.toHaveBeenCalled()
  })

  it('lists every address with its workspace, dates and emails since removal, worked out in one query', async () => {
    const { svc, prisma } = setup(
      [
        row({ id: 'RA-3', address: 'riverbend-youth', removedAt: null }),
        row({
          id: 'RA-4',
          address: 'riverbend-older',
          releasedAt: new Date('2026-09-15T10:00:00Z'),
          releasedById: 'user_admin',
          releasedByEmail: 'admin@example.org',
        }),
        row(),
        row({ id: 'RA-2', address: 'harbor-old', workspaceId: 'W-gone' }),
      ],
      [{ id: 'RA-1', received: 3, last: new Date('2026-10-01T09:00:00Z') }]
    )
    const out = await svc.list(admin)
    // One aggregate for every row, over the refused emails the webhook keeps, since each removal: never one per row.
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1)
    const q = prisma.$queryRaw.mock.calls[0]![0] as Prisma.Sql
    expect(q.sql).toMatch(/count\(r\."id"\)/)
    expect(q.sql).toMatch(/GROUP BY a\."id"/)
    expect(q.sql).toMatch(/r\."receivedAt" >= a\."removedAt"/)
    expect(q.values).toEqual([REJECT.retired])
    // Previously used and not released first, then the current, then the released.
    expect(out.items.map((i) => i.id)).toEqual(['RA-1', 'RA-2', 'RA-3', 'RA-4'])
    expect(out.items[0]).toEqual({
      id: 'RA-1',
      address: 'riverbend-old',
      email: 'riverbend-old@receipts.example.org',
      workspaceId: 'W1',
      workspaceName: 'Riverbend Youth',
      firstUsedAt: '2026-08-01T12:00:00.000Z',
      removedAt: '2026-09-01T12:00:00.000Z',
      receivedSinceRemoval: 3,
      lastReceivedAt: '2026-10-01T09:00:00.000Z',
      releasedAt: null,
      releasedByEmail: null,
      canRelease: true,
    })
    expect(out.items[1]).toMatchObject({
      workspaceName: null,
      receivedSinceRemoval: 0,
      lastReceivedAt: null,
      canRelease: true,
    })
    expect(out.items[2]).toMatchObject({ removedAt: null, canRelease: false })
    expect(out.items[3]).toMatchObject({
      releasedAt: '2026-09-15T10:00:00.000Z',
      releasedByEmail: 'admin@example.org',
      canRelease: false,
    })
  })

  it('releases a previously used address while its count is what the admin saw, and logs nothing in the workspace', async () => {
    const { svc, prisma } = setup(
      [row()],
      [{ id: 'RA-1', received: 3, last: new Date('2026-10-01T09:00:00Z') }]
    )
    await svc.release(admin, 'RA-1', 3)
    // The count is worked out again inside the transaction, for this row only.
    const counted = prisma.$queryRaw.mock.calls[0]![0] as Prisma.Sql
    expect(counted.values).toEqual([REJECT.retired, 'RA-1'])
    expect(prisma.receiptsAddress.updateMany).toHaveBeenCalledWith({
      where: { id: 'RA-1', removedAt: { not: null }, releasedAt: null },
      data: { releasedAt: expect.any(Date) },
    })
    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    // No access-log service at all: the row itself keeps who released it (set by the database).
    expect(Object.keys(prisma)).not.toContain('dataAccessLog')
  })

  it('refuses when an email arrived since the admin opened the page', async () => {
    const { svc, prisma } = setup(
      [row()],
      [{ id: 'RA-1', received: 4, last: new Date('2026-10-02T09:00:00Z') }]
    )
    await expect(svc.release(admin, 'RA-1', 3)).rejects.toThrow('An email arrived since')
    expect(prisma.receiptsAddress.updateMany).not.toHaveBeenCalled()
  })

  it("never releases a workspace's current address or a released one, and 404s an unknown one", async () => {
    const { svc, prisma } = setup([
      row({ removedAt: null }),
      row({ id: 'RA-2', releasedAt: new Date('2026-09-15T10:00:00Z') }),
    ])
    await expect(svc.release(admin, 'RA-1', 0)).rejects.toThrow(ConflictException)
    await expect(svc.release(admin, 'RA-2', 0)).rejects.toThrow('released already')
    await expect(svc.release(admin, 'RA-x', 0)).rejects.toThrow(NotFoundException)
    expect(prisma.receiptsAddress.updateMany).not.toHaveBeenCalled()
  })

  it('refuses a release with no count seen, and one released or changed a moment ago', async () => {
    const { svc } = setup([row()], [], 0)
    for (const bad of [undefined, -1, 1.5, '0'])
      await expect(svc.release(admin, 'RA-1', bad)).rejects.toThrow(BadRequestException)
    await expect(svc.release(admin, 'RA-1', 0)).rejects.toThrow('changed a moment ago')
  })
})
