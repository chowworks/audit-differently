import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common'
import { member, stranger, W } from '../core/testing/callers'
import { fakeLog } from '../core/testing/log'
import { PayrollRollupService } from './payroll-rollup.service'

/**
 * Two fictional engagements: Adult IT holds staff pay on Staff Salaries; Youth Jobs on Personnel, and participant pay
 * on Work Experience, with participant payments from October; its August and October are closed, September submitted.
 */
const engagements = () => [
  {
    id: 'e-1',
    name: 'Adult IT',
    budgetLines: [
      { id: 'b-1', name: 'Staff Salaries', reportLine: 'staff-salaries', payroll: ['staff-pay'] },
      { id: 'b-2', name: 'Program Costs', reportLine: 'program-costs', payroll: [] },
    ],
    monthlyReports: [] as { period: string; status: string; _count: { wexPayments: number } }[],
  },
  {
    id: 'e-2',
    name: 'Youth Jobs',
    budgetLines: [
      { id: 'b-3', name: 'Personnel', reportLine: 'staff-salaries', payroll: ['staff-pay'] },
      { id: 'b-4', name: 'Staff Salaries', reportLine: 'program-costs', payroll: [] },
      { id: 'b-5', name: 'Work Experience', reportLine: 'wex', payroll: ['participant-pay'] },
    ],
    monthlyReports: [
      { period: '2026-08', status: 'closed', _count: { wexPayments: 0 } },
      { period: '2026-09', status: 'submitted', _count: { wexPayments: 0 } },
      { period: '2026-10', status: 'closed', _count: { wexPayments: 3 } },
      { period: '2026-11', status: 'draft', _count: { wexPayments: 2 } },
    ],
  },
]

function service() {
  const rows = [
    { name: 'staff-pay', engagementId: null, budgetLineName: 'Staff Salaries', unallowable: false },
    { name: 'staff-pay', engagementId: 'e-2', budgetLineName: 'Personnel', unallowable: false },
  ]
  const prisma = {
    lineAlias: {
      findMany: jest.fn(async () => rows),
      deleteMany: jest.fn(async () => ({ count: 2 })),
      createMany: jest.fn(async () => ({ count: 1 })),
    },
    engagement: { findMany: jest.fn(async () => engagements()) },
  }
  const budget = {
    applyRollup: jest.fn(async (_tx: unknown, _c: unknown, e: { id: string }) =>
      e.id === 'e-2'
        ? {
            changed: true,
            rows: { moved: 2, stayed: 0 },
            backed: [{ id: 'r-9', period: '2026-09', was: 'closed' }],
          }
        : { changed: false, rows: { moved: 0, stayed: 0 }, backed: [] }
    ),
    recheck: jest.fn(async () => undefined),
  }
  const log = fakeLog(prisma)
  return {
    s: new PayrollRollupService(prisma as never, budget as never, log as never),
    prisma,
    budget,
    log,
  }
}

describe('PayrollRollupService', () => {
  it('is kept by owners and bookkeepers only; another workspace is a 404', async () => {
    const { s, prisma } = service()
    await expect(s.list(stranger(), W)).rejects.toThrow(NotFoundException)
    await expect(s.list(member('auditor'), W)).rejects.toThrow(ForbiddenException)
    await expect(
      s.save(member('auditor'), W, 'staff-pay', { every: null, own: [] })
    ).rejects.toThrow(ForbiddenException)
    expect(prisma.lineAlias.deleteMany).not.toHaveBeenCalled()
    expect((await s.list(member('bookkeeper'), W)).entries).toEqual([
      { kind: 'staff-pay', engagementId: null, budgetLineName: 'Staff Salaries' },
      { kind: 'staff-pay', engagementId: 'e-2', budgetLineName: 'Personnel' },
    ])
  })

  it('refuses a kind it does not know and a line no engagement has, every problem at once', async () => {
    const { s } = service()
    await expect(s.preview(member('owner'), W, 'bonus', { every: null, own: [] })).rejects.toThrow(
      NotFoundException
    )
    await expect(
      s.save(member('owner'), W, 'staff-pay', {
        every: 'Mileage',
        own: [{ engagementId: 'e-1', budgetLineName: 'Personnel' }],
      })
    ).rejects.toThrow(
      new BadRequestException(
        'No engagement has a budget line named Mileage. Adult IT has no budget line named Personnel'
      )
    )
  })

  it('lists, before Save, each engagement whose line would change and only the months whose numbers change', async () => {
    const { s } = service()
    // Dropping Youth Jobs' own entry: its Staff Salaries line takes staff pay; Adult IT is unchanged. Staff pay on a
    // closed or submitted month stays where it is, so no month goes back to draft.
    expect(
      await s.preview(member('owner'), W, 'staff-pay', { every: 'staff salaries', own: [] })
    ).toEqual({
      changes: [
        {
          engagementId: 'e-2',
          name: 'Youth Jobs',
          from: 'Personnel',
          to: 'Staff Salaries',
          backToDraft: [],
        },
      ],
    })
    // Participant pay off the budget: from October, the first month with participant payments, it counted there.
    expect(
      await s.preview(member('owner'), W, 'participant-pay', { every: null, own: [] })
    ).toEqual({
      changes: [
        {
          engagementId: 'e-2',
          name: 'Youth Jobs',
          from: 'Work Experience',
          to: null,
          backToDraft: [{ period: '2026-10', was: 'closed' }],
        },
      ],
    })
    // Not on the budget for every engagement: both lose it.
    const none = await s.preview(member('owner'), W, 'staff-pay', { every: null, own: [] })
    expect(none.changes.map((c) => [c.name, c.to])).toEqual([
      ['Adult IT', null],
      ['Youth Jobs', null],
    ])
  })

  it("saves the kind's entries as a whole, puts every engagement in step, and logs it in the screen's words", async () => {
    const { s, prisma, budget, log } = service()
    const saved = await s.save(member('owner'), W, 'staff-pay', {
      every: 'Staff Salaries',
      own: [{ engagementId: 'e-1', budgetLineName: null }],
    })
    expect(prisma.lineAlias.deleteMany).toHaveBeenCalledWith({
      where: { workspaceId: W, list: 'payroll', name: 'staff-pay' },
    })
    expect(prisma.lineAlias.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          engagementId: null,
          budgetLineName: 'Staff Salaries',
          unallowable: false,
        }),
        expect.objectContaining({ engagementId: 'e-1', budgetLineName: null, unallowable: true }),
      ],
    })
    expect(budget.applyRollup).toHaveBeenCalledTimes(2)
    expect(budget.recheck).toHaveBeenCalledWith('e-2')
    expect(saved.backToDraft).toEqual([
      { engagementName: 'Youth Jobs', period: '2026-09', was: 'closed' },
    ])
    expect(log.entries.at(-1)).toMatchObject({
      description: 'Changed where Staff pay goes on the budget',
      changes: expect.arrayContaining([
        { field: 'Staff pay: every engagement', after: 'Staff Salaries' },
        { field: 'Staff pay: Adult IT', after: 'Not on the budget' },
        { field: 'Imported payroll rows moved', after: '2' },
      ]),
    })
  })
})
