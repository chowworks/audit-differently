import { onlyStrong, score, suggest, vendorSimilarity } from './match'

/** Scoring a receipt against an expense: amount first, then date, then vendor; strong only on exact amount within 3 days. */
const expense = {
  id: 'x-1',
  amount: 212.18,
  date: '2026-09-02',
  vendor: 'Bright Path Office Supply',
}
const receipt = {
  id: 'd-1',
  amount: 212.18,
  date: '2026-09-02',
  vendor: 'Bright Path Office Supply',
}

describe('vendorSimilarity', () => {
  it('compares the words that name the business, ignoring case, punctuation and LLC-like words', () => {
    expect(vendorSimilarity('Bright Path Office Supply', 'BRIGHT PATH OFFICE SUPPLY, LLC')).toBe(1)
    expect(vendorSimilarity('Bright Path Office', 'Bright Path Office Supply')).toBe(0.75)
    expect(vendorSimilarity('Summit Laptop Rentals', 'Lakeside Transit Co.')).toBe(0)
    expect(vendorSimilarity(null, 'Lakeside Transit Co.')).toBe(0)
  })
})

describe('score', () => {
  it('gives full marks to the same amount, day and vendor, and calls it strong', () => {
    expect(score(receipt, expense)).toEqual({
      documentId: 'd-1',
      expenseId: 'x-1',
      score: 100,
      amount: 'exact',
      daysApart: 0,
      vendor: 1,
      strong: true,
    })
  })

  it('suggests an amount a cent off, but never as strong', () => {
    const s = score({ ...receipt, amount: 212.19 }, expense)
    expect(s?.amount).toBe('within-a-cent')
    expect(s?.score).toBe(90)
    expect(s?.strong).toBe(false)
  })

  it('suggests nothing for another amount or a date more than 7 days away', () => {
    expect(score({ ...receipt, amount: 212.2 }, expense)).toBeNull()
    expect(score({ ...receipt, date: '2026-09-10' }, expense)).toBeNull()
    expect(score({ ...receipt, date: '2026-09-09' }, expense)?.daysApart).toBe(7)
  })

  it('is strong only within 3 days, whatever the vendor', () => {
    expect(score({ ...receipt, date: '2026-09-05', vendor: 'Someone else' }, expense)?.strong).toBe(
      true
    )
    expect(score({ ...receipt, date: '2026-09-06' }, expense)?.strong).toBe(false)
  })

  it('suggests a receipt whose amount was not read on a close date and vendor alone', () => {
    const s = score({ ...receipt, amount: null }, expense)
    expect(s).toMatchObject({ amount: null, score: 50, strong: false })
    expect(score({ ...receipt, amount: null, vendor: 'Someone else' }, expense)).toBeNull()
  })
})

describe('suggest and onlyStrong', () => {
  const twin = { ...expense, id: 'x-2', date: '2026-09-04' }

  it('lists the suggestions best first', () => {
    const list = suggest([receipt], [twin, expense])
    expect(list.map((s) => s.expenseId)).toEqual(['x-1', 'x-2'])
  })

  it('names the one strong candidate, and none when there are two', () => {
    expect(onlyStrong(receipt, [expense, { ...expense, id: 'x-3', amount: 86.25 }])).toBe('x-1')
    expect(onlyStrong(receipt, [expense, twin])).toBeNull()
    expect(onlyStrong({ ...receipt, amount: null }, [expense])).toBeNull()
  })
})
