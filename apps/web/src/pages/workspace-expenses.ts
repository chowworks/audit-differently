import {
  BOOKS_LINE_STATUSES,
  BOOKS_LINE_STATUS_LABELS,
  type BooksLineDto,
  type BooksLineStatus,
} from '@ad/types'

/** To the cent; a sum that nets to nothing is 0, never -0 (shown as -$0.00). */
const cents = (n: number) => Math.round(n * 100) / 100 + 0

/** The month's books lines on each engagement: its lines, in date order, and their total. */
export function engagementGroups(lines: BooksLineDto[]) {
  const by = new Map<string, { id: string; name: string; lines: BooksLineDto[]; total: number }>()
  for (const l of lines) {
    if ((l.status !== 'billed' && l.status !== 'already-entered') || !l.engagementId) continue
    const g = by.get(l.engagementId) ?? {
      id: l.engagementId,
      name: l.engagementName ?? '',
      lines: [],
      total: 0,
    }
    g.lines.push(l)
    if (l.status === 'billed') g.total = cents(g.total + l.amount)
    by.set(l.engagementId, g)
  }
  return [...by.values()]
    .map((g) => ({ ...g, lines: [...g.lines].sort((a, b) => a.date.localeCompare(b.date)) }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Why the books lines on no engagement are on none: each reason's lines and total, in the statuses' order. */
export function notOnEngagements(lines: BooksLineDto[]) {
  const out: { status: BooksLineStatus; label: string; lines: BooksLineDto[]; total: number }[] = []
  for (const status of BOOKS_LINE_STATUSES) {
    if (status === 'billed' || status === 'already-entered') continue
    const ls = lines.filter((l) => l.status === status)
    if (ls.length)
      out.push({
        status,
        label: BOOKS_LINE_STATUS_LABELS[status],
        lines: ls,
        total: cents(ls.reduce((t, l) => t + l.amount, 0)),
      })
  }
  return out
}

/** What Save would do: lines to add, lines to change. */
export function saveCounts(lines: BooksLineDto[]) {
  const billed = lines.filter((l) => l.status === 'billed')
  return {
    add: billed.filter((l) => !l.saved).length,
    change: billed.filter((l) => l.saved === 'changed').length,
    same: billed.filter((l) => l.saved === 'same').length,
  }
}

/** A line's share as the screen says it: "25.00% of $200.00 (allocation entry 9005)". */
export function shareWords(l: BooksLineDto, money: (n: number) => string) {
  const a = l.allocation
  if (!a) return null
  return a.how === 'entry'
    ? `${a.percent.toFixed(2)}% of ${money(a.total)} (allocation entry ${a.entryId})`
    : `${a.percent.toFixed(2)}% of ${money(a.total)} (split by class)`
}

/**
 * Where a line's money came from, as the screen says it: the bank, a card, or the other account the books booked it
 * from (a prepaid cost booked out of its asset is no payment this month).
 */
export function paidWords(l: BooksLineDto) {
  const f = l.paidFrom
  if (!f) return null
  if (f.kind === 'card') return 'paid from a card'
  if (f.kind === 'bank') return 'paid from the bank'
  return `booked from ${f.account.split(':').pop()!.trim()}`
}
