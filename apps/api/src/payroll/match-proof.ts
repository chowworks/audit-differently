import type {
  AiFileFacts,
  HighlightField,
  PayrollCandidate,
  PayrollDocumentKind,
  PayrollSlot,
  PayrollSlotMatch,
  StatementLine,
} from '@ad/types'
import { PAYROLL_SLOT_KIND } from '@ad/types'
import { highlightsFor } from './highlights'
import { reader } from './reading'
import {
  datesOf,
  payDateOn,
  payMonthOf,
  payRunOf,
  payRunsOf,
  periodOn,
  runOfFile,
  runsOfLine,
  type PayRun,
} from './pay-runs'
import { amountPattern, type PageItem } from './statement-lines'

export { datesOf } from './pay-runs'

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
  /**
   * The month it is on, yyyy-mm: a register or pay stub paid in another month (by its pay date, else its period's end)
   * is not its proof (owner's decision, 2026-10-19). Unknown: not checked.
   */
  month?: string
}

/** A file of the run with the lines read from it (none for a scanned file). */
export interface ProofFile {
  id: string
  kind: PayrollDocumentKind
  fileName: string
  lines: StatementLine[]
  /** The text runs with their boxes, for exact-word highlights; none on a file read before they were kept. */
  items?: PageItem[]
  /** What AI read from the file when a person asked (every value found in its text). */
  ai?: AiFileFacts | null
}

// How far a staff line's date may be from a date on its proof (a pay run is paid up to about two weeks later), and from
// a run's pay date to be that run's, are the admin's reading words: Admin tools → Payroll reading (`reader()`).

/** The slots an item needs: a participant's pay is proved by a pay stub, a staff line's by its bank line. */
export const slotsOf = (item: ProofItem): PayrollSlot[] =>
  item.kind === 'participant'
    ? ['timesheet', 'register', 'stub']
    : ['timesheet', 'register', 'bank']

const days = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000

/** Windows-1252's characters for bytes 0x80–0x9F, the ones a text read twice in the wrong encoding is made of. */
const CP1252: Record<string, number> = {
  '€': 0x80,
  '‚': 0x82,
  ƒ: 0x83,
  '„': 0x84,
  '…': 0x85,
  '†': 0x86,
  '‡': 0x87,
  ˆ: 0x88,
  '‰': 0x89,
  Š: 0x8a,
  '‹': 0x8b,
  Œ: 0x8c,
  Ž: 0x8e,
  '‘': 0x91,
  '’': 0x92,
  '“': 0x93,
  '”': 0x94,
  '•': 0x95,
  '–': 0x96,
  '—': 0x97,
  '˜': 0x98,
  '™': 0x99,
  š: 0x9a,
  '›': 0x9b,
  œ: 0x9c,
  ž: 0x9e,
  Ÿ: 0x9f,
}
const utf8 = new TextDecoder('utf-8', { fatal: true })

/**
 * Text as a name is compared (January test, 2026-10-19): a word saved twice in the wrong encoding repaired
 * ("CoreyeÃ¢â‚¬â„¢ Ross" is "Coreye’ Ross"; kept only when its bytes read back as clean UTF-8, so a real "Ã" stays), and
 * every apostrophe the same one. The file's own words are still what the screen quotes.
 */
export function plainText(text: string): string {
  let t = text
  for (let i = 0; i < 3 && /[ÃÂâ]/.test(t); i++) {
    const bytes: number[] = []
    for (const ch of t) {
      const code = ch.codePointAt(0)!
      const b = code <= 0xff ? code : CP1252[ch]
      if (b === undefined) return t.replace(/[’‘`´ʼ]/g, "'")
      bytes.push(b)
    }
    try {
      const back = utf8.decode(new Uint8Array(bytes))
      if (back === t) break
      t = back
    } catch {
      break
    }
  }
  return t.replace(/[’‘`´ʼ]/g, "'")
}

/**
 * A name as a list keeps it (owner's decision, 2026-10-19): its first name, any other first name written in quotes
 * (`Favour "Veya" Newsome`: Favour or Veya), and its last name. Middle names are not kept: a file may print them or not.
 * A name of one word is its last name alone.
 */
export function nameParts(name: string): { firsts: string[]; last: string } | null {
  const quoted = [...name.matchAll(/["“”]([^"“”]+)["“”]/g)].flatMap((m) =>
    m[1]!.trim().split(/\s+/)
  )
  const words = name
    .replace(/["“”][^"“”]*["“”]/g, ' ')
    .trim()
    .split(/[\s,]+/)
    .map((p) => p.replace(/^[.'’-]+|\.+$/g, ''))
    .filter(Boolean)
  if (!words.length) return null
  const last = words[words.length - 1]!
  const firsts = [...(words.length > 1 ? [words[0]!] : []), ...quoted.filter(Boolean)]
  return { firsts, last }
}

/** The name's first and last names in the text as whole words, in any order ("Sample, Jordan" too), middle names or none. */
export function nameIn(text: string, name: string): boolean {
  const parts = nameParts(plainText(name))
  if (!parts) return false
  const words = new Set(
    plainText(text)
      .toLowerCase()
      .split(/[^\p{L}\p{N}'’-]+/u)
  )
  const has = (w: string) => words.has(w.toLowerCase())
  return has(parts.last) && (!parts.firsts.length || parts.firsts.some(has))
}

const WORD_CHAR = "[\\p{L}\\p{N}'’-]"
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const personPatterns = new Map<string, RegExp | null>()
/** Up to two middle names between a first and a last name: "JayVon A Harper", "Noemi Malani Murrell". */
const MIDDLE = `(?:[\\s.]+${WORD_CHAR}+){0,2}`

/**
 * A person's name in the text, stricter than `nameIn` (GitHub issue #22, for the staff and participant lists): their
 * first name (or the other one in quotes), up to two middle names, then their last name, as consecutive words ("Morgan
 * Lee", "MORGAN J LEE"); or the last name first with a comma ("Lee, Morgan J"). Case does not matter; "Morgan Leeds"
 * and "Lee Morgan" are not Morgan Lee. A name of one word is that word.
 */
export function personIn(text: string, name: string): boolean {
  let re = personPatterns.get(name)
  if (re === undefined) {
    const parts = nameParts(plainText(name))
    const sep = '[\\s.]+'
    const forms: string[] = []
    if (parts) {
      const last = escapeRe(parts.last)
      if (!parts.firsts.length) forms.push(last)
      else {
        const first = `(?:${parts.firsts.map(escapeRe).join('|')})`
        forms.push(`${first}${MIDDLE}${sep}${last}`, `${last}\\s*,\\s*${first}${MIDDLE}`)
      }
    }
    re = forms.length
      ? new RegExp(`(?<!${WORD_CHAR})(?:${forms.join('|')})(?!${WORD_CHAR})`, 'iu')
      : null
    if (personPatterns.size > 5000) personPatterns.clear()
    personPatterns.set(name, re)
  }
  return !!re && re.test(plainText(text))
}

const money = (n: number) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const us = (d: string) => `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}`

/** A candidate, with the amount its highlights are cut for when it is not the item's own (a pay run's debit). */
type Candidate = PayrollCandidate & { highlightAmount?: number }

/**
 * The best line one file has for one slot of one item, and how sure that is. A staff line's bank line may be the debit
 * of the pay run it was paid in (`runs`, from the registers of the same upload): the run's stated total on a date near
 * its pay date (owner's decision, 2026-10-19).
 */
export function candidateFor(
  item: ProofItem,
  slot: PayrollSlot,
  file: ProofFile,
  runs: PayRun[] = [],
  /** The run of the month's list that paid a staff line (owner's decision, 2026-10-19): its files only fit it. */
  itemRun: PayRun | null = null
): Candidate {
  const { lines } = file
  const re = amountPattern(item.amount)
  const amountLines = lines.filter((l) => re.test(l.text))
  const named = (t: string) => !!item.name && nameIn(t, item.name)
  const nameLines = lines.filter((l) => named(l.text))
  const both = amountLines.filter((l) => named(l.text))
  const nameInFile = nameLines.length > 0
  const { proofDaysFromCharge, chargeDaysFromPayDate } = reader().words
  // The dates that place the file: a participant's exact pay period, a staff line's date within the admin's days.
  const fits = (dates: string[]) =>
    item.kind === 'participant'
      ? dates.includes(item.start) && dates.includes(item.end)
      : itemRun
        ? (!!itemRun.payDate && dates.includes(itemRun.payDate)) ||
          (!!itemRun.start && dates.includes(itemRun.start) && dates.includes(itemRun.end!))
        : dates.some((d) => days(d, item.start) <= proofDaysFromCharge)
  // A line that says "pay period" goes first: it is the one an auditor looks for.
  const periodLines = lines
    .filter((l) => fits(datesOf(l.text)))
    .sort((a, b) => Number(/pay period/i.test(b.text)) - Number(/pay period/i.test(a.text)))
  // The month's runs list places the file too: a stub of the run of the payment's period, a file of the line's run.
  const fileRun = runs.length ? runOfFile(runs, file) : null
  const placed =
    periodLines.length > 0 ||
    (!!fileRun &&
      (item.kind === 'participant'
        ? fileRun.start === item.start && fileRun.end === item.end
        : fileRun === itemRun))
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
  // What AI read, when a person asked: this item's person (or, for a staff line, its amount) and pay, on a line of the file.
  const cents = (n: number) => Math.round(n * 100)
  const fact =
    slot === 'bank'
      ? undefined
      : file.ai?.people.find(
          (p) =>
            p.gross !== null &&
            cents(p.gross) === cents(item.amount) &&
            (!item.name || nameIn(p.name, item.name)) &&
            // A pay belongs to the month it was paid in.
            !(item.month && p.payDate && p.payDate.slice(0, 7) !== item.month)
        )
  if (fact)
    return {
      ...out(
        fact.line,
        5,
        true,
        `✨ AI read: ${fact.name} and ${money(item.amount)} on ${on(fact.line)}, checked against the file's text.`
      ),
      ai: true,
    }
  // A pay belongs to the month it was paid in: a register or pay stub paid in another month is not this month's.
  if (item.month && (slot === 'register' || slot === 'stub')) {
    const run = slot === 'register' ? payRunOf(file) : null
    const paid = run ? (run.payDate ?? run.end) : (payDateOn(lines) ?? periodOn(file)?.end ?? null)
    if (paid && paid.slice(0, 7) !== item.month)
      return out(null, 1, false, `Paid on ${us(paid)}: another month's pay.`)
  }
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
  if (slot === 'bank') {
    // The debit of the pay run the line was paid in: one run's, on this statement, paid in the line's month near its
    // date; of two runs of the month, the one paid on the line's date.
    const near = runs.filter(
      (r) =>
        r.debit?.fileId === file.id &&
        !!(r.payDate ?? r.end) &&
        days(r.payDate ?? r.end!, item.start) <= proofDaysFromCharge &&
        (!item.month || payMonthOf(r) === item.month)
    )
    const onDate = near.filter(
      (r) => days(r.payDate ?? r.end!, item.start) <= chargeDaysFromPayDate
    )
    const debits = (onDate.length ? onDate : near)
      .map((r) => ({ ...r.debit!, payDate: r.payDate ?? r.end! }))
      .filter((d, i, all) => all.findIndex((x) => x.line === d.line) === i)
    if (debits.length === 1) {
      const d = debits[0]!
      return {
        ...out(
          d.line,
          4,
          true,
          `The pay run's debit, ${money(d.amount)} (the payroll register's total), on ${on(d.line)}, near the pay date ${us(d.payDate)}.`
        ),
        highlightAmount: d.amount,
      }
    }
  }
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

/** The pay runs of one upload's files, read once for every item matched against the same list. */
const runCache = new WeakMap<ProofFile[], PayRun[]>()
function runsOf(files: ProofFile[]): PayRun[] {
  let runs = runCache.get(files)
  if (!runs) runCache.set(files, (runs = payRunsOf(files)))
  return runs
}

/**
 * What fits one slot of one item, best first, and Auto-Match's pick: the best file when it fits at all (2 or more) and
 * no other file fits as well and as surely. Two equally good files are left for the person to choose.
 */
export function matchSlot(
  item: ProofItem,
  slot: PayrollSlot,
  files: ProofFile[],
  fields: readonly HighlightField[] = [],
  /** The upload's files the pay runs are read from (its registers and statements), when `files` is not all of them. */
  runFiles: ProofFile[] = files
): PayrollSlotMatch {
  const kind = PAYROLL_SLOT_KIND[slot]
  // The month's runs as the registers print them: each file is placed in a run, a staff line in the one that paid it.
  const runs = runsOf(runFiles)
  const itemRun = (() => {
    if (item.kind === 'participant') return null
    const paid = runsOfLine(runs, item.start, item.month ?? null)
    return paid.length === 1 ? paid[0]! : null
  })()
  const candidates = files
    .filter((f) => f.kind === kind)
    .map((f): PayrollCandidate => {
      const { highlightAmount, ...rest } = candidateFor(item, slot, f, runs, itemRun)
      const c: PayrollCandidate = highlightAmount === undefined ? rest : { ...rest, payRun: true }
      // The exact words to highlight, for a file that shows something of the item.
      if (c.score > 0 && f.items?.length)
        c.marks = highlightsFor(
          highlightAmount === undefined ? item : { ...item, amount: highlightAmount },
          fields,
          f.items,
          c.mark
        )
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
