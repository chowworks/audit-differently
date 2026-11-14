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

/**
 * A billed line's proof, as the Expense matching step's columns show it (owner's decision, 2026-11-13): its bills with a
 * receipt and with a payment, of those not dropped, and the books' split on a shared cost. Fully proved when every kept
 * bill has both, and a shared cost has its split: a line with some receipts missing is not proved.
 */
export function lineProof(l: Pick<BooksLineDto, 'bills' | 'allocation' | 'split'>) {
  const kept = l.bills.filter((b) => !b.dropped)
  const receipts = { have: kept.filter((b) => b.receipt).length, of: kept.length }
  const payments = { have: kept.filter((b) => b.payment).length, of: kept.length }
  /** 'none': the line is one bill's whole cost, nothing to share out. */
  const allocation: 'on-file' | 'missing' | 'none' = !l.allocation
    ? 'none'
    : l.split
      ? 'on-file'
      : 'missing'
  return {
    receipts,
    payments,
    allocation,
    proved:
      kept.length > 0 &&
      receipts.have === kept.length &&
      payments.have === kept.length &&
      allocation !== 'missing',
  }
}

/** The month's billed lines, in date order. */
export const billedLines = (lines: BooksLineDto[]) =>
  lines.filter((l) => l.status === 'billed').sort((a, b) => a.date.localeCompare(b.date))

/** "2 of 5 expenses fully proved": the billed lines whose every bill has its receipt and payment. */
export function provedCount(lines: BooksLineDto[]) {
  const billed = billedLines(lines)
  return { proved: billed.filter((l) => lineProof(l).proved).length, total: billed.length }
}

/**
 * The billed lines dated in another month than the one open (owner's decision, 2026-11-13: an upload into the wrong
 * month is said before Save, not found after). Each line is saved on the month of its own date, so these land there.
 */
export function otherMonthLines(lines: BooksLineDto[], period: string) {
  const other = billedLines(lines).filter((l) => l.date.slice(0, 7) !== period)
  return { lines: other, months: [...new Set(other.map((l) => l.date.slice(0, 7)))].sort() }
}

/** A group's lines by budget line, each with its total, in the order first met. */
export function byBudgetLine(lines: BooksLineDto[]) {
  const by = new Map<string, { name: string; lines: BooksLineDto[]; total: number }>()
  for (const l of lines) {
    const name = l.budgetLineName ?? 'No budget line'
    const g = by.get(name) ?? { name, lines: [], total: 0 }
    g.lines.push(l)
    if (l.status === 'billed') g.total = cents(g.total + l.amount)
    by.set(name, g)
  }
  return [...by.values()]
}

/**
 * Nothing for Save to do: every billed line is saved as it is, and nothing saved is to be removed (owner's decision,
 * 2026-11-13: the step says so plainly instead of showing the whole month again as if new).
 */
export function nothingNew(d: Pick<WorkspaceExpensesDto, 'lines' | 'toRemove'>) {
  const c = saveCounts(d.lines, d.toRemove ?? [])
  return c.pending === 0 && c.same > 0
}

/** What the Summary step shows of the month's expenses: what was read, billed and proved. */
export function expenseSummary(d: Pick<WorkspaceExpensesDto, 'lines' | 'receipts'>) {
  const billed = billedLines(d.lines)
  const bills = billed.flatMap((l) => l.bills.filter((b) => !b.dropped))
  const engagements = engagementGroups(d.lines).map((g) => {
    const mine = g.lines.filter((l) => l.status === 'billed')
    const kept = mine.flatMap((l) => l.bills.filter((b) => !b.dropped))
    return {
      id: g.id,
      name: g.name,
      total: g.total,
      lines: mine.length,
      proofShare: kept.length
        ? kept.filter((b) => b.receipt && b.payment).length / kept.length
        : mine.length
          ? 0
          : 1,
    }
  })
  return {
    linesRead: d.lines.length,
    billed: billed.length,
    total: cents(billed.reduce((t, l) => t + l.amount, 0)),
    bills: bills.length,
    withReceipt: bills.filter((b) => b.receipt).length,
    paid: bills.filter((b) => b.payment).length,
    notes: billed.filter((l) => l.split).length,
    proved: billed.filter((l) => lineProof(l).proved).length,
    unmatchedReceipts: unmatchedReceipts(d).length,
    /** The vendors of the lines with a bill still missing its receipt, once each. */
    missingReceipts: [
      ...new Set(
        billed
          .filter((l) => lineProof(l).receipts.have < lineProof(l).receipts.of)
          .map((l) => l.vendor)
      ),
    ],
    unpaid: billed.filter((l) => lineProof(l).payments.have < lineProof(l).payments.of).length,
    engagements,
  }
}

/** One of the month's expense to-dos, as the month page's Actions card lists it. */
export interface ExpenseAction {
  key: string
  text: string
  sub: string
  /** Who it concerns: the engagements of the lines, or the workspace. */
  who: string
  /** What its button does: upload receipts here, or open Expense matching. */
  go: 'upload' | 'open'
  label: string
}

/**
 * The month's expense to-dos for the Actions card (owner's decision, 2026-11-13): expenses not saved yet, bills with
 * no receipt (uploaded right there), bills with no payment found, and receipts matched to no bill. None when the month
 * has no books export.
 */
export function expenseActions(
  d: Pick<WorkspaceExpensesDto, 'file' | 'lines' | 'receipts' | 'toRemove'>
): ExpenseAction[] {
  if (!d.file) return []
  const billed = billedLines(d.lines)
  const whoOf = (ls: BooksLineDto[]) =>
    [...new Set(ls.map((l) => l.engagementName).filter(Boolean))].join(', ') || 'Workspace'
  const out: ExpenseAction[] = []
  const c = saveCounts(d.lines, d.toRemove ?? [])
  if (c.pending)
    out.push({
      key: 'expenses-save',
      text: `${count(c.add + c.change + c.remove, 'expense change')} from the books not saved yet`,
      sub: [
        c.add ? count(c.add, 'new line') : null,
        c.change ? count(c.change, 'changed line') : null,
        c.remove ? count(c.remove, 'line to remove') : null,
      ]
        .filter(Boolean)
        .join(', '),
      who: whoOf(billed.filter((l) => l.saved !== 'same')),
      go: 'open',
      label: 'Review and save',
    })
  const noReceipt = billed.filter((l) => l.bills.some((b) => !b.dropped && !b.receipt))
  const bills = noReceipt.reduce(
    (t, l) => t + l.bills.filter((b) => !b.dropped && !b.receipt).length,
    0
  )
  if (bills)
    out.push({
      key: 'expenses-receipts',
      text: `${count(bills, 'bill')} ${bills === 1 ? 'needs' : 'need'} a receipt`,
      sub: `${[...new Set(noReceipt.map((l) => l.vendor || 'No vendor'))].join(', ')}. Upload them here: each is matched to its bill by amount and date.`,
      who: whoOf(noReceipt),
      go: 'upload',
      label: 'Upload receipts',
    })
  const unpaid = billed.filter((l) => l.bills.some((b) => !b.dropped && !b.payment))
  const unpaidBills = unpaid.reduce(
    (t, l) => t + l.bills.filter((b) => !b.dropped && !b.payment).length,
    0
  )
  if (unpaidBills)
    out.push({
      key: 'expenses-payments',
      text: `${count(unpaidBills, 'bill')} with no payment found`,
      sub: 'Choose the statement line that paid it, or drop the bill.',
      who: whoOf(unpaid),
      go: 'open',
      label: 'Find the payment',
    })
  const loose = unmatchedReceipts(d).length
  if (loose)
    out.push({
      key: 'expenses-loose',
      text: `${count(loose, 'receipt')} matched to no bill`,
      sub: 'Choose the bill each proves, or leave it if it is not for this grant.',
      who: 'Workspace',
      go: 'open',
      label: 'Match them',
    })
  return out
}
