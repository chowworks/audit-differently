import { workspaceItems } from './workspace-items'

describe("the workspace match's payroll items", () => {
  const d = (iso: string) => new Date(`${iso}T00:00:00Z`)
  const month = (expenses: unknown[]) => ({
    id: 'r-sep',
    period: '2026-09',
    status: 'draft',
    engagementId: 'e-isy',
    engagement: { id: 'e-isy', name: 'In-School Youth Coding Pathway' },
    expenses,
    wexPayments: [
      {
        id: 'w-1',
        grossAmount: 280,
        payPeriodStart: d('2026-09-07'),
        payPeriodEnd: d('2026-09-20'),
        stubDocumentId: null,
        stubTookOver: false,
        participant: { id: 'p-1', displayName: 'Jordan Sample', participantId: '900001' },
        documents: [],
      },
    ],
  })
  const books = {
    id: 'x-books',
    itemNumber: 'RYS-25',
    vendor: 'PayPeople Payroll',
    date: d('2026-09-11'),
    totalCost: 392,
    reportLine: 'participant-wages',
    payrollKind: 'participant-pay',
    payrollKey: null,
    documents: [],
  }
  const setup = (payroll: string[]) => ({
    monthlyReport: { findMany: jest.fn().mockResolvedValue([month([books])]) },
    budgetLine: { findMany: jest.fn().mockResolvedValue([{ engagementId: 'e-isy', payroll }]) },
  })

  it("leaves out a books' payroll row the match covers on its month, and keeps one it doesn't (owner's decision, 2026-10-20)", async () => {
    // The month's payments are the participants' pay on the line that holds it: the books' row is kept for the
    // reconciliation alone, not an item to prove.
    const covered = await workspaceItems(
      setup(['participant-pay']) as never,
      null,
      'w-1',
      '2026-09'
    )
    expect(covered.items.map((i) => i.id)).toEqual(['w-1'])
    // No line holds participant pay: the payments count nowhere, so the books' row still counts and still needs proof.
    const open = await workspaceItems(setup([]) as never, null, 'w-1', '2026-09')
    expect(open.items.map((i) => i.id)).toEqual(['x-books', 'w-1'])
  })
})
