import type { StatementLine } from '@ad/types'
import {
  amountOn,
  lineDates,
  paymentChoices,
  paymentsOfBills,
  type PlanStatement,
} from './books-payments'
import type { PlanBill } from './books-receipts'

const line = (text: string, y = 0, page = 1): StatementLine => ({
  page,
  x: 40,
  y,
  width: 500,
  height: 10,
  text,
})
const statement = (id: string, card: boolean, texts: string[]): PlanStatement => ({
  id,
  fileName: `${id}.pdf`,
  card,
  lines: texts.map((t, i) => line(t, 700 - i * 12)),
})
const bill = (
  transactionId: string,
  amount: number,
  date: string,
  paidFrom: PlanBill['paidFrom'] = 'bank'
): PlanBill => ({ transactionId, amount, date, vendor: 'PayPeople', paidFrom })

const BANK = statement('bank', false, [
  '09/03 ACH DEBIT PAYPEOPLE FEE 200.00 10,550.00',
  '09/12 ACH DEBIT PAYPEOPLE FEE 75.50 10,474.50',
  '09/20 ACH DEBIT HILLTOP 300.00 10,174.50',
  '09/21 ACH DEBIT HILLTOP 300.00 9,874.50',
])
const CARD = statement('card', true, [
  '09/05/2026 PIXEL TOOLS CLASSROOM PLAN 80.00',
  '09/10/2026 MORGAN LEE AUTOPAY PAYMENT RECEIVED -200.00',
])

describe("the payments of the books' bills (owner's decision, 2026-11-12)", () => {
  it('reads the dates a statement line prints, a month and day alone in the year nearest the bill', () => {
    expect(lineDates('09/03 ACH DEBIT 200.00', '2026-09-01')).toEqual(['2026-09-03'])
    expect(lineDates('09/05/2026 PIXEL TOOLS 80.00', '2026-09-01')).toEqual(['2026-09-05'])
    // A December bill paid in January.
    expect(lineDates('01/02 ACH DEBIT 200.00', '2026-12-30')).toEqual(['2027-01-02'])
  })

  it('reads a few cents as a bank prints them, without the leading zero', () => {
    expect(amountOn(0.73).test('09/14 .73 Corporate ACH')).toBe(true)
    expect(amountOn(0.73).test('09/14 0.73 Corporate ACH')).toBe(true)
    expect(amountOn(0.73).test('09/14 10.73 Corporate ACH')).toBe(false)
    expect(amountOn(0.73).test('09/14 .735 Corporate ACH')).toBe(false)
    expect(amountOn(80).test('PIXEL TOOLS .80')).toBe(false)
  })

  it("matches a bill to the one line of its amount near its date, on the bank's or the card's statements as the books say", () => {
    const found = paymentsOfBills(
      [
        bill('b1', 200, '2026-09-01'),
        bill('b2', 75.5, '2026-09-10'),
        bill('c1', 80, '2026-09-04', 'card'),
      ],
      [BANK, CARD],
      []
    )
    expect(
      Object.fromEntries([...found].map(([id, p]) => [id, [p.documentId, p.line.text, p.by]]))
    ).toEqual({
      b1: ['bank', '09/03 ACH DEBIT PAYPEOPLE FEE 200.00 10,550.00', 'auto'],
      b2: ['bank', '09/12 ACH DEBIT PAYPEOPLE FEE 75.50 10,474.50', 'auto'],
      c1: ['card', '09/05/2026 PIXEL TOOLS CLASSROOM PLAN 80.00', 'auto'],
    })
    // A bank bill is never paid by the card's line, nor a card bill by the bank's.
    expect(paymentsOfBills([bill('c2', 80, '2026-09-04', 'bank')], [BANK, CARD], []).size).toBe(0)
    expect(paymentsOfBills([bill('b3', 200, '2026-09-01', 'card')], [BANK], []).size).toBe(0)
  })

  it('leaves to an owner a bill two lines fit, and one whose line is further than the days allow', () => {
    // Two $300 lines a day apart.
    expect(paymentsOfBills([bill('h1', 300, '2026-09-20')], [BANK], []).size).toBe(0)
    // Eight days from the bill: past the default five, within ten.
    expect(paymentsOfBills([bill('b1', 200, '2026-08-26')], [BANK], []).size).toBe(0)
    expect(paymentsOfBills([bill('b1', 200, '2026-08-26')], [BANK], [], 10).size).toBe(1)
    // The lines to choose from: every line of its amount, the nearest first, not one paying another bill.
    const choices = paymentChoices(bill('h1', 300, '2026-09-21'), [BANK, CARD], new Set())
    expect(choices.map((c) => c.line.text)).toEqual([
      '09/21 ACH DEBIT HILLTOP 300.00 9,874.50',
      '09/20 ACH DEBIT HILLTOP 300.00 10,174.50',
    ])
  })

  it("takes an owner's line first, and a dropped bill takes none", () => {
    const chosen = paymentsOfBills(
      [bill('h1', 300, '2026-09-20'), bill('h2', 300, '2026-09-21')],
      [BANK],
      [
        {
          transactionId: 'h1',
          documentId: null,
          dropped: false,
          payment: { documentId: 'bank', page: 1, text: '09/21 ACH DEBIT HILLTOP 300.00 9,874.50' },
        },
      ]
    )
    // The owner's line goes to h1; the one left fits h2 alone.
    expect(Object.fromEntries([...chosen].map(([id, p]) => [id, [p.line.text, p.by]]))).toEqual({
      h1: ['09/21 ACH DEBIT HILLTOP 300.00 9,874.50', 'person'],
      h2: ['09/20 ACH DEBIT HILLTOP 300.00 10,174.50', 'auto'],
    })
    // A chosen line no longer on the statement (a statement saved again, changed) is no payment.
    expect(
      paymentsOfBills(
        [bill('b1', 200, '2026-09-30')],
        [BANK],
        [
          {
            transactionId: 'b1',
            documentId: null,
            dropped: false,
            payment: { documentId: 'bank', page: 1, text: 'gone' },
          },
        ]
      ).size
    ).toBe(0)
    expect(
      paymentsOfBills(
        [bill('b1', 200, '2026-09-01')],
        [BANK],
        [{ transactionId: 'b1', documentId: null, dropped: true }]
      ).size
    ).toBe(0)
  })
})
