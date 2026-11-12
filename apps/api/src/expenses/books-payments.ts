import { DEFAULT_EXPENSE_MATCHING, type StatementLine } from '@ad/types'
import { datesOf } from '../payroll/pay-runs'
import { amountPattern } from '../payroll/statement-lines'
import type { PlanBill, PlanBillChoice } from './books-receipts'

/**
 * The payments of the books' bills (owner's decision, 2026-11-12): each bill behind a books line is paid by one line of
 * the month's bank or card statements (the zip's "Bank & card statements" folder, saved with the month's payroll). A
 * bill the books say a card paid is looked for on the card's statements, one the bank paid on the bank's. Each bill has
 * at most one payment, and each statement line pays at most one bill. Read only: payroll's reading of the same files is
 * its own. Pure.
 */

/** A statement of the month as the expenses read it: its lines, and whether it is a card's. */
export interface PlanStatement {
  id: string
  fileName: string
  card: boolean
  lines: StatementLine[]
}

export interface BillPayment {
  documentId: string
  fileName: string
  card: boolean
  line: StatementLine
  by: 'auto' | 'person'
}

/**
 * A bill's amount as a statement prints it (`amountPattern`, as payroll reads it), and an amount under a dollar
 * without its leading zero too, as a bank prints a few cents (".73" for 0.73).
 */
export function amountOn(amount: number): RegExp {
  const re = amountPattern(amount)
  if (Math.abs(amount) >= 1) return re
  const cents = Math.abs(amount).toFixed(2).slice(1).replace('.', '\\.')
  return new RegExp(`${re.source}|(?<![\\d.,])${cents}(?!\\d)`)
}

/** Statement lines shown to choose from, on a bill with no payment found. */
export const MAX_PAYMENT_CHOICES = 10

const lineKey = (s: PlanStatement, l: StatementLine) =>
  `${s.id}\u0000${l.page}\u0000${l.y}\u0000${l.text}`

const daysApart = (a: string, b: string) =>
  Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000

const iso = (y: number, m: number, d: number) => {
  const t = new Date(Date.UTC(y, m - 1, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d
    ? t.toISOString().slice(0, 10)
    : null
}

/**
 * The dates a statement line prints, near `near`: full dates (09/03/2026, 09/03/26), or a month and day alone (09/03),
 * as statements often print them, in the year that puts it nearest (a December bill paid in January).
 */
export function lineDates(text: string, near: string): string[] {
  const full = datesOf(text)
  if (full.length) return full
  const year = Number(near.slice(0, 4))
  return [...text.matchAll(/(?<![\d/.])(\d{1,2})\/(\d{1,2})(?![\d/])/g)].flatMap((m) => {
    const ds = [year - 1, year, year + 1]
      .map((y) => iso(y, +m[1]!, +m[2]!))
      .filter((d): d is string => !!d)
      .sort((a, b) => daysApart(a, near) - daysApart(b, near))
    return ds.length ? [ds[0]!] : []
  })
}

/** The statements a bill is looked for on: the card's when a card paid it, the bank's when the bank did, else any. */
const sideOf = (b: PlanBill, statements: PlanStatement[]) =>
  statements.filter((s) =>
    b.paidFrom === 'card' ? s.card : b.paidFrom === 'bank' ? !s.card : true
  )

/**
 * The payment of each bill. An owner's choice first (its line, by page and words, still on the statement); then, among
 * the rest, a bill and a statement line are matched when each is the other's only candidate: the line prints the bill's
 * amount and a date within `days` of the bill's. A dropped bill takes none.
 */
export function paymentsOfBills(
  bills: PlanBill[],
  statements: PlanStatement[],
  choices: PlanBillChoice[],
  days: number = DEFAULT_EXPENSE_MATCHING.paymentDays
): Map<string, BillPayment> {
  const out = new Map<string, BillPayment>()
  const used = new Set<string>()
  const chosen = new Map(choices.map((c) => [c.transactionId, c]))
  const byId = new Map(statements.map((s) => [s.id, s]))
  const paid = (s: PlanStatement, line: StatementLine, by: BillPayment['by']): BillPayment => ({
    documentId: s.id,
    fileName: s.fileName,
    card: s.card,
    line,
    by,
  })
  for (const b of bills) {
    const c = chosen.get(b.transactionId)
    if (!c || c.dropped || !c.payment) continue
    const s = byId.get(c.payment.documentId)
    const line = s?.lines.find((l) => l.page === c.payment!.page && l.text === c.payment!.text)
    if (!s || !line || used.has(lineKey(s, line))) continue
    out.set(b.transactionId, paid(s, line, 'person'))
    used.add(lineKey(s, line))
  }
  const fits = (b: PlanBill, l: StatementLine) =>
    amountOn(b.amount).test(l.text) &&
    lineDates(l.text, b.date).some((d) => daysApart(d, b.date) <= days)
  const open = () =>
    bills.filter((b) => !out.has(b.transactionId) && !chosen.get(b.transactionId)?.dropped)
  const candidates = (b: PlanBill) =>
    sideOf(b, statements).flatMap((s) =>
      s.lines.filter((l) => !used.has(lineKey(s, l)) && fits(b, l)).map((line) => ({ s, line }))
    )
  for (let changed = true; changed;) {
    changed = false
    const left = open()
    for (const b of left) {
      const found = candidates(b)
      if (found.length !== 1) continue
      const { s, line } = found[0]!
      const rivals = left.filter(
        (o) => !out.has(o.transactionId) && sideOf(o, [s]).length && fits(o, line)
      )
      if (rivals.length !== 1) continue
      out.set(b.transactionId, paid(s, line, 'auto'))
      used.add(lineKey(s, line))
      changed = true
    }
  }
  return out
}

/**
 * The lines an owner may choose a bill's payment from: every line of the month's statements, the bank's and the
 * card's, that prints its amount, whatever its date, but not one that pays another bill. The nearest in date first.
 */
export function paymentChoices(
  b: PlanBill,
  statements: PlanStatement[],
  taken: Set<string>
): BillPayment[] {
  const re = amountOn(b.amount)
  const away = (l: StatementLine) => {
    const ds = lineDates(l.text, b.date).map((d) => daysApart(d, b.date))
    return ds.length ? Math.min(...ds) : Infinity
  }
  return statements
    .flatMap((s) =>
      s.lines
        .filter((l) => re.test(l.text) && !taken.has(lineKey(s, l)))
        .map((line) => ({ s, line, away: away(line) }))
    )
    .sort((x, y) => x.away - y.away)
    .slice(0, MAX_PAYMENT_CHOICES)
    .map(({ s, line }) => ({
      documentId: s.id,
      fileName: s.fileName,
      card: s.card,
      line,
      by: 'person' as const,
    }))
}

/** The key of a payment's line, to tell which lines pay a bill already. */
export const paymentKey = (p: BillPayment) =>
  `${p.documentId}\u0000${p.line.page}\u0000${p.line.y}\u0000${p.line.text}`
