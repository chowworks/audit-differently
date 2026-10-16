import type {
  HighlightField,
  PayrollCandidate,
  PayrollDocumentKind,
  PayrollSlot,
  PayrollSlotMatch,
  StatementLine,
} from '@ad/types'
import { PAYROLL_SLOT_KIND } from '@ad/types'
import { highlightsFor } from './highlights'
import { amountPattern, type PageItem } from './statement-lines'

/** A payroll item as the matcher sees it: a staff payroll line (its date) or a participant's pay (its pay period). */
export interface ProofItem {
  target: 'expense' | 'wex'
  id: string
  kind: 'staff' | 'participant'
  /** The person paid, for a participant; a staff line names a payroll company, so it has none. */
  name: string | null
  amount: number
  /** yyyy-mm-dd: the pay period, or the staff line's date twice. */
  start: string
  end: string
}

/** A file of the run with the lines read from it (none for a scanned file). */
export interface ProofFile {
  id: string
  kind: PayrollDocumentKind
  fileName: string
  lines: StatementLine[]
  /** The text runs with their boxes, for exact-word highlights; none on a file read before they were kept. */
  items?: PageItem[]
}

/** How far a staff line's date may be from a date on its proof: a pay run is paid up to about two weeks later. */
const NEAR_DAYS = 16

/** The slots an item needs: a participant's pay is proved by a pay stub, a staff line's by its bank line. */
export const slotsOf = (item: ProofItem): PayrollSlot[] =>
  item.kind === 'participant'
    ? ['timesheet', 'register', 'stub']
    : ['timesheet', 'register', 'bank']

const iso = (y: number, m: number, d: number) =>
  m >= 1 && m <= 12 && d >= 1 && d <= 31
    ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    : null

/** Every date written in the text, as yyyy-mm-dd: 09/07/2026, 9.7.26, 2026-09-07 and 20260907. */
export function datesOf(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g))
    out.push(iso(+m[1]!, +m[2]!, +m[3]!) ?? '')
  for (const m of text.matchAll(/(?<![\d-])(\d{1,2})[/.](\d{1,2})[/.](\d{4}|\d{2})(?!\d)/g)) {
    const y = m[3]!.length === 2 ? 2000 + +m[3]! : +m[3]!
    out.push(iso(y, +m[1]!, +m[2]!) ?? '')
  }
  for (const m of text.matchAll(/(?<!\d)(20\d{2})(\d{2})(\d{2})(?!\d)/g))
    out.push(iso(+m[1]!, +m[2]!, +m[3]!) ?? '')
  return out.filter(Boolean)
}

const days = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000

/** Every part of the name (two letters or more) in the text as a whole word, in any order: "Sample, Jordan" too. */
export function nameIn(text: string, name: string): boolean {
  const parts = name
    .toLowerCase()
    .split(/[^\p{L}\p{N}'-]+/u)
    .filter((p) => p.length >= 2)
  if (!parts.length) return false
  const words = new Set(text.toLowerCase().split(/[^\p{L}\p{N}'-]+/u))
  return parts.every((p) => words.has(p))
}

const money = (n: number) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const us = (d: string) => `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}`

/** The best line one file has for one slot of one item, and how sure that is. */
export function candidateFor(
  item: ProofItem,
  slot: PayrollSlot,
  file: ProofFile
): PayrollCandidate {
  const { lines } = file
  const re = amountPattern(item.amount)
  const amountLines = lines.filter((l) => re.test(l.text))
  const named = (t: string) => !!item.name && nameIn(t, item.name)
  const nameLines = lines.filter((l) => named(l.text))
  const both = amountLines.filter((l) => named(l.text))
  const nameInFile = nameLines.length > 0 || named(file.fileName.replace(/[-_]+/g, ' '))
  // The dates that place the file: a participant's exact pay period, a staff line's date within NEAR_DAYS.
  const fits = (dates: string[]) =>
    item.kind === 'participant'
      ? dates.includes(item.start) && dates.includes(item.end)
      : dates.some((d) => days(d, item.start) <= NEAR_DAYS)
  // A line that says "pay period" goes first: it is the one an auditor looks for.
  const periodLines = lines
    .filter((l) => fits(datesOf(l.text)))
    .sort((a, b) => Number(/pay period/i.test(b.text)) - Number(/pay period/i.test(a.text)))
  const placed = periodLines.length > 0 || fits(datesOf(file.fileName))
  const when =
    item.kind === 'participant'
      ? `the pay period ${us(item.start)}–${us(item.end)}`
      : `a date near ${us(item.start)}`
  const on = (l: StatementLine) => `page ${l.page}`
  const out = (mark: StatementLine | null, score: number, sure: boolean, why: string) => ({
    fileId: file.id,
    mark,
    marks: [] as StatementLine[],
    score,
    sure,
    why,
  })
  if (!lines.length) return out(null, 0, false, 'Scanned: no text to read. Choose it by hand.')
  const amount = money(item.amount)

  if (slot === 'stub' || (slot === 'timesheet' && item.kind === 'participant')) {
    const line = both[0] ?? (nameInFile ? amountLines[0] : undefined)
    if (line && placed)
      return out(line, 5, true, `${item.name} and ${amount} on ${on(line)}, for ${when}.`)
    if (line)
      return out(line, 4, false, `${item.name} and ${amount} on ${on(line)}, but not ${when}.`)
    if (nameInFile && placed)
      return out(
        nameLines[0] ?? periodLines[0] ?? null,
        3,
        false,
        `${item.name} for ${when}, but not ${amount}.`
      )
    if (nameInFile)
      return out(nameLines[0] ?? null, 2, false, `${item.name}, but neither ${amount} nor ${when}.`)
    return out(null, 0, false, `Nothing of ${item.name}.`)
  }

  if (slot === 'register' && both[0])
    return out(both[0], 5, true, `${item.name} and ${amount} on ${on(both[0])}.`)
  // A staff line, or a register (a company summary that rarely names the person): the amount on a line beside a date
  // that places it, or the amount alone, or the date alone.
  const dated = amountLines.find((l) => fits(datesOf(l.text)))
  if (dated) return out(dated, 4, true, `${amount} beside ${when}, on ${on(dated)}.`)
  if (amountLines[0] && placed)
    return out(
      amountLines[0],
      4,
      true,
      `${amount} on ${on(amountLines[0])}, in a file for ${when}.`
    )
  if (slot === 'register' && item.kind === 'participant' && periodLines[0])
    return out(
      periodLines[0],
      3,
      true,
      `The pay period ${us(item.start)}–${us(item.end)} on ${on(periodLines[0])}.`
    )
  if (amountLines[0])
    return out(amountLines[0], 3, false, `${amount} on ${on(amountLines[0])}, but not ${when}.`)
  if (placed) return out(periodLines[0] ?? null, 1, false, `${when}, but not ${amount}.`)
  return out(null, 0, false, `Neither ${amount} nor ${when}.`)
}

/**
 * What fits one slot of one item, best first, and Auto-Match's pick: the best file when it fits at all (2 or more) and
 * no other file fits as well and as surely. Two equally good files are left for the person to choose.
 */
export function matchSlot(
  item: ProofItem,
  slot: PayrollSlot,
  files: ProofFile[],
  fields: readonly HighlightField[] = []
): PayrollSlotMatch {
  const kind = PAYROLL_SLOT_KIND[slot]
  const candidates = files
    .filter((f) => f.kind === kind)
    .map((f) => {
      const c = candidateFor(item, slot, f)
      // The exact words to highlight, for a file that shows something of the item.
      if (c.score > 0 && f.items?.length) c.marks = highlightsFor(item, fields, f.items, c.mark)
      return c
    })
    .sort((a, b) => b.score - a.score || Number(b.sure) - Number(a.sure))
  const [best, next] = candidates
  const base = { target: item.target, id: item.id, slot, candidates }
  if (!best) return { ...base, pick: null, why: 'No file of this kind in the zip.' }
  if (best.score < 2)
    return { ...base, pick: null, why: 'No file shows this item. Choose one by hand.' }
  if (next && next.score === best.score && next.sure === best.sure)
    return {
      ...base,
      pick: null,
      why: `${candidates.filter((c) => c.score === best.score).length} files fit equally. Choose one.`,
    }
  return { ...base, pick: best.fileId, why: best.why }
}
