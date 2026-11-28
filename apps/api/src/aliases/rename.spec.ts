import type { Prisma } from '@prisma/client'
import { carryRename } from './rename'

type Row = {
  id: string
  engagementId: string | null
  list?: string
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
    list?: string
    OR?: { engagementId: string | null }[]
  }) =>
    rows.filter(
      (r) =>
        (!where.OR || where.OR.some((o) => o.engagementId === r.engagementId)) &&
        (where.engagementId === undefined || r.engagementId === where.engagementId) &&
        (where.key === undefined || r.key === where.key) &&
        (where.list === undefined || (r.list ?? 'quickbooks') === where.list)
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
          { budgetLineName: data.budgetLineName },
          data.key ? { key: data.key } : {}
        )
      ),
      create: jest.fn(async ({ data }: { data: Row }) => {
        rows.push({ ...data, id: `new-${rows.length}` })
      }),
      delete: jest.fn(async ({ where }: { where: { id: string } }) => {
        rows.splice(
          rows.findIndex((r) => r.id === where.id),
          1
        )
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

  it('moves a payroll name with its key, and leaves one another engagement has', async () => {
    const payroll = (id: string, line: string, engagementId: string | null = null): Row => ({
      id,
      engagementId,
      list: 'payroll',
      name: 'staff-pay',
      key: engagementId ? 'staff-pay' : `staff-pay|${line.toLowerCase()}`,
      budgetLineName: line,
      unallowable: false,
    })
    // No other engagement has either name: the workspace's name moves, with its key.
    let rows = [payroll('p-1', 'Staff Salaries'), payroll('p-2', 'Personnel')]
    expect(await carryRename(fakeTx(rows, []), input('Staff Salaries', 'Salaries'))).toBe(1)
    expect(rows.map((r) => [r.engagementId, r.budgetLineName, r.key])).toEqual([
      [null, 'Salaries', 'staff-pay|salaries'],
      [null, 'Personnel', 'staff-pay|personnel'],
    ])
    // Renamed to a name already listed: one row stays.
    await carryRename(fakeTx(rows, []), input('Salaries', 'Personnel'))
    expect(rows.map((r) => r.key)).toEqual(['staff-pay|personnel'])
    // Another engagement still has the old name, or has the new one: the list stays, and nothing is added here.
    for (const other of ['Staff Salaries', 'Salaries']) {
      rows = [payroll('p-1', 'Staff Salaries')]
      expect(await carryRename(fakeTx(rows, [other]), input('Staff Salaries', 'Salaries'))).toBe(0)
      expect(rows.map((r) => [r.engagementId, r.budgetLineName])).toEqual([
        [null, 'Staff Salaries'],
      ])
    }
    // The engagement's own entry follows its line, and stays though the list now names it too.
    rows = [payroll('p-1', 'Personnel'), payroll('p-3', 'Staff Salaries', 'e-1')]
    await carryRename(fakeTx(rows, ['Personnel']), input('Staff Salaries', 'Personnel'))
    expect(rows.map((r) => [r.engagementId, r.budgetLineName])).toEqual([
      [null, 'Personnel'],
      ['e-1', 'Personnel'],
    ])
  })
})
