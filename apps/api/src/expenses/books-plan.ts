import {
  DEFAULT_EXPENSE_MATCHING,
  programKey,
  type BooksAllocationDto,
  type BooksBillDto,
  type BooksBillSaved,
  type BooksLineDto,
  type BooksLineStatus,
  type BooksSplitDto,
  type ExpenseMatching,
  type ProgramNames,
} from '@ad/types'
import { isPayrollRow } from '../imports/imports.service'
import { programIn } from '../payroll/payroll-details'
import { budgetLineOfCategory, type AccountMappingRead } from './account-mapping'
import type { BooksLine, BooksTransaction } from './books'
import {
  paymentChoices,
  paymentKey,
  paymentsOfBills,
  type BillPayment,
  type PlanStatement,
} from './books-payments'
import {
  receiptsOfBills,
  type PlanBill,
  type PlanBillChoice,
  type PlanReceipt,
} from './books-receipts'

/**
 * Where each of the month's books lines goes (owner's decision, 2026-11-09): to an engagement by its class (the
 * workspace's program names, as payroll reads them), to a budget line by its account (the engagement's account mapping),
 * and to the month of its date; or why not. A shared cost is one engagement's share: a journal entry that shares out a
 * pool ("Allocation Required" on an account, moved to each program), or a transaction split by class. Pure.
 */

export interface PlanEngagement {
  id: string
  name: string
  /** yyyy-mm-dd */
  periodStart: string | null
  periodEnd: string | null
  budgetLines: { id: string; name: string; amount: number }[]
  months: { period: string; status: string }[]
}

export interface PlanMapping {
  id: string
  engagementId: string | null
  read: AccountMappingRead
  /** An owner's choice of budget line for a category (a line's id, or 'skip': not billed). */
  chosen: Record<string, string>
}

/** An expense line already on an engagement's month. */
export interface PlanExisting {
  id: string
  engagementId: string
  booksKey: string | null
  /** yyyy-mm-dd */
  date: string
  allocatedAmount: number
  totalCost: number
  budgetLineId: string | null
  allocationNote: string | null
  /** The bills Save kept with it (Expense.booksBills); null on a line written before bills were kept. */
  booksBills?: BooksBillSaved[] | null
  /** The split Save kept with it (Expense.booksSplit); null on a line written before splits were kept. */
  booksSplit?: BooksSplitDto | null
}

export const SKIP = 'skip'

const cents = (n: number) => Math.round(n * 100) / 100
const near = (a: number, b: number) => Math.abs(a - b) < 0.015

/** A class that holds a cost until it is shared out: kept apart by the books, never a program of its own. */
const POOL = /\ballocat/i

interface Entry {
  /** The allocation entry's transaction. */
  id: string
  /** yyyy-mm-dd */
  date: string
  account: string
  pool: string
  total: number
  sourceIds: string[]
  /**
   * The sources' pool parts do not come to the entry's total: several entries share one pool's account and no exact
   * split of its bills among them was found, so each keeps them all (`billsOf` then takes a dropped bill's share of what
   * the sources come to, never more than the line).
   */
  loose: boolean
}

/** The pool part of a bill: its lines in the pool's class and on its account. */
const poolPartOf = (t: BooksTransaction, pool: BooksLine) =>
  cents(
    t.lines
      .filter(
        (l) =>
          l.amount > 0 &&
          programKey(l.className) === programKey(pool.className) &&
          (l.accountNo ?? l.account) === (pool.accountNo ?? pool.account)
      )
      .reduce((n, l) => n + l.amount, 0)
  )

/** Steps the search for an exact split of a pool's bills among its entries may take before it gives up. */
const MAX_SPLIT_STEPS = 20_000

const daysApart = (a: string, b: string) =>
  Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000

/**
 * Each entry's own bills, when several entries share out one pool's account in the month (owner's decision,
 * 2026-11-12): the bills whose pool parts come to the entry's total to the cent, each bill to one entry, the bills
 * nearest an entry's date tried first. Null when there is no such split (or the search runs too long).
 */
function splitSources(
  entries: Entry[],
  parts: Map<string, { id: string; date: string; part: number }>
): Map<Entry, string[]> | null {
  let steps = 0
  const out = new Map<Entry, string[]>()
  const toCents = (n: number) => Math.round(n * 100)
  const place = (i: number, free: Set<string>): boolean => {
    if (i === entries.length) return true
    const e = entries[i]!
    const order = [...free]
      .map((id) => parts.get(id)!)
      .sort((a, b) => daysApart(a.date, e.date) - daysApart(b.date, e.date))
    const pick = (k: number, left: number, chosen: string[]): boolean => {
      if (++steps > MAX_SPLIT_STEPS) return false
      if (left === 0 && chosen.length) {
        out.set(e, chosen)
        const rest = new Set([...free].filter((id) => !chosen.includes(id)))
        if (place(i + 1, rest)) return true
      }
      for (let j = k; j < order.length; j++) {
        const c = toCents(order[j]!.part)
        if (c <= left && pick(j + 1, left - c, [...chosen, order[j]!.id])) return true
        if (steps > MAX_SPLIT_STEPS) return false
      }
      return false
    }
    return pick(0, toCents(e.total), [])
  }
  return place(0, new Set(parts.keys())) ? out : null
}

/**
 * The allocation entries of the month: per account, one line taking a pool's class ("Allocation Required") out, the
 * rest giving it to others. A line taken out of a program's own class to another is a reclass, not an entry: its lines
 * are ordinary lines (owner's decision, 2026-11-12).
 */
function entriesOf(transactions: BooksTransaction[]): Map<BooksLine, Entry> {
  const out = new Map<BooksLine, Entry>()
  const byPool = new Map<string, { entry: Entry; pool: BooksLine }[]>()
  for (const t of transactions) {
    const byAccount = new Map<string, BooksLine[]>()
    for (const l of t.lines) byAccount.set(l.account, [...(byAccount.get(l.account) ?? []), l])
    for (const [account, ls] of byAccount) {
      const out1 = ls.filter((l) => l.amount < 0)
      const given = ls.filter((l) => l.amount > 0)
      if (out1.length !== 1 || !given.length || !POOL.test(out1[0]!.className)) continue
      const pool = out1[0]!
      const total = cents(-pool.amount)
      if (!near(cents(given.reduce((s, l) => s + l.amount, 0)), total)) continue
      if (given.some((l) => programKey(l.className) === programKey(pool.className))) continue
      const sourceIds = transactions
        .filter((o) => o.id !== t.id && poolPartOf(o, pool) > 0)
        .map((o) => o.id)
      const entry: Entry = {
        id: t.id,
        date: t.date,
        account,
        pool: pool.className,
        total,
        sourceIds,
        loose: false,
      }
      for (const l of ls) out.set(l, entry)
      const key = `${programKey(pool.className)}\u0000${pool.accountNo ?? pool.account}`
      byPool.set(key, [...(byPool.get(key) ?? []), { entry, pool }])
    }
  }
  // Several entries on one pool's account: each takes its own bills, else each keeps them all, loosely.
  for (const group of byPool.values()) {
    if (group.length < 2) continue
    const entries = group.map((g) => g.entry)
    const byId = new Map(transactions.map((t) => [t.id, t]))
    const ids = [...new Set(entries.flatMap((e) => e.sourceIds))]
    const parts = new Map(
      ids.flatMap((id) => {
        const t = byId.get(id)
        return t ? [[id, { id, date: t.date, part: poolPartOf(t, group[0]!.pool) }] as const] : []
      })
    )
    const split = splitSources(entries, parts)
    for (const e of entries) {
      const own = split?.get(e)
      if (own) e.sourceIds = e.sourceIds.filter((id) => own.includes(id))
      else e.loose = true
    }
  }
  return out
}

/**
 * How the books charge a shared cost to every program: the allocation entry's rows on the pool's account, or the bill's
 * own rows by class, each class's dollars as the books have them, the line's own row marked.
 */
function splitOf(t: BooksTransaction, l: BooksLine, entry: Entry | null): BooksSplitDto {
  const rows = entry ? t.lines.filter((x) => x.account === entry.account && x.amount > 0) : t.lines
  const accounts = new Set(rows.map((x) => x.accountNo ?? x.account))
  return {
    how: entry ? 'entry' : 'split',
    transactionId: t.id,
    date: t.date,
    account: l.account,
    total: cents(rows.reduce((n, x) => n + x.amount, 0)),
    rows: rows.map((x) => ({
      className:
        (x.className || 'No class') + (accounts.size > 1 ? ` (${x.accountNo ?? x.account})` : ''),
      amount: x.amount,
      mine: x === l,
    })),
    less: [],
    billed: l.amount,
    at: (entry ? t.lines.filter((x) => x.account === entry.account) : t.lines).map((x) => ({
      page: x.page,
      row: x.row,
    })),
  }
}

/** Every line of the month: where it goes, or why it goes nowhere. */
export function planBooks(input: {
  period: string
  transactions: BooksTransaction[]
  programs: ProgramNames[]
  engagements: PlanEngagement[]
  mappings: PlanMapping[]
  existing: PlanExisting[]
  /** The month's workspace receipts, and owners' words on bills (owner's decision, 2026-11-12). */
  receipts?: PlanReceipt[]
  choices?: PlanBillChoice[]
  /** The month's bank and card statements, read (owner's decision, 2026-11-12). */
  statements?: PlanStatement[]
  /** The admin's day windows; the defaults without. */
  matching?: ExpenseMatching
}): BooksLineDto[] {
  const { period, transactions, engagements } = input
  const groups = input.programs.map((g, id) => ({ id, names: g.names }))
  // A program's engagement: the one it is linked to, else the one named as it is.
  const engagementOfGroup = (i: number) => {
    const g = input.programs[i]!
    if (g.engagementId) return engagements.find((e) => e.id === g.engagementId) ?? null
    return (
      engagements.find((e) => g.names.some((n) => programKey(n) === programKey(e.name))) ?? null
    )
  }
  const entries = entriesOf(transactions)
  const pooled = new Set(
    [...entries.values()].map((e) => `${programKey(e.pool)}\u0000${e.account}`)
  )
  const byKey = new Map(input.existing.filter((x) => x.booksKey).map((x) => [x.booksKey!, x]))
  // A line is written to the month of its own date, but keyed by the month uploaded: the keys another month's upload
  // saved, by what follows the month (owner's decision, 2026-11-12: overlapping exports bill a line once).
  const afterMonth = (key: string) => key.slice(key.indexOf(':'))
  const elsewhere = new Set(
    input.existing
      .filter((x) => x.booksKey && !x.booksKey.startsWith(`${period}:`))
      .map((x) => afterMonth(x.booksKey!))
  )
  const seen = new Map<string, number>()
  const out: BooksLineDto[] = []
  const shares = new Map<BooksLineDto, Share>()
  for (const t of transactions) {
    const classes = new Set(t.lines.map((l) => programKey(l.className)).filter(Boolean))
    const total = cents(t.lines.reduce((s, l) => s + l.amount, 0))
    for (const l of t.lines) {
      const base = `${period}:${t.id}:${l.accountNo ?? programKey(l.account)}:${programKey(l.className)}`
      const n = (seen.get(base) ?? 0) + 1
      seen.set(base, n)
      const entry = entries.get(l)
      const vendor =
        t.vendor ||
        (entry
          ? [
              ...new Set(
                transactions.filter((o) => entry.sourceIds.includes(o.id)).map((o) => o.vendor)
              ),
            ]
              .filter(Boolean)
              .join(', ')
          : '') ||
        l.description ||
        `${t.type || 'Transaction'} ${t.id}`
      const allocation: BooksAllocationDto | null =
        entry && l.amount > 0
          ? {
              total: entry.total,
              percent: cents((l.amount / entry.total) * 100),
              how: 'entry',
              entryId: entry.id,
              sourceIds: entry.sourceIds,
            }
          : !entry && classes.size > 1 && total > 0
            ? {
                total,
                percent: cents((l.amount / total) * 100),
                how: 'split',
                entryId: null,
                sourceIds: [t.id],
              }
            : null
      const line: BooksLineDto = {
        key: `${base}:${n}`,
        transactionId: t.id,
        date: t.date,
        type: t.type,
        vendor,
        description: l.description || t.description,
        account: l.account,
        accountNo: l.accountNo,
        className: l.className,
        amount: l.amount,
        paidFrom: t.payment,
        status: 'billed',
        engagementId: null,
        engagementName: null,
        category: null,
        budgetLineId: null,
        budgetLineName: null,
        allocation,
        split: allocation ? splitOf(t, l, entry && l.amount > 0 ? entry : null) : null,
        bills: [],
        saved: null,
      }
      out.push(line)
      const set = (status: BooksLineStatus) => (line.status = status)
      const isPool =
        (entry && l.amount < 0) ||
        pooled.has(`${programKey(l.className)}\u0000${l.account}`) ||
        POOL.test(l.className)
      if (isPool) {
        set('allocation-pool')
        continue
      }
      if (isPayrollRow({ accountText: l.account, category: '' })) {
        set('payroll-account')
        continue
      }
      if (l.amount < 0) {
        set('credit')
        continue
      }
      if (!l.className) {
        set('no-class')
        continue
      }
      const g = programIn(l.className, groups)
      if (typeof g !== 'number') {
        set('no-program')
        continue
      }
      const e = engagementOfGroup(g)
      if (!e) {
        set('not-ours')
        continue
      }
      line.engagementId = e.id
      line.engagementName = e.name
      const mapping = input.mappings.find((m) => m.engagementId === e.id)
      if (!mapping) {
        set('no-mapping')
        continue
      }
      const category = l.accountNo ? (mapping.read.accounts[l.accountNo] ?? null) : null
      line.category = category
      if (!category) {
        set('not-billable')
        continue
      }
      const chosen = mapping.chosen[category]
      if (chosen === SKIP) {
        set('not-billable')
        continue
      }
      const budgetLine = chosen
        ? (e.budgetLines.find((b) => b.id === chosen) ?? null)
        : budgetLineOfCategory(category, mapping.read, e.budgetLines)
      if (!budgetLine) {
        set('no-budget-line')
        continue
      }
      line.budgetLineId = budgetLine.id
      line.budgetLineName = budgetLine.name
      if ((e.periodStart && t.date < e.periodStart) || (e.periodEnd && t.date > e.periodEnd)) {
        set('outside-contract')
        continue
      }
      const month = e.months.find((m) => m.period === t.date.slice(0, 7))
      if (month && month.status !== 'draft') {
        set('month-closed')
        continue
      }
      // Saved by another month's upload (an export that overlaps this one's): it stays where it is.
      if (!byKey.has(line.key) && elsewhere.has(afterMonth(line.key))) {
        set('already-entered')
        continue
      }
      // Entered on the month already (typed, or imported from the books before): the same day and amount.
      if (
        !byKey.has(line.key) &&
        input.existing.some(
          (x) =>
            !x.booksKey &&
            x.engagementId === e.id &&
            x.date === t.date &&
            near(x.allocatedAmount, l.amount)
        )
      ) {
        set('already-entered')
        continue
      }
      shares.set(line, { entry: entry && l.amount > 0 ? entry : null, bookedAs: l.amount })
    }
  }
  billsOf(
    shares,
    transactions,
    entries,
    input.receipts ?? [],
    input.choices ?? [],
    input.statements ?? [],
    input.matching ?? DEFAULT_EXPENSE_MATCHING
  )
  for (const line of shares.keys()) {
    const before = byKey.get(line.key)
    if (before) line.saved = sameAs(before, line) ? 'same' : 'changed'
  }
  return out
}

/** A line's share of its bills: of the pool an allocation entry shares out, or of its own transaction. */
interface Share {
  entry: Entry | null
  /** The line's amount in the books, before a bill was dropped. */
  bookedAs: number
}

/** A bill's whole amount: what its lines come to. */
const billOf = (t: BooksTransaction): PlanBill => ({
  transactionId: t.id,
  date: t.date,
  vendor: t.vendor,
  amount: cents(t.lines.reduce((s, l) => s + l.amount, 0)),
  paidFrom: t.payment?.kind ?? 'other',
})

/**
 * Each billed line's bills, with their receipts and payments; a dropped bill's share comes off the line (owner's
 * decision, 2026-11-12), and a line whose every bill is dropped bills nothing. Receipts and statement lines are matched
 * among the bills of every expense of the month (each transaction with a line of cost, all but the allocation entries),
 * not the billed lines' alone, so another program's bill of the same amount is a rival; the billed lines keep theirs.
 */
function billsOf(
  shares: Map<BooksLineDto, Share>,
  transactions: BooksTransaction[],
  entries: Map<BooksLine, Entry>,
  receipts: PlanReceipt[],
  choices: PlanBillChoice[],
  statements: PlanStatement[],
  matching: ExpenseMatching
) {
  const byId = new Map(transactions.map((t) => [t.id, t]))
  const sourcesOf = (line: BooksLineDto, s: Share) =>
    (s.entry ? s.entry.sourceIds : [line.transactionId]).flatMap((id) => byId.get(id) ?? [])
  const bills = new Map<string, PlanBill>()
  for (const [line, s] of shares) for (const t of sourcesOf(line, s)) bills.set(t.id, billOf(t))
  const month = new Map(bills)
  for (const t of transactions)
    if (
      !month.has(t.id) &&
      t.lines.some((l) => l.amount > 0) &&
      !t.lines.every((l) => entries.has(l))
    )
      month.set(t.id, billOf(t))
  const found = receiptsOfBills([...month.values()], receipts, choices, matching.receiptDays)
  const paid = paymentsOfBills([...month.values()], statements, choices, matching.paymentDays)
  const taken = new Set([...paid.values()].map(paymentKey))
  const fileOf = new Map(receipts.map((r) => [r.id, r.fileName]))
  const dropped = new Set(choices.filter((c) => c.dropped).map((c) => c.transactionId))
  const paymentOf = (p: BillPayment | undefined) =>
    p
      ? { documentId: p.documentId, fileName: p.fileName, card: p.card, line: p.line, by: p.by }
      : null
  for (const [line, s] of shares) {
    const sources = sourcesOf(line, s)
    line.bills = sources.map((t): BooksBillDto => {
      const r = found.get(t.id)
      const bill = bills.get(t.id)!
      const p = paid.get(t.id)
      return {
        ...bill,
        paidFrom: bill.paidFrom ?? 'other',
        receipt: r
          ? { documentId: r.documentId, fileName: fileOf.get(r.documentId)!, by: r.by }
          : null,
        payment: paymentOf(p),
        paymentChoices:
          p || dropped.has(t.id) ? [] : paymentChoices(bill, statements, taken).map(paymentOf),
        dropped: dropped.has(t.id),
      } as BooksBillDto
    })
    const gone = sources.filter((t) => dropped.has(t.id))
    if (!gone.length) continue
    const entry = s.entry
    if (!entry) {
      line.amount = 0
      line.status = 'dropped'
      continue
    }
    // The pool's part of each dropped bill: its lines in the pool's class and account.
    const inPool = (t: BooksTransaction) =>
      t.lines
        .filter(
          (l) => programKey(l.className) === programKey(entry.pool) && l.account === entry.account
        )
        .reduce((n, l) => n + l.amount, 0)
    // Of the entry's total; of what the sources come to when they are not the entry's own (`Entry.loose`).
    const whole = entry.loose ? sources.reduce((n, t) => n + inPool(t), 0) : entry.total
    const off = gone.reduce((n, t) => n + inPool(t), 0)
    const share = whole > 0 ? off / whole : 0
    line.amount = cents(Math.min(s.bookedAs, Math.max(0, s.bookedAs * (1 - share))))
    if (line.amount <= 0) {
      line.amount = 0
      line.status = 'dropped'
    }
    if (line.split) {
      // Each dropped bill's part of this line, the last taking the cents left so the note adds up.
      const taken = cents(s.bookedAs - line.amount)
      let so = 0
      line.split.less = gone.map((t, i) => {
        const part = cents(inPool(t))
        const o = i === gone.length - 1 ? cents(taken - so) : cents((s.bookedAs * part) / whole)
        so = cents(so + o)
        return { transactionId: t.id, amount: part, off: o }
      })
      line.split.billed = line.amount
    }
  }
}

/** The words an allocated line's note says: its dollars of the whole, as the books charge them, never a rate. */
export function allocationNote(
  l: Pick<BooksLineDto, 'allocation' | 'className' | 'account' | 'amount'> & {
    split?: BooksSplitDto | null
    bills?: BooksBillDto[]
  }
) {
  const a = l.allocation
  if (!a) return null
  const money = (n: number) =>
    `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  const booked = l.split?.rows.find((r) => r.mine)?.amount ?? l.amount
  const note =
    a.how === 'entry'
      ? `${money(booked)} of ${money(a.total)}, as the books' allocation entry ${a.entryId} shares it out`
      : `${money(booked)} of ${money(a.total)}, as the books split transaction ${a.sourceIds[0]} by class`
  const gone = (l.bills ?? []).filter((b) => b.dropped)
  if (!gone.length) return note
  const off = l.split?.less.reduce((n, x) => n + x.off, 0) ?? booked - l.amount
  return `${note}, less ${money(off)} for ${gone.length === 1 ? 'bill' : 'bills'} ${gone.map((b) => `${b.transactionId} (${money(b.amount)})`).join(', ')}, dropped for want of its receipt or payment`
}

/** The bills a line keeps when saved (Expense.booksBills). */
export const savedBills = (l: Pick<BooksLineDto, 'bills'>): BooksBillSaved[] =>
  l.bills.map((b) => ({
    transactionId: b.transactionId,
    date: b.date,
    vendor: b.vendor,
    amount: b.amount,
    documentId: b.receipt?.documentId ?? null,
    payment: b.payment
      ? { documentId: b.payment.documentId, page: b.payment.line.page, text: b.payment.line.text }
      : null,
    dropped: b.dropped,
  }))

/** What Save writes for a line, as a line written before would read: the same, or changed since. */
function sameAs(x: PlanExisting, l: BooksLineDto) {
  return (
    x.date === l.date &&
    near(x.allocatedAmount, l.amount) &&
    near(x.totalCost, l.allocation?.total ?? l.amount) &&
    x.budgetLineId === l.budgetLineId &&
    (x.allocationNote ?? null) === allocationNote(l) &&
    sameBills(x.booksBills ?? null, savedBills(l)) &&
    sameSplit(x.booksSplit, l.split)
  )
}

/** The same split, field by field: none on both (a line saved before splits were kept has none yet), or the same rows. */
function sameSplit(a: BooksSplitDto | null | undefined, b: BooksSplitDto | null) {
  if (!a || !b) return !a && !b
  return (
    a.how === b.how &&
    a.transactionId === b.transactionId &&
    a.date === b.date &&
    a.account === b.account &&
    near(a.total, b.total) &&
    near(a.billed, b.billed) &&
    a.rows.length === b.rows.length &&
    a.rows.every(
      (r, i) =>
        r.className === b.rows[i]!.className &&
        near(r.amount, b.rows[i]!.amount) &&
        r.mine === b.rows[i]!.mine
    ) &&
    a.at?.length === b.at.length &&
    a.at.every((x, i) => x.page === b.at[i]!.page && x.row === b.at[i]!.row) &&
    a.less.length === b.less.length &&
    a.less.every(
      (x, i) =>
        x.transactionId === b.less[i]!.transactionId &&
        near(x.amount, b.less[i]!.amount) &&
        near(x.off, b.less[i]!.off)
    )
  )
}

/** The same bills, field by field: the database keeps a JSON object's keys in an order of its own. */
function sameBills(a: BooksBillSaved[] | null, b: BooksBillSaved[]) {
  return (
    !!a &&
    a.length === b.length &&
    a.every(
      (x, i) =>
        x.transactionId === b[i]!.transactionId &&
        x.date === b[i]!.date &&
        x.vendor === b[i]!.vendor &&
        near(x.amount, b[i]!.amount) &&
        (x.documentId ?? null) === b[i]!.documentId &&
        samePayment(x.payment, b[i]!.payment) &&
        !!x.dropped === b[i]!.dropped
    )
  )
}

/** The same payment: none on both (a line saved before payments were kept is not), or the same statement's line. */
function samePayment(a: BooksBillSaved['payment'], b: BooksBillSaved['payment']) {
  if (a === undefined) return false
  if (!a || !b) return !a && !b
  return a.documentId === b.documentId && a.page === b.page && a.text === b.text
}
