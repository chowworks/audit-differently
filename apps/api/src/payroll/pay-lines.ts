import {
  MAX_PAY_LINES,
  type PayLineKind,
  type PayrollSlot,
  type StatementLine,
  type StatementMark,
} from '@ad/types'
import { reader } from './reading'

/** A pay's amount as files print it: 1,234.56 or $280.00. */
const MONEY = /(?<![\d.])\$?\s?\d{1,3}(?:,\d{3})*\.\d{2}(?!\d)/
const MONEY_ALL = new RegExp(MONEY.source, 'g')
/** A bank transaction's date as a statement prints it, often without its year: 01/13 or 1/13/26. */
const SHORT_DATE = /(?<![\d/.])\d{1,2}\/\d{1,2}(?:\/\d{2,4})?(?![\d/])/
/** A line that sums or heads the file rather than paying anyone. */
const NOT_A_PAY =
  /\b(balance|totals?|subtotal|summary|beginning|ending|opening|closing|year[- ]to[- ]date|ytd)\b/i
/**
 * Money coming in is not a payment of payroll, unless it is a direct deposit to the person. Its words, a register's
 * heading rows (its pay date and period labels) and a pay stub's pay labels are the admin's reading words (`reader()`).
 */
const DIRECT_DEPOSIT = /\bdirect\s*dep/i

export { MAX_PAY_LINES }

/** The slot a pay of this kind proves on an item: a register its register, a pay stub a participant's pay, a bank line a staff line's. */
export const PAY_SLOT: Record<PayLineKind, PayrollSlot> = {
  'payroll-register': 'register',
  paystub: 'stub',
  'bank-statement': 'bank',
}

export const isPayKind = (k: string): k is PayLineKind =>
  k === 'payroll-register' || k === 'paystub' || k === 'bank-statement'

/**
 * The person-pays in one payroll file, as its lines were read: every row of a register that pays someone (a name and an
 * amount, not a heading or a total), every transaction of a bank statement that pays out (a date and an amount, not a
 * balance or money coming in), and one per pay stub (the file is the pay: its net or gross line, or null when it was
 * scanned). A timesheet pays nobody: none. The reconciliation accounts for each one, so nothing in the files is
 * silently dropped; a line taken for a pay that is not one is marked not grant-funded by an owner.
 */
function allPayLines(file: { kind: string; lines: StatementLine[] }): (StatementLine | null)[] {
  const lines = Array.isArray(file.lines) ? file.lines : []
  const read = reader()
  if (file.kind === 'paystub') {
    const money = lines.filter((l) => MONEY.test(l.text))
    for (const re of read.stubPay) {
      const found = money.find((l) => re.test(l.text))
      if (found) return [found]
    }
    return [money[0] ?? lines[0] ?? null]
  }
  if (file.kind === 'bank-statement')
    return lines.filter(
      (l) =>
        MONEY.test(l.text) &&
        SHORT_DATE.test(l.text) &&
        !NOT_A_PAY.test(l.text) &&
        !(read.moneyIn.test(l.text) && !DIRECT_DEPOSIT.test(l.text))
    )
  if (file.kind === 'payroll-register')
    return lines.filter(
      (l) =>
        MONEY.test(l.text) &&
        /\p{L}{2,}/u.test(l.text.replace(MONEY_ALL, '')) &&
        !NOT_A_PAY.test(l.text) &&
        !read.registerHeading.test(l.text)
    )
  return []
}

/**
 * The person-pays in one payroll file (`allPayLines`), the first MAX_PAY_LINES of them. A file with more is flagged
 * (`overPayLineCap`) on the match screens and in the reconciliation: never cut short in silence.
 */
export function payLinesOf(file: {
  kind: string
  lines: StatementLine[]
}): (StatementLine | null)[] {
  return allPayLines(file).slice(0, MAX_PAY_LINES)
}

/** Whether the file has more person-pays than are read. */
export const overPayLineCap = (file: { kind: string; lines: unknown }) =>
  allPayLines({ kind: file.kind, lines: file.lines as StatementLine[] }).length > MAX_PAY_LINES

/**
 * Whether two boxes are the same printed line: the same page, overlapping across, and over half of the lower one's
 * height shared. A proof link's mark or highlights cover the pay's line when they are.
 */
export function sameLine(a: StatementMark, b: StatementMark): boolean {
  if (a.page !== b.page) return false
  const across = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const up = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return across > 0 && up > 0.5 * Math.min(a.height, b.height)
}

/** A proof link covers this pay line: its marked line or one of its highlights sits on it (a pay stub: any link). */
export function linkCovers(
  link: { mark?: unknown; marks?: unknown },
  kind: PayLineKind,
  line: StatementMark | null
): boolean {
  if (kind === 'paystub' || !line) return true
  const boxes = [
    ...(link.mark ? [link.mark as StatementMark] : []),
    ...(Array.isArray(link.marks) ? (link.marks as StatementMark[]) : []),
  ]
  return boxes.some((b) => sameLine(b, line))
}
