import type { HighlightField, StatementLine } from '@ad/types'
import { amountPattern, spanBox, type PageItem } from './statement-lines'

/** A payroll item as a highlight needs it: who was paid, how much, and the pay period (a staff line's date twice). */
export interface HighlightItem {
  name: string | null
  amount: number
  start: string
  end: string
}

const iso = (y: number, m: number, d: number) =>
  m >= 1 && m <= 12 && d >= 1 && d <= 31
    ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    : null

/** Where each full date is written in the text (09/07/2026, 9.7.26, 2026-09-07, 20260907), as yyyy-mm-dd. */
export function dateSpans(text: string): { iso: string; from: number; to: number }[] {
  const out: { iso: string; from: number; to: number }[] = []
  const push = (m: RegExpMatchArray, d: string | null) => {
    if (d) out.push({ iso: d, from: m.index!, to: m.index! + m[0].length })
  }
  for (const m of text.matchAll(/(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g))
    push(m, iso(+m[1]!, +m[2]!, +m[3]!))
  for (const m of text.matchAll(/(?<![\d-])(\d{1,2})[/.](\d{1,2})[/.](\d{4}|\d{2})(?!\d)/g))
    push(m, iso(m[3]!.length === 2 ? 2000 + +m[3]! : +m[3]!, +m[1]!, +m[2]!))
  for (const m of text.matchAll(/(?<!\d)(20\d{2})(\d{2})(\d{2})(?!\d)/g))
    push(m, iso(+m[1]!, +m[2]!, +m[3]!))
  return out.sort((a, b) => a.from - b.from)
}

/** A bank transaction's date as a statement prints it, often without its year: 01/13 or 1/13/26. */
const SHORT_DATE = /(?<![\d/.])\d{1,2}\/\d{1,2}(?:\/\d{2,4})?(?![\d/])/

const inside = (it: PageItem, line: StatementLine) =>
  it.page === line.page &&
  it.y >= line.y - 1 &&
  it.y <= line.y + line.height + 1 &&
  it.x >= line.x - 2 &&
  it.x <= line.x + line.width + 2

/** The first place `find` matches in the runs, the line's own runs first, then the rest of the file. */
function first(
  items: PageItem[],
  line: StatementLine | null,
  find: (s: string) => { from: number; to: number } | null
): StatementLine | null {
  const own = line ? items.filter((it) => inside(it, line)) : []
  for (const it of [...own, ...items]) {
    const at = find(it.str)
    if (at) return spanBox(it, at.from, at.to)
  }
  return null
}

const regex = (re: RegExp) => (s: string) => {
  const m = re.exec(s)
  return m ? { from: m.index, to: m.index + m[0].length } : null
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A box inside another one on the same page adds nothing: a name within the highlighted row. */
function withoutNested(boxes: StatementLine[]): StatementLine[] {
  const within = (a: StatementLine, b: StatementLine) =>
    a !== b &&
    a.page === b.page &&
    a.x >= b.x - 1 &&
    a.y >= b.y - 1 &&
    a.x + a.width <= b.x + b.width + 1 &&
    a.y + a.height <= b.y + b.height + 1
  return boxes.filter(
    (a, i) => !boxes.some((b, j) => j !== i && within(a, b) && !(within(b, a) && j > i))
  )
}

/**
 * The exact words to highlight for one item on one file, as the platform's settings ask for that kind of proof:
 * the name (each part of it found), the pay period's two dates, the pay date (the date beside "pay date"), the amount,
 * the item's whole row (the line the match found), or a bank transaction's date. Each is looked for on the line the
 * match found first, then anywhere in the file; what cannot be found is left out, never guessed.
 */
export function highlightsFor(
  item: HighlightItem,
  fields: readonly HighlightField[],
  items: PageItem[],
  line: StatementLine | null
): StatementLine[] {
  const boxes: StatementLine[] = []
  const add = (b: StatementLine | null) => b && boxes.push(b)
  for (const field of fields) {
    if (field === 'row') add(line)
    // The amount with its dollar sign, when the file prints one right before it.
    if (field === 'amount')
      add(first(items, line, regex(new RegExp(`(?:\\$\\s?)?${amountPattern(item.amount).source}`))))
    if (field === 'name' && item.name)
      for (const part of item.name.split(/\s+/).filter((p) => p.length >= 2))
        add(
          first(
            items,
            line,
            regex(new RegExp(`(?<![\\p{L}\\p{N}])${escape(part)}(?![\\p{L}\\p{N}])`, 'iu'))
          )
        )
    if (field === 'payPeriod')
      for (const d of new Set([item.start, item.end]))
        add(first(items, line, (s) => dateSpans(s).find((x) => x.iso === d) ?? null))
    if (field === 'date' && line)
      add(
        first(
          items.filter((it) => inside(it, line)),
          null,
          regex(SHORT_DATE)
        )
      )
    if (field === 'payDate') add(payDate(items))
  }
  return withoutNested(boxes)
}

/** The date a "Pay date" label gives: in the same run after the label, or the nearest run to its right or below. */
function payDate(items: PageItem[]): StatementLine | null {
  for (const label of items) {
    const at = /pay\s*date/i.exec(label.str)
    if (!at) continue
    const after = dateSpans(label.str).find((d) => d.from >= at.index + at[0].length)
    if (after) return spanBox(label, after.from, after.to)
    const near = items
      .filter(
        (it) =>
          it !== label &&
          it.page === label.page &&
          dateSpans(it.str).length > 0 &&
          ((Math.abs(it.y - label.y) <= 3 && it.x > label.x) ||
            (label.y - it.y > 0 && label.y - it.y <= 40))
      )
      .sort(
        (a, b) =>
          Math.abs(a.y - label.y) +
          Math.abs(a.x - label.x) -
          (Math.abs(b.y - label.y) + Math.abs(b.x - label.x))
      )[0]
    if (near) {
      const d = dateSpans(near.str)[0]!
      return spanBox(near, d.from, d.to)
    }
  }
  return null
}
