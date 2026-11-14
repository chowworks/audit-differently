import type { PayrollSlot } from '@ad/types'
import { personIn } from './match-proof'
import { amountsOn } from './pay-runs'
import type { WorkspaceItem } from './workspace-items'

type Side = { sha: string; marks: unknown }[]

/**
 * Whether an item's proof of one kind is two different files that need the owner (owner's decision, 2026-10-19): a
 * person's (the bookkeeper's) and the match's, of different contents, only when the two contradict each other: two pay
 * stubs by their pay, hours or dates (pay period, pay date; owner's decision, 2026-10-20), and one whose highlighted words
 * could not be read is flagged, since it can't be compared; a timesheet or a register by a different amount or
 * different hours for the same person. A participant's pay is one person's; a staff line's are the staff named on both.
 */
export function twoDiffer(
  i: Pick<WorkspaceItem, 'target' | 'proof'>,
  slot: PayrollSlot,
  theirs: Side,
  ours: Side,
  staffNames: string[] = []
): boolean {
  const shas = new Set(theirs.map((t) => t.sha))
  const other = ours.filter((o) => !shas.has(o.sha))
  if (!theirs.length || !other.length) return false
  if (slot === 'stub') {
    const a = theirs.flatMap((t) => textsOf(t.marks))
    const b = other.flatMap((o) => textsOf(o.marks))
    if (!a.length || !b.length) return true
    const x = figures(a)
    const y = figures(b)
    return (
      disjoint(x.amounts, y.amounts) ||
      disjoint(x.hours, y.hours) ||
      disjoint(datesOf(a), datesOf(b))
    )
  }
  const names = i.target === 'wex' && i.proof.name ? [i.proof.name] : staffNames
  return theirs.some((t) =>
    other.some((o) => contradicts(textsOf(t.marks), textsOf(o.marks), names, i.target === 'wex'))
  )
}

const textsOf = (marks: unknown): string[] =>
  (Array.isArray(marks) ? (marks as { text?: unknown }[]) : [])
    .map((m) => (typeof m?.text === 'string' ? m.text : ''))
    .filter(Boolean)
/** Hours as payroll files print them: 20.0, never part of an amount or a date. */
const HOURS = /(?<![\d.,$/])\d{1,3}\.\d(?![\d/])/g
const figures = (texts: string[]) => {
  const t = texts.join(' ')
  return { amounts: new Set(amountsOn(t)), hours: new Set([...t.matchAll(HOURS)].map((m) => m[0])) }
}
/** The dates a pay stub's words print (m/d/yyyy), as yyyy-mm-dd. */
const DATE = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g
const datesOf = (texts: string[]) =>
  new Set(
    [...texts.join(' ').matchAll(DATE)].map(
      ([, m, d, y]) => `${y}-${m!.padStart(2, '0')}-${d!.padStart(2, '0')}`
    )
  )
const disjoint = (a: Set<number | string>, b: Set<number | string>) =>
  a.size > 0 && b.size > 0 && ![...a].some((x) => b.has(x))

/**
 * Two files' highlighted words for the same person disagree: for each name both name, their lines for that person show
 * different amounts or different hours. `whole`: the words are one person's even where no line names them (a
 * participant's register highlights its amount and dates alone).
 */
export function contradicts(
  theirs: string[],
  ours: string[],
  names: string[],
  whole = false
): boolean {
  const differ = (a: string[], b: string[]) => {
    const x = figures(a)
    const y = figures(b)
    return disjoint(x.amounts, y.amounts) || disjoint(x.hours, y.hours)
  }
  let named = false
  for (const n of names) {
    const a = theirs.filter((t) => personIn(t, n))
    const b = ours.filter((t) => personIn(t, n))
    if (!a.length || !b.length) continue
    named = true
    if (differ(a, b)) return true
  }
  return whole && !named && differ(theirs, ours)
}
