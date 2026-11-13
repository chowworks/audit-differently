import {
  BOOKS_LINE_STATUSES,
  BOOKS_LINE_STATUS_LABELS,
  type BooksLineDto,
  type BooksLineStatus,
  type WorkspaceExpensesDto,
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

/** What Save would do: lines to add, lines to change, saved lines to remove. */
export function saveCounts(lines: BooksLineDto[], toRemove: WorkspaceExpensesDto['toRemove'] = []) {
  const billed = lines.filter((l) => l.status === 'billed')
  const add = billed.filter((l) => !l.saved).length
  const change = billed.filter((l) => l.saved === 'changed').length
  return {
    add,
    change,
    remove: toRemove.length,
    same: billed.filter((l) => l.saved === 'same').length,
    pending: add + change + toRemove.length,
  }
}

const count = (n: number, one: string) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : `${one}s`}`

/** The Save button's words: "Save expenses (1 change, 1 removal)", or "Expenses saved" when there is nothing to do. */
export function saveLabel(c: ReturnType<typeof saveCounts>) {
  if (!c.pending) return 'Expenses saved'
  const parts = [
    c.add ? count(c.add, 'new line') : null,
    c.change ? count(c.change, 'change') : null,
    c.remove ? count(c.remove, 'removal') : null,
  ].filter(Boolean)
  return `Save expenses (${parts.join(', ')})`
}

/** The month's files that could not be read, as a warning says it. Null when every file was read. */
export function unreadWords(unread: string[]) {
  if (!unread.length) return null
  const names =
    unread.length === 1
      ? unread[0]
      : `${unread.slice(0, -1).join(', ')} and ${unread[unread.length - 1]}`
  return `Could not read ${names}: left out.`
}

/**
 * A line's share as the screen says it, in the books' dollars, never a rate: "$50.00 of $200.00, shared out by
 * allocation entry 9005".
 */
export function shareWords(l: BooksLineDto, money: (n: number) => string) {
  const a = l.allocation
  if (!a) return null
  const booked = l.split?.rows.find((r) => r.mine)?.amount ?? l.amount
  return a.how === 'entry'
    ? `${money(booked)} of ${money(a.total)}, shared out by allocation entry ${a.entryId}`
    : `${money(booked)} of ${money(a.total)}, split by class`
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

/**
 * A line's receipts as the screen says it (owner's decision, 2026-11-12): its bills that have one, of those not
 * dropped. Null on a line with no bills.
 */
export function receiptWords(l: Pick<BooksLineDto, 'bills'>) {
  const kept = l.bills.filter((b) => !b.dropped)
  const dropped = l.bills.length - kept.length
  if (!l.bills.length) return null
  const proved = kept.filter((b) => b.receipt).length
  const words =
    l.bills.length === 1
      ? dropped
        ? 'Dropped: no receipt'
        : proved
          ? 'Receipt'
          : 'No receipt'
      : `${proved} of ${kept.length} bills have a receipt`
  return {
    words: l.bills.length > 1 && dropped ? `${words} (${dropped} dropped)` : words,
    complete: kept.length > 0 && proved === kept.length,
  }
}

/**
 * A line's payments as the screen says it (owner's decision, 2026-11-12): its bills paid by a line of the month's
 * statements, of those not dropped. Null on a line with no bills.
 */
export function paymentWords(l: Pick<BooksLineDto, 'bills'>) {
  const kept = l.bills.filter((b) => !b.dropped)
  if (!l.bills.length || !kept.length) return null
  const paid = kept.filter((b) => b.payment).length
  const words =
    kept.length === 1
      ? paid
        ? 'Paid'
        : 'No payment found'
      : `${paid} of ${kept.length} bills paid`
  return { words, complete: paid === kept.length }
}

/** A statement line as a choice says it: its file, page and words, cut short. */
export function statementLineWords(p: { fileName: string; line: { page: number; text: string } }) {
  const text = p.line.text.replace(/\s+/g, ' ').trim()
  return `${p.fileName}, page ${p.line.page}: ${text.length > 80 ? `${text.slice(0, 79)}…` : text}`
}

/** The month's receipts that prove no bill yet. */
export const unmatchedReceipts = (d: Pick<WorkspaceExpensesDto, 'receipts'>) =>
  d.receipts.filter((r) => !r.transactionIds.length)
