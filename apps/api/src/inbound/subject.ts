import { EMAILED_KINDS, EMAILED_KIND_WORDS, type EmailedKind } from '@ad/types'

/**
 * The time zone an email's "this month" is worked out in: an email sent at 9 PM on October 31 on the East Coast is
 * October's, not November's (UTC). The workspaces are US training providers; one zone for all until one asks for its own.
 */
export const INBOUND_TIME_ZONE = 'America/New_York'

/** YYYY-MM of `at` in INBOUND_TIME_ZONE. */
export function monthIn(at: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: INBOUND_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(at)
  const y = parts.find((p) => p.type === 'year')!.value
  const m = parts.find((p) => p.type === 'month')!.value
  return `${y}-${m}`
}

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
]
/** Short forms, taken only with a year beside them ("Oct 2026"): alone, "mar", "jun" or "dec" may be anything. */
const SHORT: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
}

const pad = (n: number) => String(n).padStart(2, '0')
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')
/** `words` as a whole word or phrase: letters, digits and hyphens make a word; spaces in a phrase match any spacing. */
const whole = (words: string) =>
  new RegExp(`(^|[^a-z0-9-])${words.split(' ').map(escape).join('\\s+')}($|[^a-z0-9-])`, 'i')

export interface SubjectRead {
  /** What the files are: the word the subject names, else a receipt (as every email was before). */
  kind: EmailedKind
  /**
   * The month the subject names, YYYY-MM; null when it names none, or when it names no folder word at all: a forwarded
   * bill's subject ("Your October statement is ready") is not the person choosing a month, so the receipt's own date
   * decides.
   */
  period: string | null
  /** Why it cannot be filed by itself (two kinds, two months): it waits in the inbox for a person. */
  problem: string | null
}

/**
 * Words that say the files are payroll files but match no folder ("payroll", a bare "stub", a W-2): such an email waits
 * for a person rather than being filed as a receipt.
 */
const PAYROLL_HINTS = ['payroll', 'stub', 'stubs', 'w-2', 'w-2s', 'w2', 'w2s']

/** The months the subject names, each YYYY-MM. A month with no year is the latest one not after `now`'s month. */
function monthsOf(text: string, now: string): Set<string> {
  const found = new Set<string>()
  const [ny, nm] = now.split('-').map(Number) as [number, number]
  const withoutYear = (m: number) => `${m > nm ? ny - 1 : ny}-${pad(m)}`
  for (const x of text.matchAll(/(?<![0-9])(20\d{2})-(0[1-9]|1[0-2])(?![0-9])/g))
    found.add(`${x[1]}-${x[2]}`)
  for (const x of text.matchAll(/(?<![0-9/])(0?[1-9]|1[0-2])\/(20\d{2})(?![0-9])/g))
    found.add(`${x[2]}-${pad(Number(x[1]))}`)
  MONTHS.forEach((name, i) => {
    const m = i + 1
    const re = new RegExp(`(^|[^a-z0-9-])${name}(?:\\s*,?\\s*(20\\d{2}))?($|[^a-z0-9-])`, 'gi')
    for (const x of text.matchAll(re)) {
      // "May" alone is as often "may be late" as the month: taken only with a year.
      if (name === 'may' && !x[2]) continue
      found.add(x[2] ? `${x[2]}-${pad(m)}` : withoutYear(m))
    }
  })
  for (const [short, m] of Object.entries(SHORT)) {
    const re = new RegExp(`(^|[^a-z0-9-])${short}\\.?\\s*,?\\s*(20\\d{2})($|[^a-z0-9-])`, 'gi')
    for (const x of text.matchAll(re)) found.add(`${x[2]}-${pad(m)}`)
  }
  return found
}

/**
 * What an emailed subject says its files are, and the month (issue #82). The engagement codes it names are taken out
 * first, so a code like MAY-YOUTH or OCT-26 is never read as a month. Two kinds of file, or two months, in one subject
 * are not guessed between, and a payroll word that names no folder is not taken for a receipt: the email waits for a
 * person to file it.
 */
export function readSubject(subject: string | null, codes: string[], now: Date): SubjectRead {
  let text = (subject ?? '').slice(0, 300).toLowerCase()
  for (const code of codes) text = text.replace(new RegExp(whole(code).source, 'gi'), '$1 $2')
  const kinds = EMAILED_KINDS.filter((k) => EMAILED_KIND_WORDS[k].some((w) => whole(w).test(text)))
  // With no folder word, the subject's months are not read: the receipt's own date decides.
  const months = kinds.length ? [...monthsOf(text, monthIn(now))] : []
  const problem =
    kinds.length > 1
      ? 'The subject names more than one kind of file'
      : !kinds.length && PAYROLL_HINTS.some((w) => whole(w).test(text))
        ? 'The subject names payroll files but not which folder'
        : months.length > 1
          ? 'The subject names more than one month'
          : null
  return { kind: kinds.length === 1 ? kinds[0]! : 'receipt', period: months[0] ?? null, problem }
}
