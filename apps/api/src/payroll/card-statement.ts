import type { StatementLine } from '@ad/types'

/**
 * A card's statement, not a bank's (owner's decision, 2026-11-09): the zip's Bank statements folder holds both, and a
 * card's bill names its cardholder on every payment ("MORGAN LEE AUTOPAY PAYMENT RECEIVED"), which payroll must never
 * read as that person's pay leaving the bank. Told by the words a card's bill prints: two of its closing date, new
 * balance, minimum payment, payment due date and credit limit, one of them a card's alone (minimum payment, payment due
 * date, credit limit). A bank's statement may print a closing date and a new balance; read as a card's, its pay debits
 * would be lost to payroll (review, 2026-11-12). Pure.
 */
const SIGNS = [
  /\bclosing date\b/i,
  /\bnew balance\b/i,
  /\bminimum payment\b/i,
  /\bpayment due date\b/i,
  /\bcredit limit\b/i,
]
/** Words only a card's bill prints. */
const CARD_ONLY = [/\bminimum payment\b/i, /\bpayment due date\b/i, /\bcredit limit\b/i]

export function isCardStatement(lines: unknown): boolean {
  if (!Array.isArray(lines)) return false
  const text = (lines as StatementLine[]).map((l) => l?.text ?? '').join('\n')
  return SIGNS.filter((s) => s.test(text)).length >= 2 && CARD_ONLY.some((s) => s.test(text))
}
