import { BadRequestException, ForbiddenException } from '@nestjs/common'
import type { Caller } from '../core/caller'
import { AdminMatchStatsService } from './admin-match-stats.service'

const admin: Caller = {
  userId: 'user_admin',
  displayName: 'A',
  email: 'admin@example.org',
  memberships: [],
  workspaceIds: [],
  admin: true,
}

const DAY = 86_400_000
const today = () => {
  const d = new Date()
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}
/** A finished run, fictional: `ago` whole days before today, at noon UTC. */
const stat = (ago: number, over: Record<string, unknown> = {}) => ({
  id: `s-${ago}-${Math.random()}`,
  workspaceId: 'ws-1',
  feature: 'payroll',
  startedById: 'u-book',
  startedByEmail: 'book@example.org',
  startedAt: new Date(today() - ago * DAY + 12 * 3_600_000 - 60_000),
  finishedAt: new Date(today() - ago * DAY + 12 * 3_600_000),
  outcome: 'saved',
  fileCount: 4,
  totalBytes: BigInt(4_000_000),
  readMs: 1200,
  durationMs: 60_000,
  items: 3,
  matched: 2,
  guessed: 1,
  missing: 1,
  failed: 0,
  bankLines: 40,
  workspace: { name: 'Riverbend Training' },
  ...over,
})

function setup(rows: ReturnType<typeof stat>[]) {
  const findMany = jest.fn(async (args: { orderBy?: unknown }) =>
    args.orderBy ? [...rows].sort((a, b) => +b.finishedAt - +a.finishedAt) : rows
  )
  const prisma = { matchRunStat: { findMany } }
  return { s: new AdminMatchStatsService(prisma as never), findMany }
}

describe('AdminMatchStatsService', () => {
  it('gives a day for each day of the period, runs per feature and the match rate, and the newest runs', async () => {
    const { s } = setup([
      stat(0),
      stat(0, { feature: 'receipts', outcome: 'done', matched: 3, guessed: 0, missing: 1 }),
      stat(2, {
        feature: 'emailed-receipts',
        outcome: 'failed',
        matched: 0,
        guessed: 0,
        missing: 0,
      }),
    ])
    const out = await s.list(admin, '30', undefined)
    expect(out.days).toBe(30)
    expect(out.series).toHaveLength(30)
    expect(out.series[29]!.day).toBe(new Date(today()).toISOString().slice(0, 10))
    expect(out.series[29]).toMatchObject({
      runs: { payroll: 1, receipts: 1, 'emailed-receipts': 0 },
      // (2 + 3) found of (4 + 4) looked for.
      matchRate: 5 / 8,
    })
    // A day with runs but nothing to match has no rate, not 0%.
    expect(out.series[27]).toMatchObject({
      runs: { payroll: 0, receipts: 0, 'emailed-receipts': 1 },
      matchRate: null,
    })
    expect(out.series[0]).toMatchObject({ matchRate: null })
    expect(out.totals).toEqual({ runs: 3, files: 12, bytes: 12_000_000, matched: 5, lookedFor: 8 })
    expect(out.rows.map((r) => r.feature)).toEqual(['payroll', 'receipts', 'emailed-receipts'])
    expect(out.rows[0]).toMatchObject({
      workspaceName: 'Riverbend Training',
      startedByEmail: 'book@example.org',
      totalBytes: 4_000_000,
      outcome: 'saved',
    })
  })

  it('reads only the period and the feature asked for', async () => {
    const { s, findMany } = setup([])
    await s.list(admin, '90', 'receipts')
    const where = findMany.mock.calls[0]![0] as unknown as {
      where: { finishedAt: { gte: Date }; feature: string }
    }
    expect(where.where.feature).toBe('receipts')
    expect(where.where.finishedAt.gte.getTime()).toBe(today() - 89 * DAY)
  })

  it('refuses another period or feature, and anyone but a platform admin', async () => {
    const { s } = setup([])
    await expect(s.list(admin, '7', undefined)).rejects.toThrow(BadRequestException)
    await expect(s.list(admin, '30', 'timesheets')).rejects.toThrow(BadRequestException)
    await expect(s.list({ ...admin, admin: false }, '30', undefined)).rejects.toThrow(
      ForbiddenException
    )
  })
})
