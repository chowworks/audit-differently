import { accountNumber, booksTransactions } from './books'

import { BOOKS, rows } from './books.testing'

describe("the books' expenses (owner's decision, 2026-11-09)", () => {
  it('reads the account number of a nested account', () => {
    expect(accountNumber('60000 G&A:60300 Technology:60301 Software and Subscription')).toBe(
      '60301'
    )
    expect(accountNumber('Office Supplies')).toBeNull()
  })

  it('keeps each expense transaction with its lines on expense accounts and where it was paid from', () => {
    const ts = booksTransactions(BOOKS)
    expect(ts.map((t) => t.id)).toEqual(['9002', '9003', '9004', '9005', '9007'])
    const rent = ts[0]!
    expect(rent).toMatchObject({
      date: '2026-09-02',
      type: 'Expense',
      vendor: 'Maple Properties',
      payment: { account: '10000 Lakeside Checking 1234', kind: 'bank' },
    })
    expect(rent.lines.map((l) => [l.accountNo, l.className, l.amount])).toEqual([
      ['60901', 'Youth Coding Program', 600],
      ['60901', 'Adult Bootcamp', 400],
    ])
    expect(ts[1]!.payment).toEqual({ account: '22000 Card:22001 Morgan Lee - Card', kind: 'card' })
  })

  it("leaves out income, a person's pay run (payroll's) and the balance sheet", () => {
    const ts = booksTransactions(BOOKS)
    expect(ts.find((t) => t.id === '9001')).toBeUndefined()
    expect(ts.find((t) => t.id === '9006')).toBeUndefined()
    const prepaid = ts.find((t) => t.id === '9007')!
    expect(prepaid.lines.map((l) => l.accountNo)).toEqual(['60202'])
    expect(prepaid.payment?.kind).toBe('other')
  })

  it('gives nothing for a sheet without an account, amount and date header', () => {
    expect(booksTransactions(rows('Name | Hours', 'Casey Demo | 40'))).toEqual([])
  })
})
