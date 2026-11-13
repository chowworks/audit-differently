import {
  accountMappingOf,
  budgetLineOfCategory,
  categoriesOf,
  engagementOfMapping,
} from './account-mapping'

/** A fictional engagement's mapping, laid out as a bookkeeper keeps one: headings, sub-accounts and a contract box. */
const GRID = [
  [
    '',
    'BOOKS CATEGORIES',
    '',
    '',
    'YCP BILLABLE CATEGORIES MAPPED TO BOOKS',
    '',
    'CONTRACT DETAILS',
  ],
  [
    '60000',
    'General and Administrative',
    'THE MAIN HEADER',
    '',
    'ALLOWABLE COST MAPPING',
    '',
    'Agreement Period: 7/01/2026 – 6/30/2027',
  ],
  ['60100', '   Bank Service Charges', 'SUB HEADER', '', '', '', 'BUDGET: $50,000'],
  [
    '60101',
    '      Bank Fees',
    'SUB ACCOUNTS',
    '',
    'INDIRECT COSTS ',
    '',
    'PERSONNEL BUDGET AMOUNT $30,000.00 -----> Salaries',
  ],
  [
    '60301',
    '      Software',
    'SUB ACCOUNTS',
    '',
    'INDIRECT COSTS ',
    '',
    'SUPPLIES BUDGET AMOUNT $500.00 ---> Program Supplies',
  ],
  [
    '',
    '   Total Bank Service Charges',
    'SUB HEADER TOTAL',
    '',
    '',
    '',
    'INDIRECT COSTS BUDGET AMOUNT $4,500.00',
  ],
  ['62104', '   Program Supplies', 'SUB ACCOUNTS', '', 'SUPPLIES '],
  ['62105', '   Program Meals', 'SUB ACCOUNTS'],
  ['63102', '   Salaries - Employees', 'SUB ACCOUNTS', '', 'PERSONNEL'],
]

describe("an account mapping file (owner's decision, 2026-11-09)", () => {
  const m = accountMappingOf(GRID, 'YCP mapping.xlsx')

  it('reads each account and the category it bills to; a heading row and a blank are not billable', () => {
    expect(m.accounts).toEqual({
      '60101': 'INDIRECT COSTS',
      '60301': 'INDIRECT COSTS',
      '62104': 'SUPPLIES',
      '62105': null,
      '63102': 'PERSONNEL',
    })
    expect(categoriesOf(m)).toEqual(['INDIRECT COSTS', 'SUPPLIES', 'PERSONNEL'])
  })

  it('reads the contract box: each category’s budget line and amount, the total and the period', () => {
    expect(m.categories).toEqual([
      { category: 'PERSONNEL', line: 'Salaries', amount: 30000 },
      { category: 'SUPPLIES', line: 'Program Supplies', amount: 500 },
      { category: 'INDIRECT COSTS', line: null, amount: 4500 },
    ])
    expect([m.budget, m.start, m.end]).toEqual([50000, '2026-07-01', '2027-06-30'])
  })

  it('finds its engagement by the contract total and period, or by the initials in its title', () => {
    const e = (id: string, name: string, budgets: number[], start: string | null = null) => ({
      id,
      name,
      number: null,
      code: null,
      periodStart: start,
      periodEnd: start ? '2027-06-30' : null,
      budgets,
    })
    expect(
      engagementOfMapping(m, [
        e('a', 'Adult Bootcamp', [90000]),
        e('y', 'Riverbend Youth', [50000], '2026-07-01'),
      ])?.id
    ).toBe('y')
    expect(
      engagementOfMapping(m, [e('a', 'Adult Bootcamp', [1]), e('y', 'Youth Coding Pathway', [2])])
        ?.id
    ).toBe('y')
    expect(engagementOfMapping(m, [e('a', 'Adult Bootcamp', [1])])).toBeNull()
  })

  it("ties a category to a budget line by the box's line, else its amount, else its own name", () => {
    const lines = [
      { id: 's', name: 'Salaries', amount: 30000 },
      { id: 'p', name: 'Program Supplies', amount: 500 },
      { id: 'i', name: 'Indirect Cost', amount: 9999 },
    ]
    expect(budgetLineOfCategory('PERSONNEL', m, lines)?.id).toBe('s')
    expect(budgetLineOfCategory('SUPPLIES', m, lines)?.id).toBe('p')
    expect(budgetLineOfCategory('INDIRECT COSTS', m, lines)?.id).toBe('i')
    expect(budgetLineOfCategory('TRAVEL', m, lines)).toBeNull()
  })
})
