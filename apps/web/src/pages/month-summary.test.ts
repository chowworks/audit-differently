import { describe, expect, it } from 'vitest'
import type { PayrollReconciliationDto, WorkspacePayrollItemDto } from '@ad/types'
import { payrollSummary } from './month-summary'

const item = (id: string, engagementId: string): WorkspacePayrollItemDto => ({
  target: 'expense',
  id,
  kind: 'staff',
  engagementId,
  engagementName: engagementId === 'e1' ? 'Youth Coding Program' : 'Adult Bootcamp',
  reportId: `r-${engagementId}`,
  period: '2026-09',
  monthStatus: 'draft',
  title: `Expense ${id}`,
  sub: 'Staff Salaries',
  start: '2026-09-17',
  end: '2026-09-17',
  amount: 100,
  proved: [],
})

describe("the Summary step's payroll (owner's decision, 2026-11-13)", () => {
  it('counts the items, those fully proved, the bank pay lines found, and each still missing a proof', () => {
    const a = item('YCP-1', 'e1')
    const b = item('YCP-2', 'e1')
    const c = item('AB-1', 'e2')
    const s = payrollSummary({
      items: [a, b, c].map((i) => ({ item: i, needed: ['timesheet', 'register', 'bank'] })),
      unproved: [{ item: b, missing: ['timesheet'] }],
      pays: [
        { state: 'matched' },
        { state: 'matched' },
        { state: 'not-funded' },
      ] as PayrollReconciliationDto['pays'],
    })
    expect(s).toMatchObject({ items: 3, proved: 2, bankPaid: 2 })
    expect(s.todo).toEqual([
      { title: 'Expense YCP-2', engagementName: 'Youth Coding Program', missing: ['timesheet'] },
    ])
    expect(s.engagements.get('e1')).toEqual({ items: 2, proved: 1 })
    expect(s.engagements.get('e2')).toEqual({ items: 1, proved: 1 })
  })
})
