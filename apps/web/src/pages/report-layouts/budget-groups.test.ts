import { describe, expect, it } from 'vitest'
import type { ReportDetail } from '@ad/types'
import { NO_LINE, OTHER_LINE, WEX_LINE, lineGroups } from './budget-groups'

const month = {
  budgetLines: [
    { id: 'salaries', name: 'Staff Salaries' },
    { id: 'program', name: 'Program Costs' },
    { id: 'indirect', name: 'Indirect' },
  ],
} as unknown as ReportDetail

type Row = { id: string; line: string }
const rows: Row[] = [
  { id: 'a', line: 'indirect' },
  { id: 'b', line: 'program' },
  { id: 'c', line: OTHER_LINE },
  { id: 'd', line: WEX_LINE },
  { id: 'e', line: 'program' },
  { id: 'f', line: NO_LINE },
]

describe('lineGroups', () => {
  it("puts what needs a budget line first, then the budget's own order, then participants and alerts", () => {
    const groups = lineGroups(month, rows, rows, (r) => r.line)
    expect(groups.map((g) => g.label)).toEqual([
      'Needs a budget line',
      'Program Costs',
      'Indirect',
      'Work experience payments',
      'Alerts',
    ])
    expect(groups[1]!.rows.map((r) => r.id)).toEqual(['b', 'e'])
  })

  it('leaves out a line with no row shown, and counts every row of a line whatever the filter', () => {
    const shown = rows.filter((r) => r.id !== 'a' && r.id !== 'e')
    const groups = lineGroups(month, shown, rows, (r) => r.line)
    expect(groups.some((g) => g.key === 'indirect')).toBe(false)
    const program = groups.find((g) => g.key === 'program')!
    expect(program.rows).toHaveLength(1)
    expect(program.all).toHaveLength(2)
  })
})
