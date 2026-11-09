import type { StatementLine } from '@ad/types'

/**
 * A card's statement, not a bank's (owner's decision, 2026-11-09): the zip's Bank statements folder holds both, and a
 * card's bill names its cardholder on every payment ("MORGAN LEE AUTOPAY PAYMENT RECEIVED"), which payroll must never
 * read as that person's pay leaving the bank. Told by the words only a card's bill prints: two of its closing date, new
 * balance, minimum payment, payment due date and credit limit. Pure.
 */
const SIGNS = [
  /\bclosing date\b/i,
  /\bnew balance\b/i,
  /\bminimum payment\b/i,
  /\bpayment due date\b/i,
  /\bcredit limit\b/i,
]

export function isCardStatement(lines: unknown): boolean {
  if (!Array.isArray(lines)) return false
  const text = (lines as StatementLine[]).map((l) => l?.text ?? '').join('\n')
  return SIGNS.filter((s) => s.test(text)).length >= 2
}
