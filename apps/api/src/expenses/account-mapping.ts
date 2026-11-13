import { programKey } from '@ad/types'
import { readGrid } from '../imports/table'

/**
 * An account mapping file (owner's decision, 2026-11-09): one engagement's chart of accounts mapped to the categories its
 * funder bills, as the team keeps it in a spreadsheet, in the zip's "Account mapping" folder as program names are. A row
 * gives an account's number and the category it bills to (blank: not billable to this engagement); a side box may say
 * which budget line each category is ("PERSONNEL BUDGET AMOUNT $48,000.00 -----> Salaries") and the contract it is
 * of. Read in memory; what it says is kept, the file is not. Pure but for reading the bytes.
 */

/** One category's budget line, as the file's side box names it, with the amount it gives. */
export interface MappingCategory {
  category: string
  /** The budget line it names after an arrow; null when the box gives only the category. */
  line: string | null
  amount: number | null
}

export interface AccountMappingRead {
  /** The words the file names its engagement by: the category column's heading and the contract box. */
  title: string
  /** Account number -> the category it bills to; null: not billable to this engagement. */
  accounts: Record<string, string | null>
  /** Each account's own name, as the file gives it. */
  names: Record<string, string>
  categories: MappingCategory[]
  /** The contract's total, when the box gives one ("BUDGET: $90,000"). */
  budget: number | null
  /** The contract period, when the box gives one (yyyy-mm-dd). */
  start: string | null
  end: string | null
}

const ACCOUNT = /^\s*(\d{4,7})\s*$/
/** A cell that says what kind of row it is (QuickBooks' own layout words), never a category. */
const LAYOUT = /\b(header|sub ?accounts?|total)\b/i
/** The heading of the category column. */
const CATEGORY_HEADING = /\b(billable|mapped|allowable|budget (?:line|categor))/i
const BOX = /^(.+?)\s+BUDGET(?: AMOUNT)?\s*:?\s*\$?\s*([\d,]+(?:\.\d+)?)\s*(?:-+\s*>\s*(.+))?$/i

const money = (s: string) => {
  const n = Number(s.replace(/[,$\s]/g, ''))
  return Number.isFinite(n) ? n : null
}

/** "7/01/2026" as yyyy-mm-dd. */
const usDate = (s: string) => {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s.trim())
  return m ? `${m[3]}-${m[1]!.padStart(2, '0')}-${m[2]!.padStart(2, '0')}` : null
}

export async function readAccountMapping(
  buffer: Buffer,
  fileName: string
): Promise<AccountMappingRead> {
  return accountMappingOf(await readGrid(buffer, fileName), fileName)
}

/** The mapping in a sheet's rows (as `readGrid` gives them). */
export function accountMappingOf(grid: string[][], fileName = ''): AccountMappingRead {
  const rows = grid.map((r) => r.map((c) => (c ?? '').trim()))
  const width = Math.max(0, ...rows.map((r) => r.length))
  // The account column: the one most rows give a bare number in.
  const numbersIn = (c: number) => rows.filter((r) => ACCOUNT.test(r[c] ?? '')).length
  let accountCol = -1
  for (let c = 0; c < width; c++)
    if (numbersIn(c) > (accountCol < 0 ? 0 : numbersIn(accountCol))) accountCol = c
  // A heading row ("60000 | General and Administrative | THE MAIN HEADER") groups accounts; it bills nothing itself.
  const accountRows =
    accountCol < 0
      ? []
      : rows.filter(
          (r) => ACCOUNT.test(r[accountCol] ?? '') && !r.some((c) => /\bheader\b/i.test(c))
        )
  // The name column: the next with text on most account rows.
  const filled = (c: number) =>
    accountRows.filter((r) => (r[c] ?? '') !== '' && !LAYOUT.test(r[c] ?? '')).length
  const nameCol = accountCol + 1
  // The category column: the one its heading names, else the last with text on account rows that is not the name's.
  const headed = (c: number) => rows.slice(0, 5).some((r) => CATEGORY_HEADING.test(r[c] ?? ''))
  let categoryCol = -1
  for (let c = 0; c < width; c++)
    if (c !== accountCol && c !== nameCol && headed(c) && filled(c)) categoryCol = c
  if (categoryCol < 0)
    for (let c = width - 1; c > nameCol; c--)
      if (filled(c)) {
        categoryCol = c
        break
      }

  const accounts: Record<string, string | null> = {}
  const names: Record<string, string> = {}
  for (const r of accountRows) {
    const no = ACCOUNT.exec(r[accountCol]!)![1]!
    names[no] = (r[nameCol] ?? '').trim()
    const cat = categoryCol >= 0 ? (r[categoryCol] ?? '').trim() : ''
    accounts[no] =
      cat && !LAYOUT.test(cat) && !CATEGORY_HEADING.test(cat) ? cat.replace(/\s+/g, ' ') : null
  }

  // The side box: categories with their budget amounts and lines, the contract's total and period.
  const categories: MappingCategory[] = []
  let budget: number | null = null
  let start: string | null = null
  let end: string | null = null
  const titleBits: string[] = []
  for (const [i, r] of rows.entries())
    for (const [c, cell] of r.entries()) {
      if (!cell) continue
      if (i < 3 && c >= (categoryCol < 0 ? nameCol + 1 : categoryCol) && !LAYOUT.test(cell))
        titleBits.push(cell)
      const period = /agreement period|contract period|period of performance/i.test(cell)
        ? /(\d{1,2}\/\d{1,2}\/\d{4})\s*[-–—to]+\s*(\d{1,2}\/\d{1,2}\/\d{4})/i.exec(cell)
        : null
      if (period) {
        start = usDate(period[1]!)
        end = usDate(period[2]!)
        continue
      }
      const total = /^\s*(?:total\s+)?budget\s*:?\s*\$\s*([\d,]+(?:\.\d+)?)\s*$/i.exec(cell)
      if (total) {
        budget = money(total[1]!)
        continue
      }
      const box = BOX.exec(cell)
      if (box)
        categories.push({
          category: box[1]!.replace(/\s+/g, ' ').trim(),
          line: box[3]?.trim() || null,
          amount: money(box[2]!),
        })
    }
  return {
    title: [...new Set([...titleBits, fileName.replace(/\.[^.]+$/, '')])]
      .filter(Boolean)
      .join(' · '),
    accounts,
    names,
    categories,
    budget,
    start,
    end,
  }
}

/** The categories the accounts bill to, each once, in the file's order. */
export const categoriesOf = (m: Pick<AccountMappingRead, 'accounts'>) => [
  ...new Set(Object.values(m.accounts).filter((c): c is string => !!c)),
]

const words = (s: string) => programKey(s).split(' ').filter(Boolean)

/**
 * The engagement a mapping file is of, by what it says: its contract total and period, and the engagement's name, number
 * or code (or the name's initials, "ISY" for In School Youth) among its title's words. Null unless one engagement is the
 * best.
 */
export function engagementOfMapping<
  E extends {
    id: string
    name: string
    number: string | null
    code: string | null
    periodStart: string | null
    periodEnd: string | null
    /** Its total as the budget lines add up, and as awarded. */
    budgets: number[]
  },
>(m: Pick<AccountMappingRead, 'title' | 'budget' | 'start' | 'end'>, engagements: E[]): E | null {
  const title = ` ${words(m.title).join(' ')} `
  const has = (s: string | null) =>
    !!s && programKey(s).length >= 2 && title.includes(` ${programKey(s)} `)
  const initials = (name: string) =>
    words(name)
      .filter((w) => !/^\d+$/.test(w))
      .map((w) => w[0])
      .join('')
  const scored = engagements.map((e) => {
    let score = 0
    if (m.budget !== null && e.budgets.some((b) => Math.abs(b - m.budget!) < 0.5)) score += 3
    if (m.start && m.end && e.periodStart === m.start && e.periodEnd === m.end) score += 2
    if (has(e.name) || has(e.number) || has(e.code)) score += 3
    else if (initials(e.name).length >= 2 && has(initials(e.name))) score += 2
    else if ([e.number, e.code].some((x) => x && words(x).some((w) => w.length >= 2 && has(w))))
      score += 2
    return { e, score }
  })
  const best = Math.max(0, ...scored.map((s) => s.score))
  const top = scored.filter((s) => s.score === best)
  return best > 0 && top.length === 1 ? top[0]!.e : null
}

const nameKey = (s: string) =>
  programKey(s)
    .replace(/\bcosts?\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/s$/, '')

/**
 * A category's budget line on the engagement: the line the side box names after its arrow, else the line of the box's
 * amount, else the line named as the category is. Null unless exactly one line is it.
 */
export function budgetLineOfCategory<L extends { id: string; name: string; amount: number }>(
  category: string,
  m: Pick<AccountMappingRead, 'categories'>,
  lines: L[]
): L | null {
  const one = (hits: L[]) => (hits.length === 1 ? hits[0]! : null)
  const box = m.categories.find((c) => nameKey(c.category) === nameKey(category))
  const byName = (name: string) => one(lines.filter((l) => nameKey(l.name) === nameKey(name)))
  if (box?.line) {
    const named = byName(box.line)
    if (named) return named
  }
  if (box?.amount != null) {
    const byAmount = one(lines.filter((l) => Math.abs(l.amount - box.amount!) < 0.5))
    if (byAmount) return byAmount
  }
  return byName(category)
}
