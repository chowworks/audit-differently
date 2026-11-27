import { namesFileOf } from './names-file'

describe('namesFileOf', () => {
  it('reads each name, where it goes and its engagement, under a header row', () => {
    expect(
      namesFileOf([
        ['Names for the workspace page'],
        ['QuickBooks name', 'Goes to', 'Engagement'],
        ['60901 Rent Expense', 'Program Costs', ''],
        ['Entertainment', 'unallowable', ''],
        ['Travel', 'Travel', 'Youth Works 2026'],
        ['Office supplies', '', ''],
        ['', 'Program Costs', ''],
      ])
    ).toEqual([
      { name: '60901 Rent Expense', goesTo: 'Program Costs', engagement: null },
      { name: 'Entertainment', goesTo: null, engagement: null },
      { name: 'Travel', goesTo: 'Travel', engagement: 'Youth Works 2026' },
      { name: 'Office supplies', goesTo: '', engagement: null },
    ])
  })

  it("reads the sample's own headings", () => {
    expect(
      namesFileOf([
        ['Financial category', 'Maps to budget category', 'Applies to'],
        ['Travel', 'Travel', ''],
      ])
    ).toEqual([{ name: 'Travel', goesTo: 'Travel', engagement: null }])
  })

  it('leaves an account mapping to its own reader', () => {
    expect(
      namesFileOf([
        ['Account', 'Name', 'Budget line'],
        ['60901', 'Rent Expense', 'Program Costs'],
      ])
    ).toBeNull()
  })
})
