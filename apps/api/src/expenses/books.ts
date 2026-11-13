import type { StatementLine } from '@ad/types'
import { balanceSheetAccount, chargesOf } from '../payroll/payroll-details'

/**
 * The books' expenses (owner's decision, 2026-11-09): the month's accounting export in the zip (QuickBooks' "Transaction
 * List with Splits", the file payroll details is read from) holds the whole month, every transaction with its split
 * lines. Payroll takes the rows that name a person and a pay run (`chargesOf`); every other line booked to an expense
 * account is an expense, read here. Each transaction keeps the side it was paid from (the bank, or a card), which says
 * where its payment shows. Pure.
 */

/** Between cells of a spreadsheet or CSV row read as a line (`sheetLines`, `csvLines`). */
const CELL = ' | '

/** How a header cell reads for matching: lower case, single spaces. */
const headerKey = (h: string) => h.trim().toLowerCase().replace(/\s+/g, ' ')

/** The header words of each column read, as accounting exports name them. */
const HEADERS = {
  date: (k: string) => ['date', 'transaction date', 'txn date', 'posting date'].includes(k),
  type: (k: string) => ['transaction type', 'type', 'txn type'].includes(k),
  num: (k: string) => ['num', 'no.', 'number', 'ref no.', 'ref number', 'doc number'].includes(k),
  name: (k: string) => ['name', 'payee', 'vendor', 'customer/vendor', 'vendor name'].includes(k),
  class: (k: string) => ['class', 'class full name', 'class name'].includes(k),
  description: (k: string) =>
    ['description', 'memo/description', 'memo', 'memo / description'].includes(k),
  account: (k: string) =>
    [
      'account',
      'account name',
      'account full name',
      'split account',
      'distribution account',
    ].includes(k),
  amount: (k: string) => k === 'amount' || k === 'net amount',
  id: (k: string) =>
    ['transaction id', 'txn id', 'transaction no.', 'transaction number'].includes(k),
} as const
type Column = keyof typeof HEADERS

/** One split line of a transaction, booked to an expense account. */
export interface BooksLine {
  /** Where the row is in the file (its sheet and row), so the same file always gives the same line. */
  page: number
  row: number
  account: string
  /** The account's own number ("60301" of "60300 Technology:60301 Software and Subscription"); null without one. */
  accountNo: string | null
  /** The class or program column, as written. */
  className: string
  description: string
  amount: number
  /** The row's text, as the file has it: the line's proof in the books. */
  text: string
}

/** Where a transaction was paid from: the books' bank or card account on its other side. */
export interface BooksPayment {
  account: string
  kind: 'bank' | 'card' | 'other'
}

export interface BooksTransaction {
  /** The books' transaction id (the export's "Transaction ID" column), else one made from its row's date, type and number. */
  id: string
  /** yyyy-mm-dd */
  date: string
  type: string
  num: string
  vendor: string
  description: string
  payment: BooksPayment | null
  lines: BooksLine[]
}

/** The account's own number: the last part of its path that starts with one. */
export function accountNumber(account: string): string | null {
  const parts = account.split(':').reverse()
  for (const p of parts) {
    const m = /^\s*(\d{3,7})\b/.exec(p)
    if (m) return m[1]!
  }
  return null
}

/** An income account: the money coming in, never an expense (4xxxx in the usual numbering, or its words say so). */
const incomeAccount = (account: string) => {
  const top = account.split(':')[0] ?? ''
  return /\b(income|revenue|sales)\b/i.test(top) || /^\s*4\d{3,}\b/.test(top)
}

/**
 * A balance-sheet account: by a five-digit number starting 1, 2 or 3 whatever its words ("13200 Prepaid Expenses" is an
 * asset); as payroll reads one; or a bank or card the transaction was paid from, named without a number ("Chase
 * Operating", "American Express", "Petty Cash"). An account numbered 5 to 9, or whose words name a cost ("60250 Credit
 * Card Fees", "Bank Service Charges"), is an expense, never the balance sheet, unless its words say it is owed or held
 * ("Accrued Interest Payable").
 */
export function onBalanceSheet(account: string): boolean {
  const top = account.split(':')[0] ?? ''
  if (/^\s*[123]\d{4,}\b/.test(top)) return true
  if (/^\s*[5-9]\d{3,}\b/.test(top)) return false
  if (/\b(fees?|charges?|interest|expenses?|supplies)\b/i.test(account))
    return /liabilit|payable|receivable|accrued|\bassets?\b|equity|prepaid/i.test(account)
  return balanceSheetAccount(account) || paymentOf(account).kind !== 'other'
}

/** A card account (a liability the card's charges are booked against), else the bank. */
function paymentOf(account: string): BooksPayment {
  if (/\bamex\b|american express|credit card|\bvisa\b|mastercard|\bcard\b/i.test(account))
    return { account, kind: 'card' }
  if (/\bbank\b|checking|savings|operating|\bcash\b/i.test(account))
    return { account, kind: 'bank' }
  return { account, kind: 'other' }
}

function dateCell(cell: string | undefined): string | null {
  const t = (cell ?? '').trim()
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t)
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})$/.exec(t)
  const [y, m, d] = iso
    ? [Number(iso[1]), Number(iso[2]), Number(iso[3])]
    : us
      ? [Number(us[3]!.length === 2 ? `20${us[3]}` : us[3]), Number(us[1]), Number(us[2])]
      : [NaN, NaN, NaN]
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null
  const date = new Date(Date.UTC(y, m - 1, d))
  if (date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null
  return date.toISOString().slice(0, 10)
}

function amountCell(cell: string | undefined): number | null {
  const t = (cell ?? '').trim()
  if (!t) return null
  const negative = /^\(.*\)$/.test(t) || /^-/.test(t)
  const n = Number(t.replace(/[()$,\s-]/g, ''))
  if (!Number.isFinite(n)) return null
  return Math.round((negative ? -n : n) * 100) / 100
}

/** The header row of a page: the first that names an account, an amount and a date column. */
function headerOf(
  lines: StatementLine[]
): { at: number; cols: Partial<Record<Column, number>> } | null {
  for (const line of lines) {
    const keys = line.text.split(CELL).map(headerKey)
    const cols: Partial<Record<Column, number>> = {}
    for (const col of Object.keys(HEADERS) as Column[]) {
      const i = keys.findIndex(HEADERS[col])
      if (i >= 0) cols[col] = i
    }
    if (cols.account !== undefined && cols.amount !== undefined && cols.date !== undefined)
      return { at: line.y, cols }
  }
  return null
}

/**
 * The books' expense transactions in an accounting export, read by its header's columns (a sheet without such a header
 * gives none). Rows payroll takes (`chargesOf`), rows of income, and rows with no date (headings, totals) are left out;
 * a transaction with no line on an expense account is not an expense (an invoice, a deposit, a transfer).
 */
export function booksTransactions(lines: StatementLine[]): BooksTransaction[] {
  const all = Array.isArray(lines) ? lines : []
  const payroll = new Set(chargesOf(all).map((c) => c.line))
  const pages = [...new Set(all.map((l) => l.page))]
  const byId = new Map<string, BooksTransaction>()
  for (const page of pages) {
    const onPage = all.filter((l) => l.page === page)
    const header = headerOf(onPage)
    if (!header) continue
    const { cols } = header
    const at = (cells: string[], col: Column) =>
      cols[col] !== undefined ? (cells[cols[col]!] ?? '').trim() : ''
    for (const line of onPage) {
      if (line.y <= header.at) continue
      const cells = line.text.split(CELL)
      const date = dateCell(at(cells, 'date'))
      const amount = amountCell(at(cells, 'amount'))
      const account = at(cells, 'account')
      if (!date || amount === null || !account) continue
      const type = at(cells, 'type')
      const num = at(cells, 'num')
      const vendor = at(cells, 'name')
      const id = at(cells, 'id') || `${date}|${type}|${num}|${vendor}`
      const t =
        byId.get(id) ??
        ({
          id,
          date,
          type,
          num,
          vendor,
          description: '',
          payment: null,
          lines: [],
        } as BooksTransaction)
      byId.set(id, t)
      const description = at(cells, 'description')
      if (!t.description && description) t.description = description
      if (!t.vendor && vendor) t.vendor = vendor
      if (onBalanceSheet(account)) {
        t.payment ??= paymentOf(account)
        continue
      }
      if (payroll.has(line) || incomeAccount(account) || amount === 0) continue
      t.lines.push({
        page,
        row: line.y,
        account,
        accountNo: accountNumber(account),
        className: at(cells, 'class'),
        description,
        amount,
        text: line.text,
      })
    }
  }
  return [...byId.values()].filter((t) => t.lines.length > 0)
}
