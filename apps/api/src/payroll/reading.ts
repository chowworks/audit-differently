import { DEFAULT_PAYROLL_READING, type PayrollReading } from '@ad/types'

/**
 * The payroll matchers' reading words, compiled (owner's decision, 2026-10-19): a platform admin sets them for the whole
 * system in Admin tools → Payroll reading (`PayrollReadingService`), and both match screens read files by them. They
 * are one value for every workspace, so the newest is held here: `PayrollReadingService` puts it in force when it reads
 * or saves it, before any match works out, and until then (or in a test) the defaults are in force.
 */
export interface Reader {
  words: PayrollReading
  /** A line that prints a pay date: "Pay date 09/25/2026". */
  payDate: RegExp
  /** A line that prints the pay period. */
  period: RegExp
  /** The register's stated debit, each label then anything up to its amount, best first. */
  debitTotals: RegExp[]
  /** A pay stub's gross pay label, then its total pay label, then its net pay label: each up to its amount. */
  gross: RegExp
  totalPay: RegExp
  net: RegExp
  /** A register row's pay label (gross or total pay), up to its amount. */
  rowPay: RegExp
  /** Text that ends in a year-to-date word: the amount after it is the year's. */
  ytdBefore: RegExp
  /** A heading that prints "current" before a year-to-date word: the current amount comes first. */
  currentFirst: RegExp
  /** The label before a name on a pay stub. */
  nameLabel: RegExp
  /** Money coming in on a bank line. */
  moneyIn: RegExp
  /** A register's own heading rows: the pay date or period, not a person's pay. */
  registerHeading: RegExp
  /** A pay stub's line that says what the person was paid, best first. */
  stubPay: RegExp[]
}

/** One word as a pattern: any case, a space also matching a hyphen or no space ("Year-to-date", "NetPay"). */
const wordPattern = (w: string) =>
  w
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '[\\s-]*')

/** Any of the words, longest first so "gross pay" is found before "gross". */
export const anyOf = (words: string[]) =>
  [...words]
    .sort((a, b) => b.length - a.length)
    .map(wordPattern)
    .join('|')

export function compileReading(words: PayrollReading): Reader {
  const re = (source: string, flags = 'i') => new RegExp(source, flags)
  const w = (list: string[]) => `\\b(?:${anyOf(list)})\\b`
  return {
    words,
    payDate: re(w(words.payDateLabels)),
    period: re(w(words.periodLabels)),
    debitTotals: words.debitTotalLabels.map((l) => re(`\\b${wordPattern(l)}\\b[^$\\d]*`)),
    gross: re(`${w(words.grossLabels)}[:\\s]*`),
    totalPay: re(`${w(words.totalPayLabels)}[:\\s]*`),
    net: re(`${w(words.netLabels)}[:\\s]*`),
    rowPay: re(`${w([...words.grossLabels, ...words.totalPayLabels])}[:\\s]*`),
    ytdBefore: re(`${w(words.ytdLabels)}\\s*$`),
    currentFirst: re(`\\bcurrent\\b.*${w(words.ytdLabels)}`),
    nameLabel: re(`^\\s*(?:${anyOf(words.nameLabels)})\\s*:\\s*`),
    moneyIn: re(w(words.moneyInWords)),
    registerHeading: re(
      `\\b(?:${anyOf([...words.payDateLabels, ...words.periodLabels, 'run date'])})\\b`
    ),
    stubPay: [re(anyOf(words.netLabels)), re(anyOf(words.grossLabels)), /\bpay\b/i],
  }
}

let inForce = compileReading(DEFAULT_PAYROLL_READING)
let inForceKey = JSON.stringify(DEFAULT_PAYROLL_READING)

/** The reading words in force. */
export const reader = (): Reader => inForce

/** Puts these words in force (compiled once per change). */
export function putReadingInForce(words: PayrollReading): void {
  const key = JSON.stringify(words)
  if (key === inForceKey) return
  inForce = compileReading(words)
  inForceKey = key
}
