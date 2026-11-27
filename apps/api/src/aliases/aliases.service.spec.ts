import type { Prisma } from '@prisma/client'
import type { Caller } from '../core/caller'
import { AliasesService } from './aliases.service'
import type { AliasChoice } from './resolve'

/** A fictional workspace's list kept in memory, with what `learn` asks of the database counted. */
function fakeTx(
  rows: {
    id: string
    engagementId: string | null
    name: string
    budgetLineName: string | null
    unallowable: boolean
  }[]
) {
  const tx = {
    lineAlias: {
      findMany: jest.fn(async () => rows.map((r) => ({ ...r }))),
      createMany: jest.fn(async ({ data }: { data: object[] }) => ({ count: data.length })),
      update: jest.fn(async () => ({})),
      findFirst: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
    },
  }
  return tx
}

describe('AliasesService.learn', () => {
  const service = new AliasesService({} as never, {} as never)
  const caller = { userId: 'u-1' } as Caller

  it('keeps a first big import in one insert, and changes an answer in one update', async () => {
    const tx = fakeTx([
      {
        id: 'a-1',
        engagementId: null,
        name: 'Travel',
        budgetLineName: 'Travel',
        unallowable: false,
      },
    ])
    const choices: AliasChoice[] = Array.from({ length: 400 }, (_, i) => ({
      name: `${60000 + i} Account ${i}`,
      engagementId: 'e-1',
      budgetLineName: 'Program Costs',
    }))
    // Travel answered otherwise on this engagement: its own override, a new row too.
    choices.push({ name: 'Travel', engagementId: 'e-1', budgetLineName: null })
    const n = await service.learn(tx as unknown as Prisma.TransactionClient, caller, 'w-1', choices)
    expect(n).toBe(401)
    expect(tx.lineAlias.createMany).toHaveBeenCalledTimes(1)
    const sent = tx.lineAlias.createMany.mock.calls[0]![0] as {
      data: { name: string; engagementId: string | null }[]
      skipDuplicates: boolean
    }
    expect(sent.data).toHaveLength(401)
    expect(sent.skipDuplicates).toBe(true)
    expect(tx.lineAlias.findFirst).not.toHaveBeenCalled()
    expect(tx.lineAlias.count).not.toHaveBeenCalled()
    expect(tx.lineAlias.update).not.toHaveBeenCalled()
  })

  it('updates a name already on the list instead of adding it again', async () => {
    const tx = fakeTx([
      { id: 'o-1', engagementId: 'e-1', name: 'Meals', budgetLineName: null, unallowable: true },
    ])
    const n = await service.learn(tx as unknown as Prisma.TransactionClient, caller, 'w-1', [
      { name: 'Meals', engagementId: 'e-1', budgetLineName: 'Travel' },
    ])
    expect(n).toBe(1)
    expect(tx.lineAlias.createMany).not.toHaveBeenCalled()
    expect(tx.lineAlias.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'o-1' },
        data: expect.objectContaining({ budgetLineName: 'Travel', unallowable: false }),
      })
    )
  })
})
