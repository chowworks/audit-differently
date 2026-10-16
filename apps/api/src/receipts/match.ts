import type { MatchSuggestion } from '@ad/types'

/** A receipt as matching sees it: what was read from it. */
export interface ReceiptFacts {
  id: string
  amount: number | null
  /** YYYY-MM-DD */
  date: string | null
  vendor: string | null
}

/** An expense as matching sees it. */
export interface ExpenseFacts {
  id: string
  amount: number
  /** YYYY-MM-DD */
  date: string
  vendor: string
}

/** Days a suggestion may be apart; an automatic match needs 3 or fewer. */
export const SUGGEST_DAYS = 7
export const STRONG_DAYS = 3
/** A suggestion without an amount to compare (none was read) needs date and vendor to score this much. */
const MIN_WITHOUT_AMOUNT = 40

const cents = (n: number) => Math.round(n * 100)

/** Words that say nothing about who the vendor is. */
const NOISE = new Set(['inc', 'llc', 'ltd', 'co', 'corp', 'company', 'the', 'and', 'of', 'demo'])

function words(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !NOISE.has(w))
}

/** How alike two vendor names are, 0 to 1: the share of their words in common ("Bright Path Office" and "Bright Path Office Supply LLC" are 0.75). */
export function vendorSimilarity(a: string | null, b: string | null): number {
  if (!a || !b) return 0
  const x = new Set(words(a))
  const y = new Set(words(b))
  if (!x.size || !y.size) return 0
  let common = 0
  for (const w of x) if (y.has(w)) common++
  return common / Math.max(x.size, y.size)
}

const daysBetween = (a: string, b: string) =>
  Math.round(
    Math.abs(new Date(`${a}T00:00:00Z`).getTime() - new Date(`${b}T00:00:00Z`).getTime()) /
      86_400_000
  )

/**
 * How well a receipt fits an expense, or null when it is no suggestion at all. The amount counts most (50 exact, 40
 * within a cent; another amount is no match), then the date (30 on the day, less each day, nothing past 7 days), then
 * the vendor's name (up to 20). A receipt whose amount could not be read is suggested on date and vendor alone.
 */
export function score(r: ReceiptFacts, e: ExpenseFacts): MatchSuggestion | null {
  let points = 0
  let amount: MatchSuggestion['amount'] = null
  if (r.amount != null) {
    const off = Math.abs(cents(r.amount) - cents(e.amount))
    if (off === 0) amount = 'exact'
    else if (off === 1) amount = 'within-a-cent'
    else return null
    points += amount === 'exact' ? 50 : 40
  }
  let daysApart: number | null = null
  if (r.date) {
    daysApart = daysBetween(r.date, e.date)
    if (daysApart > SUGGEST_DAYS) return null
    points += Math.round((30 * (SUGGEST_DAYS + 1 - daysApart)) / (SUGGEST_DAYS + 1))
  }
  const vendor = vendorSimilarity(r.vendor, e.vendor)
  points += Math.round(20 * vendor)
  if (amount == null && points < MIN_WITHOUT_AMOUNT) return null
  return {
    documentId: r.id,
    expenseId: e.id,
    score: points,
    amount,
    daysApart,
    vendor: Math.round(vendor * 100) / 100,
    strong: amount === 'exact' && daysApart != null && daysApart <= STRONG_DAYS,
  }
}

/** Every suggestion of `receipts` against `expenses`, best first. */
export function suggest(receipts: ReceiptFacts[], expenses: ExpenseFacts[]): MatchSuggestion[] {
  const out: MatchSuggestion[] = []
  for (const r of receipts)
    for (const e of expenses) {
      const s = score(r, e)
      if (s) out.push(s)
    }
  return out.sort((a, b) => b.score - a.score)
}

/** The one expense a receipt may be matched to without a person: its only strong candidate, or none. */
export function onlyStrong(r: ReceiptFacts, expenses: ExpenseFacts[]): string | null {
  const strong = expenses.filter((e) => score(r, e)?.strong)
  return strong.length === 1 ? strong[0]!.id : null
}
