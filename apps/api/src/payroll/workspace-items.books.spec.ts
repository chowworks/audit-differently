import { workspaceItems } from './workspace-items'

describe("the workspace match's payroll items, beside the books' expenses (owner's decision, 2026-11-09)", () => {
  const d = (iso: string) => new Date(`${iso}T00:00:00Z`)
  const line = (over: Record<string, unknown>) => ({
    id: 'x',
    itemNumber: 'T-1',
    vendor: 'Fictional Vendor',
    date: d('2026-09-30'),
    totalCost: 50,
    reportLine: 'staff-fringe',
    payrollKind: null,
    payrollKey: null,
    booksKey: null,
    documents: [],
    ...over,
  })
  const prisma = (expenses: unknown[]) => ({
    monthlyReport: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'r-sep',
          period: '2026-09',
          status: 'draft',
          engagementId: 'e-ycp',
          engagement: { id: 'e-ycp', name: 'Youth Coding Pathway' },
          expenses,
          wexPayments: [],
        },
      ]),
    },
    budgetLine: { findMany: jest.fn().mockResolvedValue([]) },
  })

  it('never takes a line Save of the expenses wrote, though it is on a payroll line of the form', async () => {
    const { items } = await workspaceItems(
      prisma([
        line({ id: 'typed' }),
        line({ id: 'from-books', booksKey: '2026-09:9005:63301:youth coding program:1' }),
      ]) as never,
      null,
      'w-1',
      '2026-09'
    )
    expect(items.map((i) => i.id)).toEqual(['typed'])
  })
})
