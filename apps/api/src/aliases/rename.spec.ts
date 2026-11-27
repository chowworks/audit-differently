import type { Prisma } from '@prisma/client'
import { carryRename } from './rename'

type Row = {
  id: string
  engagementId: string | null
  name: string
  key: string
  budgetLineName: string | null
  unallowable: boolean
}

/** Just what carryRename asks of the database, over rows kept in memory. */
function fakeTx(rows: Row[], otherLines: string[]) {
  const of = (where: {
    engagementId?: string | null
    key?: string
    OR?: { engagementId: string | null }[]
  }) =>
    rows.filter(
      (r) =>
        (!where.OR || where.OR.some((o) => o.engagementId === r.engagementId)) &&
        (where.engagementId === undefined || r.engagementId === where.engagementId) &&
        (where.key === undefined || r.key === where.key)
    )
  const tx = {
    lineAlias: {
      findMany: jest.fn(async ({ where }: { where: Parameters<typeof of>[0] }) =>
        of(where).map((r) => ({ ...r }))
      ),
      findFirst: jest.fn(
        async ({ where }: { where: Parameters<typeof of>[0] }) => of(where)[0] ?? null
      ),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) =>
        Object.assign(
          rows.find((r) => r.id === where.id)!,
          { budgetLineName: data.budgetLineName }
        )
      ),
      create: jest.fn(async ({ data }: { data: Row }) => {
        rows.push({ ...data, id: `new-${rows.length}` })
      }),
      deleteMany: jest.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
        for (const id of where.id.in)
          rows.splice(
            rows.findIndex((r) => r.id === id),
            1
          )
      }),
    },
    budgetLine: { findMany: jest.fn(async () => otherLines.map((name) => ({ name }))) },
  }
  return tx as unknown as Prisma.TransactionClient
}

const input = (from: string, to: string) => ({
  workspaceId: 'w-1',
  engagementId: 'e-1',
  from,
  to,
  changedById: 'u-1',
})

describe('carryRename', () => {
  it('renaming a line and back leaves only the every-engagement entry', async () => {
    const rows: Row[] = [
      {
        id: 'a-1',
        engagementId: null,
        name: '60100 Salaries',
        key: '60100 salaries',
        budgetLineName: 'Staff Salaries',
        unallowable: false,
      },
    ]
    // Another engagement keeps a line named Staff Salaries, so the entry stays and this engagement gets its own.
    const tx = fakeTx(rows, ['Staff Salaries'])
    await carryRename(tx, input('Staff Salaries', 'Staff Pay'))
    expect(rows.map((r) => [r.engagementId, r.budgetLineName])).toEqual([
      [null, 'Staff Salaries'],
      ['e-1', 'Staff Pay'],
    ])
    await carryRename(tx, input('Staff Pay', 'Staff Salaries'))
    expect(rows.map((r) => [r.engagementId, r.budgetLineName])).toEqual([[null, 'Staff Salaries']])
  })
})
