import type { PrismaClient } from '@prisma/client'
import { payrollUnclearOf } from './checks.service'

// Which kinds of a month's payroll are blocked for an unclear line (#138): told apart by the line's key, and staff pay
// counted on a matched month of an engagement with staff even when the match wrote no line for it.
describe('payrollUnclearOf', () => {
  // Staff pay and both taxes list two names the engagement has; participant pay is on WEX.
  const entries = [
    ...['staff-pay', 'staff-taxes', 'participant-taxes'].flatMap((k) =>
      ['Staff Salaries', 'Personnel'].map((n) => ({
        name: k,
        engagementId: null,
        budgetLineName: n,
        unallowable: false,
      }))
    ),
    { name: 'participant-pay', engagementId: null, budgetLineName: 'WEX', unallowable: false },
  ]
  const prisma = (staff: number) =>
    ({
      lineAlias: { findMany: jest.fn().mockResolvedValue(entries) },
      staffAssignment: { count: jest.fn().mockResolvedValue(staff) },
    }) as unknown as PrismaClient
  const report = (
    expenses: { payrollKey: string | null; payrollKind: string | null }[],
    payrollMatchedAt: Date | null = null
  ) => ({
    engagementId: 'e-1',
    engagement: {
      name: 'Youth Jobs',
      workspaceId: 'ws-1',
      workspace: { name: 'Riverbend' },
      budgetLines: [
        { name: 'Staff Salaries', reportLine: 'staff-salaries' },
        { name: 'Personnel', reportLine: 'staff-salaries' },
        { name: 'WEX', reportLine: 'wex' },
      ],
    },
    expenses,
    wexPayments: [],
    payrollMatchedAt,
  })
  const labels = async (p: PrismaClient, r: ReturnType<typeof report>) =>
    (await payrollUnclearOf(p, r)).map((u) => u.label)

  it('tells staff pay from staff and participant taxes by the line key', async () => {
    expect(
      await labels(
        prisma(0),
        report([{ payrollKey: 'staff:s1:2026-09-15:taxes', payrollKind: null }])
      )
    ).toEqual(['Staff taxes and benefits'])
    expect(
      await labels(
        prisma(0),
        report([{ payrollKey: 'participants:2026-09-15:taxes', payrollKind: null }])
      )
    ).toEqual(['Participant taxes'])
    expect(
      await labels(
        prisma(0),
        report([{ payrollKey: 'staff:s1:2026-09-15:pay', payrollKind: null }])
      )
    ).toEqual(['Staff pay'])
  })

  it('blocks staff pay on a matched month with staff even when no staff line was written', async () => {
    expect(await labels(prisma(2), report([], new Date('2026-10-01')))).toEqual(['Staff pay'])
    expect(await labels(prisma(0), report([], new Date('2026-10-01')))).toEqual([])
    expect(await labels(prisma(2), report([]))).toEqual([])
  })
})
