import type { StatementLine } from '@ad/types'
import { isCardStatement } from './card-statement'
import { payLinesOf } from './pay-lines'
import { proofFile } from './payroll-match.service'

/** A file's lines as read. Fictional bank and card. */
const lines = (...texts: string[]): StatementLine[] =>
  texts.map((text, i) => ({ page: 1, x: 0, y: 700 - i * 14, width: 400, height: 12, text }))

const CARD = lines(
  'Business Card  RIVERBEND LEARNING  MORGAN LEE  Closing Date 09/27/26  Next Closing Date 10/28/26',
  'Payment Due Date 10/22/26  New Balance $1,864.55  Minimum Payment Due $40.00',
  '09/12/26*  MORGAN LEE  AUTOPAY PAYMENT RECEIVED - THANK YOU  -$4,201.42',
  '09/17/26  PIXEL TOOLS  $80.00'
)
const BANK = lines(
  'Lakeside Bank  Business Checking  Statement period 09/01/2026 to 09/30/2026',
  'Beginning balance $12,000.00  Ending balance $9,000.00',
  '09/17 4,201.42 Corporate ACH Payroll 00026259013916276',
  '09/18 612.50 Direct Deposit Morgan Lee'
)

describe("a card's statement in the bank statements folder (owner's decision, 2026-11-09)", () => {
  it("is told from a bank's by the words only a card's bill prints", () => {
    expect(isCardStatement(CARD)).toBe(true)
    expect(isCardStatement(BANK)).toBe(false)
    // One such word is not enough: a bank statement may mention a card's new balance in a line.
    expect(isCardStatement(lines(...BANK.map((l) => l.text), 'AMEX new balance paid'))).toBe(false)
    expect(isCardStatement(null)).toBe(false)
  })

  it("is read by payroll as a card's: never a bank line of anyone's pay", () => {
    const file = (l: StatementLine[]) =>
      proofFile({ id: 'f', kind: 'bank-statement', fileName: 'x.pdf', lines: l, items: [] })
    expect(file(CARD).kind).toBe('card-statement')
    expect(payLinesOf(file(CARD))).toEqual([])
    // A bank's statement is read as it always was.
    expect(file(BANK).kind).toBe('bank-statement')
    expect(payLinesOf(file(BANK)).length).toBeGreaterThan(0)
  })
})
