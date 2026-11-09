import {
  programKey,
  type BooksAllocationDto,
  type BooksLineDto,
  type BooksLineStatus,
  type ProgramNames,
} from '@ad/types'
import { isPayrollRow } from '../imports/imports.service'
import { programIn } from '../payroll/payroll-details'
import { budgetLineOfCategory, type AccountMappingRead } from './account-mapping'
import type { BooksLine, BooksTransaction } from './books'

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
}

export const SKIP = 'skip'

const cents = (n: number) => Math.round(n * 100) / 100
const near = (a: number, b: number) => Math.abs(a - b) < 0.015

/** A class that holds a cost until it is shared out: kept apart by the books, never a program of its own. */
const POOL = /\ballocat/i

interface Entry {
  /** The allocation entry's transaction. */
  id: string
  account: string
  pool: string
  total: number
  sourceIds: string[]
}

/** The allocation entries of the month: per account, one line taking a class's pool out, the rest giving it to others. */
function entriesOf(transactions: BooksTransaction[]): Map<BooksLine, Entry> {
  const out = new Map<BooksLine, Entry>()
  for (const t of transactions) {
    const byAccount = new Map<string, BooksLine[]>()
    for (const l of t.lines) byAccount.set(l.account, [...(byAccount.get(l.account) ?? []), l])
    for (const [account, ls] of byAccount) {
      const out1 = ls.filter((l) => l.amount < 0)
      const given = ls.filter((l) => l.amount > 0)
      if (out1.length !== 1 || !given.length || !out1[0]!.className) continue
      const pool = out1[0]!
      const total = cents(-pool.amount)
      if (!near(cents(given.reduce((s, l) => s + l.amount, 0)), total)) continue
      if (given.some((l) => programKey(l.className) === programKey(pool.className))) continue
      const sourceIds = transactions
        .filter(
          (o) =>
            o.id !== t.id &&
            o.lines.some(
              (l) =>
                l.amount > 0 &&
                programKey(l.className) === programKey(pool.className) &&
                (l.accountNo ?? l.account) === (pool.accountNo ?? pool.account)
            )
        )
        .map((o) => o.id)
      const entry = { id: t.id, account, pool: pool.className, total, sourceIds }
      for (const l of ls) out.set(l, entry)
    }
  }
  return out
}

/** Every line of the month: where it goes, or why it goes nowhere. */
export function planBooks(input: {
  period: string
  transactions: BooksTransaction[]
  programs: ProgramNames[]
  engagements: PlanEngagement[]
  mappings: PlanMapping[]
  existing: PlanExisting[]
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
  const seen = new Map<string, number>()
  const out: BooksLineDto[] = []
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
      const before = byKey.get(line.key)
      if (before) {
        line.saved = sameAs(before, line) ? 'same' : 'changed'
        continue
      }
      // Entered on the month already (typed, or imported from the books before): the same day and amount.
      if (
        input.existing.some(
          (x) =>
            !x.booksKey &&
            x.engagementId === e.id &&
            x.date === t.date &&
            near(x.allocatedAmount, l.amount)
        )
      )
        set('already-entered')
    }
  }
  return out
}

/** The words an allocated line's note says: its share, of what, and how the books share it. */
export function allocationNote(l: Pick<BooksLineDto, 'allocation' | 'className' | 'account'>) {
  const a = l.allocation
  if (!a) return null
  const money = `$${a.total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  return a.how === 'entry'
    ? `${a.percent.toFixed(2)}% of ${money}, shared out by the books' allocation entry ${a.entryId}`
    : `${a.percent.toFixed(2)}% of ${money}, as the books split transaction ${a.sourceIds[0]} by class`
}

/** What Save writes for a line, as a line written before would read: the same, or changed since. */
function sameAs(x: PlanExisting, l: BooksLineDto) {
  return (
    x.date === l.date &&
    near(x.allocatedAmount, l.amount) &&
    near(x.totalCost, l.allocation?.total ?? l.amount) &&
    x.budgetLineId === l.budgetLineId &&
    (x.allocationNote ?? null) === allocationNote(l)
  )
}
