import { aliasKey, suggestAliases } from '@ad/types'
import { listOfMappings } from './mapping-names'
import { resolveAlias, writeFor, type AliasRow } from './resolve'

/** A fictional workspace's QuickBooks names list (#132). */
const row = (
  name: string,
  budgetLineName: string | null,
  engagementId: string | null = null
): AliasRow => ({
  id: `${engagementId ?? 'ws'}-${name}`,
  engagementId,
  name,
  budgetLineName,
  unallowable: budgetLineName === null,
})
const LIST = [
  row('60901 Rent Expense', 'Program Costs'),
  row('Salaries & Wages', 'Personnel'),
  row('60901 Rent Expense', 'Facilities', 'e-2'),
  row('Meals', null, 'e-1'),
]
const LINES = [
  { id: 'b-pc', name: 'Program Costs' },
  { id: 'b-p', name: 'Personnel' },
  { id: 'b-tr', name: 'Travel' },
]

describe('the QuickBooks names list', () => {
  it("reads an engagement's override first, then the workspace's entry, then a line of the same name", () => {
    expect(resolveAlias('60901 Rent Expense', 'e-1', LIST, LINES)).toMatchObject({
      status: 'line',
      line: { id: 'b-pc' },
    })
    expect(resolveAlias('60901 rent  expense', 'e-2', LIST, LINES)).toEqual({
      status: 'no-line',
      alias: LIST[2],
      want: 'Facilities',
    })
    expect(resolveAlias('Meals', 'e-1', LIST, LINES).status).toBe('unallowable')
    expect(resolveAlias('Meals', 'e-3', LIST, LINES).status).toBe('unmapped')
    expect(resolveAlias('Travel', 'e-3', LIST, LINES)).toMatchObject({
      status: 'line',
      line: { id: 'b-tr' },
      alias: null,
    })
    // The workspace's line is not on this engagement, but one named as the name is.
    expect(
      resolveAlias('Salaries & Wages', 'e-3', LIST, [{ id: 'b-sw', name: 'Salaries & Wages' }])
    ).toMatchObject({ status: 'line', line: { id: 'b-sw' } })
    // An engagement's own override has no such fallback: it said where it goes.
    expect(
      resolveAlias('60901 Rent Expense', 'e-2', LIST, [{ id: 'b-r', name: '60901 Rent Expense' }])
        .status
    ).toBe('no-line')
    // Names in any script compare by their letters and numbers.
    expect(aliasKey('60901 租金')).not.toBe(aliasKey('60901 工资'))
    expect(aliasKey('—')).toBe('')
    // Nothing is stripped: the name without its number is another name.
    expect(resolveAlias('Rent Expense', 'e-1', LIST, LINES).status).toBe('unmapped')
  })

  it("keeps a new name as the workspace's, and a different choice or Unallowable as that engagement's", () => {
    expect(
      writeFor({ name: 'Supplies', engagementId: 'e-1', budgetLineName: 'Program Costs' }, LIST)
    ).toEqual({
      name: 'Supplies',
      engagementId: null,
      budgetLineName: 'Program Costs',
      unallowable: false,
    })
    expect(
      writeFor({ name: 'Supplies', engagementId: 'e-1', budgetLineName: null }, LIST)
    ).toMatchObject({
      engagementId: 'e-1',
      unallowable: true,
    })
    expect(
      writeFor(
        { name: 'Salaries & Wages', engagementId: 'e-1', budgetLineName: 'Program Costs' },
        LIST
      )
    ).toMatchObject({ engagementId: 'e-1', budgetLineName: 'Program Costs' })
    expect(
      writeFor({ name: 'salaries & wages', engagementId: 'e-1', budgetLineName: 'personnel' }, LIST)
    ).toBeNull()
    expect(writeFor({ name: 'Meals', engagementId: 'e-1', budgetLineName: null }, LIST)).toBeNull()
  })

  it('reads an account with its parents exactly as written first, then by its own part', () => {
    const path = '60000 G&A:60901 Rent Expense'
    // No entry of the whole path: the entry of its own part, as a mapping sheet writes it.
    const byPart = resolveAlias(path, 'e-1', LIST, LINES)
    expect(byPart.status === 'line' && byPart.line.id).toBe('b-pc')
    // An entry of the whole path wins, so two parents with the same child can go to different lines.
    const both = [...LIST, row(path, 'Travel')]
    const exact = resolveAlias(path, 'e-1', both, LINES)
    expect(exact.status === 'line' && exact.line.id).toBe('b-tr')
    expect(resolveAlias('70000 Other:60901 Rent Expense', 'e-1', both, LINES)).toMatchObject({
      status: 'line',
      line: { id: 'b-pc' },
    })
    // A choice for a path the part's entry already says writes nothing; another choice is this engagement's own.
    expect(
      writeFor({ name: path, engagementId: 'e-1', budgetLineName: 'Program Costs' }, LIST)
    ).toBeNull()
    expect(
      writeFor({ name: path, engagementId: 'e-1', budgetLineName: 'Travel' }, LIST)
    ).toMatchObject({ engagementId: 'e-1', name: path, budgetLineName: 'Travel' })
  })

  it('asks "is it the same as one of these?" with names missing from the file first', () => {
    const asked = suggestAliases('Salaries and Wages', LIST, ['60901 Rent Expense'])
    expect(asked).toEqual([
      { name: 'Salaries & Wages', budgetLineName: 'Personnel', unallowable: false },
    ])
    // A shared account number is the same account.
    expect(suggestAliases('60901 Rent', LIST)[0]?.name).toBe('60901 Rent Expense')
    expect(suggestAliases('Bank Fees', LIST)).toEqual([])
    // An engagement's own name, with no workspace entry of it, is offered on that engagement only.
    const own = [...LIST, row('Bank Service Charges', 'Program Costs', 'e-1')]
    expect(suggestAliases('Bank Service Charge', own, [], 'e-1')[0]?.name).toBe(
      'Bank Service Charges'
    )
    expect(suggestAliases('Bank Service Charge', own, [], 'e-2')).toEqual([])
  })

  it("makes the list from account mapping files: the first engagement's lines, the next one's differences", () => {
    const read = (accounts: Record<string, string | null>) => ({
      accounts,
      names: { '60901': 'Rent Expense', '60202': 'Insurance' },
      categories: [{ category: 'PROGRAM COSTS', line: 'Program Costs', amount: 100 }],
    })
    const lines = [{ id: 'b-pc', name: 'Program Costs', amount: 100 }]
    const list = listOfMappings([
      {
        read: read({ '60901': 'PROGRAM COSTS', '60202': null }),
        engagement: { id: 'e-1', budgetLines: lines },
      },
      {
        read: read({ '60901': 'PROGRAM COSTS', '60202': 'PROGRAM COSTS' }),
        engagement: { id: 'e-2', budgetLines: lines },
      },
    ])
    expect(list.map((a) => [a.name, a.engagementId, a.budgetLineName])).toEqual([
      ['60202 Insurance', 'e-1', null],
      ['60901 Rent Expense', null, 'Program Costs'],
      ['60202 Insurance', null, 'Program Costs'],
    ])
  })
})
