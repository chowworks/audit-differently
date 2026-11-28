import { payrollPlace } from '@ad/types'

// Where an engagement's payroll lands (payroll budget line items, owner's decisions, 2026-11-27, #138). Fictional lines.
describe('payrollPlace', () => {
  const lines = [
    { name: 'Staff Salaries', reportLine: 'staff-salaries' },
    { name: 'Personnel', reportLine: 'staff-salaries' },
    { name: 'Work-Experience', reportLine: 'wex' },
  ]
  const ws = (kind: 'staff-pay' | 'participant-pay', name: string | null) => ({
    kind,
    engagementId: null,
    budgetLineName: name,
  })
  const at = (entries: Parameters<typeof payrollPlace>[2], kind = 'staff-pay' as const) => {
    const p = payrollPlace(kind, 'e-1', entries, lines)
    return [p.by, p.line?.name ?? null, p.choices.map((l) => l.name)]
  }

  it('takes the one listed name the engagement has, case aside, punctuation kept', () => {
    expect(at([ws('staff-pay', 'staff salaries'), ws('staff-pay', 'Wages')])).toEqual([
      'list',
      'Staff Salaries',
      [],
    ])
    expect(
      payrollPlace('participant-pay', 'e-1', [ws('participant-pay', 'Work Experience')], lines).by
    ).toBe('report-line')
  })

  it('is unclear with two listed names, or two lines on its report line, and on no line meanwhile', () => {
    expect(at([ws('staff-pay', 'Staff Salaries'), ws('staff-pay', 'Personnel')])).toEqual([
      'unclear',
      null,
      ['Staff Salaries', 'Personnel'],
    ])
    expect(at([])).toEqual(['unclear', null, ['Staff Salaries', 'Personnel']])
  })

  it("lets the engagement's own entry win, and the workspace's Not on the budget win over a name", () => {
    const own = { kind: 'staff-pay' as const, engagementId: 'e-1', budgetLineName: 'Personnel' }
    expect(at([ws('staff-pay', 'Staff Salaries'), own])).toEqual(['own', 'Personnel', []])
    expect(at([ws('staff-pay', null)])).toEqual(['nowhere', null, []])
    expect(at([{ ...own, budgetLineName: null }])).toEqual(['own', null, []])
    // Its own line gone: asked again.
    expect(at([{ ...own, budgetLineName: 'Mileage' }])[0]).toBe('unclear')
  })
})
