import { BadRequestException } from '@nestjs/common'
import { createHash } from 'node:crypto'
import {
  IMPORT_FIELD_LABELS,
  IMPORT_FIELDS,
  IMPORT_SKIP,
  type ImportCategories,
  type ImportColumns,
  type ImportField,
} from '@ad/types'
import { headerKey, type Table } from './table'

/**
 * The header names each field goes by, in the order they are tried: QuickBooks' Transaction Report, General Ledger
 * and Transaction Detail by Account first ("Date", "Num", "Name", "Memo/Description", "Account", "Split",
 * "Amount"), then the usual words of other exports and bank downloads.
 */
const SYNONYMS: Record<ImportField, string[]> = {
  date: ['date', 'transaction date', 'txn date', 'trans date', 'posting date', 'posted date'],
  vendor: ['name', 'payee', 'vendor', 'vendor name', 'payee name', 'supplier', 'merchant'],
  memo: ['memo/description', 'memo / description', 'memo', 'description', 'details'],
  amount: ['amount', 'net amount', 'total', 'total amount'],
  debit: ['debit', 'debits', 'withdrawal', 'withdrawals', 'money out'],
  credit: ['credit', 'credits', 'deposit', 'deposits', 'money in'],
  reference: [
    'num',
    'no.',
    'number',
    'ref no.',
    'ref',
    'reference',
    'reference number',
    'check no.',
  ],
  account: ['account', 'account name', 'gl account', 'account full name'],
  // On a QuickBooks register report, "Split" is the other side of the entry: the expense account it was coded to.
  category: ['split', 'category', 'expense category', 'distribution account', 'class'],
}

/**
 * The first guess from the column names alone. `flipSign` is guessed from the amounts: a bank register shows money
 * spent as negative.
 */
export function guessColumns(table: Table): ImportColumns {
  const byKey = new Map(table.headers.map((h) => [headerKey(h), h]))
  const used = new Set<string>()
  const guess: ImportColumns = {}
  for (const field of IMPORT_FIELDS) {
    if ((field === 'debit' || field === 'credit') && guess.amount) continue
    const header = SYNONYMS[field].map((s) => byKey.get(s)).find((h) => h && !used.has(h))
    if (header) {
      guess[field] = header
      used.add(header)
    }
  }
  // Only money paid out is imported: a bank file's money-out column is the total cost, its money-in column unused.
  if (!guess.amount && guess.debit) guess.amount = guess.debit
  delete guess.debit
  delete guess.credit
  if (guess.amount) {
    const i = table.headers.indexOf(guess.amount)
    const amounts = table.rows.map((r) => amountOf(r.cells[i])).filter((n): n is number => !!n)
    guess.flipSign = amounts.filter((n) => n < 0).length > amounts.length / 2
  }
  return guess
}

/**
 * A mapping as the person sent it, checked against the file: each field names one of its columns, and there is a
 * date, a payee and an amount (or a debit or credit column). Unknown keys are dropped.
 */
export function cleanColumns(given: unknown, headers: string[]): ImportColumns {
  const raw = (given && typeof given === 'object' ? given : {}) as Record<string, unknown>
  const out: ImportColumns = {}
  // Every problem in one answer, so nobody fixes the mapping one refusal at a time.
  const problems: string[] = []
  for (const field of IMPORT_FIELDS) {
    const v = raw[field]
    if (v == null || v === '') continue
    if (typeof v !== 'string' || !headers.includes(v))
      problems.push(`${IMPORT_FIELD_LABELS[field]}: the file has no column "${String(v)}"`)
    else out[field] = v
  }
  if (raw.flipSign === true) out.flipSign = true
  if (!out.date && !raw.date) problems.push('choose the column that holds the date')
  if (!out.vendor && !raw.vendor) problems.push('choose the column that holds the payee or vendor')
  if (!out.amount && !out.debit && !out.credit && !raw.amount && !raw.debit && !raw.credit)
    problems.push('choose the column that holds the amount')
  if (problems.length) throw new BadRequestException(`Check the columns: ${problems.join('; ')}`)
  return out
}

const nameKey = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .replace(/ies$/, 'y')
    .replace(/s$/, '')

/**
 * The budget item a value of the file's budget-line column names: its label or key, ignoring case, spaces,
 * punctuation and a plural "s" ("Supplies" and "supply" both match Supplies). Null unless exactly one item matches.
 */
export function matchItem(value: string, items: { key: string; label: string }[]): string | null {
  const v = nameKey(value)
  if (!v) return null
  const hits = items.filter((i) => nameKey(i.label) === v || nameKey(i.key) === v)
  return hits.length === 1 ? hits[0]!.key : null
}

/** Budget lines for single rows, by their line in the file: each a budget item key or IMPORT_SKIP. */
export function cleanLines(given: unknown, itemKeys: Set<string>): Record<string, string> {
  const raw = (given && typeof given === 'object' && !Array.isArray(given) ? given : {}) as Record<
    string,
    unknown
  >
  const out: Record<string, string> = {}
  const entries = Object.entries(raw)
  if (entries.length > 5000) throw new BadRequestException('Too many rows')
  for (const [line, target] of entries) {
    if (target == null || target === '') continue
    if (!/^\d{1,6}$/.test(line)) throw new BadRequestException('A row is named by its line number')
    if (typeof target !== 'string' || (target !== IMPORT_SKIP && !itemKeys.has(target)))
      throw new BadRequestException(
        `Line ${line} maps to a budget line this engagement does not use`
      )
    out[line] = target
  }
  return out
}

/** A category mapping as sent: each value a budget item key or IMPORT_SKIP. Items not offered are refused. */
export function cleanCategories(given: unknown, itemKeys: Set<string>): ImportCategories {
  const raw = (given && typeof given === 'object' && !Array.isArray(given) ? given : {}) as Record<
    string,
    unknown
  >
  const out: ImportCategories = {}
  const entries = Object.entries(raw)
  if (entries.length > 2000) throw new BadRequestException('Too many categories')
  for (const [category, target] of entries) {
    if (target == null || target === '') continue
    if (typeof target !== 'string' || (target !== IMPORT_SKIP && !itemKeys.has(target)))
      throw new BadRequestException(
        `"${category.slice(0, 80)}" maps to a budget line this engagement does not use`
      )
    out[category.slice(0, 200)] = target
  }
  return out
}

/**
 * A money cell as accounting exports write it: "$1,234.50", "-12.00", "(12.00)" for a negative. Blank is null, and so
 * is anything else: a comma after the dot ("1.234,50"), a comma that does not group thousands ("12,5") or more than
 * two decimals ("1.234") may be another country's way of writing it, and is never guessed at.
 */
export function amountOf(cell: string | undefined): number | null {
  let t = (cell ?? '').trim()
  if (!t) return null
  let sign = 1
  if (/^\(.*\)$/.test(t)) {
    sign = -1
    t = t.slice(1, -1)
  }
  t = t.replace(/[$\s]/g, '')
  if (t.startsWith('-')) {
    sign = -sign
    t = t.slice(1)
  }
  if (!/\d/.test(t) || !/^(\d{1,3}(,\d{3})+|\d+)?(\.\d{1,2})?$/.test(t)) return null
  return sign * Number(t.replace(/,/g, ''))
}

/** A date cell as YYYY-MM-DD: 2026-07-15, 07/15/2026 or 7/15/26 (month first, as US exports write it). */
export function dateOf(cell: string | undefined): string | null {
  const t = (cell ?? '').trim()
  let y: number, m: number, d: number
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t)
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(t)
  if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])]
  else if (us) {
    ;[m, d, y] = [Number(us[1]), Number(us[2]), Number(us[3])]
    if (y < 100) y += 2000
  } else return null
  const date = new Date(Date.UTC(y, m - 1, d))
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d)
    return null
  return date.toISOString().slice(0, 10)
}

/** Text the log keeps by value (item numbers, accounts): the characters it allows, at most 40. Empty is null. */
export function idLikeOrNull(cell: string | undefined): string | null {
  const t = (cell ?? '')
    .replace(/[^A-Za-z0-9#&./ -]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
    .trim()
  return t || null
}

/** One row of the file, read through the mapping. */
export interface Transaction {
  line: number
  date: string | null
  vendor: string
  memo: string
  amount: number | null
  /** An amount cell has something in it that is not an amount this import reads (see amountOf). */
  amountUnreadable: boolean
  reference: string | null
  account: string | null
  category: string
}

/** Every row of the file read through the mapping; nothing is decided about it yet. */
export function transactionsOf(table: Table, columns: ImportColumns): Transaction[] {
  const at = (f: ImportField) => (columns[f] ? table.headers.indexOf(columns[f]!) : -1)
  const col = Object.fromEntries(IMPORT_FIELDS.map((f) => [f, at(f)])) as Record<
    ImportField,
    number
  >
  return table.rows.map(({ line, cells }) => {
    const cell = (f: ImportField) => (col[f] >= 0 ? cells[col[f]] : '')
    let amount: number | null
    const unreadable = (f: ImportField) => cell(f).trim() !== '' && amountOf(cell(f)) == null
    const amountUnreadable =
      col.amount >= 0 ? unreadable('amount') : unreadable('debit') || unreadable('credit')
    if (col.amount >= 0) amount = amountOf(cell('amount'))
    else {
      const debit = amountOf(cell('debit'))
      const credit = amountOf(cell('credit'))
      amount = debit == null && credit == null ? null : (debit ?? 0) - (credit ?? 0)
    }
    if (amount != null && columns.flipSign) amount = -amount
    if (amount != null) amount = Math.round(amount * 100) / 100
    return {
      line,
      date: dateOf(cell('date')),
      vendor: cell('vendor').slice(0, 200),
      memo: cell('memo').slice(0, 1000),
      amount,
      amountUnreadable,
      reference: idLikeOrNull(cell('reference')),
      account: idLikeOrNull(cell('account')),
      category: (col.category >= 0 ? cell('category') : cell('account')).slice(0, 200),
    }
  })
}

/** The fields that make a row the same row when it comes again, normalised. */
function rowKey(t: Transaction): string {
  const norm = (s: string | null) => (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
  return [
    t.date,
    (t.amount ?? 0).toFixed(2),
    norm(t.vendor),
    norm(t.memo),
    norm(t.reference),
    norm(t.account),
    norm(t.category),
  ].join('\u001f')
}

/**
 * What makes a row the same row when it comes again: its date, amount, payee, memo, reference, account and category,
 * and which of the file's identical rows it is (`occurrence`, from 1), so two identical purchases on one day are two
 * rows and the same file imported again is refused row for row. Never logged.
 */
export function fingerprintOf(t: Transaction, occurrence = 1): string {
  return createHash('sha256')
    .update(`${rowKey(t)}\u001f${occurrence}`)
    .digest('hex')
}

/** Each row's fingerprint, counting identical rows in file order. */
export function fingerprintsOf(rows: Transaction[]): string[] {
  const seen = new Map<string, number>()
  return rows.map((t) => {
    const key = rowKey(t)
    const n = (seen.get(key) ?? 0) + 1
    seen.set(key, n)
    return fingerprintOf(t, n)
  })
}
