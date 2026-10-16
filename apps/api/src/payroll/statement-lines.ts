import type { StatementLine } from '@ad/types'

/** Pages read from one statement at most; a month's statement is a few pages. */
export const MAX_STATEMENT_PAGES = 200

/** A bank statement's text layer, page by page, as lines: each line's text and its box in PDF points. */
export interface StatementText {
  pages: number
  /** No text on any page: a scanned statement (or a photo), so nothing can be searched. */
  scanned: boolean
  lines: StatementLine[]
  /** The text runs as the PDF places them, page by page: what an exact-word highlight is cut from. */
  items: PageItem[]
  /** Each page's box [x0, y0, x1, y1], to check a mark drawn by hand. */
  views: number[][]
}

type Item = { str: string; x: number; y: number; w: number; h: number }
/** One text run on a page: its text and where it sits, in PDF points from the page's bottom-left corner. */
export type PageItem = Item & { page: number }

const round = (n: number) => Math.round(n * 100) / 100

/**
 * The text items on one baseline become one line: items whose baselines are within a third of their height (or
 * 2 points) are merged, read left to right, with a space where there is a gap. The box runs from the first item to
 * the end of the last, from a little below the baseline to the top of the tallest letter, with a small margin.
 */
export function linesOf(page: number, items: Item[]): StatementLine[] {
  const rows: { y: number; h: number; items: Item[] }[] = []
  for (const it of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const row = rows.find((r) => Math.abs(r.y - it.y) <= Math.max(2, Math.min(r.h, it.h) / 3))
    if (row) {
      row.items.push(it)
      row.h = Math.max(row.h, it.h)
    } else rows.push({ y: it.y, h: it.h, items: [it] })
  }
  return rows.map((r) => {
    const sorted = r.items.sort((a, b) => a.x - b.x)
    let text = ''
    let end = -Infinity
    for (const it of sorted) {
      if (text && it.x - end > r.h * 0.15 && !/\s$/.test(text)) text += ' '
      text += it.str
      end = Math.max(end, it.x + it.w)
    }
    const x0 = sorted[0]!.x
    const h = r.h || 10
    const low = Math.min(...sorted.map((it) => it.y)) - h * 0.3
    const high = Math.max(...sorted.map((it) => it.y)) + h * 1.1
    return {
      page,
      text: text.replace(/\s+/g, ' ').trim().slice(0, 300),
      x: round(x0 - 2),
      y: round(low),
      width: round(end - x0 + 4),
      height: round(high - low),
    }
  })
}

/**
 * pdf.js text items as upright items with a baseline. Rotated or skewed text (a sideways margin note, a watermark)
 * is left out: its width runs along another direction, so a box built from it would cover the wrong place.
 */
export function itemsOf(raw: unknown[]): Item[] {
  const items: Item[] = []
  for (const r of raw) {
    const it = r as { str?: string; transform?: number[]; width?: number; height?: number }
    if (!it.str?.trim() || !it.transform) continue
    const [, b = 0, c = 0, d = 0, e = 0, f = 0] = it.transform
    if (b !== 0 || c !== 0) continue
    items.push({ str: it.str, x: e, y: f, w: it.width ?? 0, h: it.height || Math.abs(d) })
  }
  return items
}

/**
 * Reads a PDF's text layer with pdf.js (through unpdf). Never OCR: a file without text is reported as scanned. The
 * callers pass bank statements, and the payroll files of a payroll match (timesheets, registers, pay stubs), which may
 * be read to match them.
 */
export async function readStatement(buffer: Buffer): Promise<StatementText> {
  const { getDocumentProxy } = await import('unpdf')
  const pdf = await getDocumentProxy(new Uint8Array(buffer))
  const lines: StatementLine[] = []
  const items: PageItem[] = []
  const views: number[][] = []
  const pages = pdf.numPages
  for (let n = 1; n <= Math.min(pages, MAX_STATEMENT_PAGES); n++) {
    const page = await pdf.getPage(n)
    views.push([...page.view])
    const content = await page.getTextContent()
    const upright = itemsOf(content.items as unknown[])
    lines.push(...linesOf(n, upright))
    items.push(...upright.map((it) => ({ ...it, page: n })))
  }
  await pdf.loadingTask.destroy()
  return { pages, scanned: lines.length === 0, lines, items, views }
}

/**
 * The amount as a statement prints it: 1,234.56 or 1234.56 (or 1234.5 for 1234.50), with or without a minus sign, a
 * dollar sign or brackets. Never part of a longer number (11,234.56 is not 1,234.56).
 */
export function amountPattern(amount: number): RegExp {
  const [whole, cents] = Math.abs(amount).toFixed(2).split('.') as [string, string]
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  // A payroll export may drop a trailing zero (165.0 for 165.00): that form too, never a bare whole number.
  const tails = cents.endsWith('0') ? [cents, cents[0]!] : [cents]
  const forms = [...new Set([whole, grouped])].flatMap((w) => tails.map((c) => `${w}\\.${c}`))
  return new RegExp(`(?<![\\d.,])(?:${forms.join('|')})(?!\\d)`)
}

/** The statement's lines where `amount` appears. */
export function linesWithAmount(lines: StatementLine[], amount: number): StatementLine[] {
  const re = amountPattern(amount)
  return lines.filter((l) => re.test(l.text))
}

/**
 * The box around part of a text run: characters `from` to `to` of its text. A PDF gives a run's width, not each
 * letter's, so the part is placed by its share of the characters, with a little margin. Close enough to cover the words
 * and nothing next to them.
 */
export function spanBox(it: PageItem, from: number, to: number): StatementLine {
  const n = Math.max(1, it.str.length)
  const x0 = it.x + (it.w * from) / n
  const x1 = it.x + (it.w * to) / n
  const h = it.h || 10
  return {
    page: it.page,
    text: it.str.slice(from, to).trim().slice(0, 300),
    x: round(x0 - 1.5),
    y: round(it.y - h * 0.3),
    width: round(x1 - x0 + 3),
    height: round(h * 1.4),
  }
}
