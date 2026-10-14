import type { LoggedChange } from '@ad/types'

/**
 * How a field appears in the access log. A field with `show` keeps its value (amounts, dates, statuses and other
 * facts of a financial record); a field without it keeps its name alone. Leaving `show` out is the safe default:
 * a participant's name or number, a person's name, and any free text never reach the log.
 */
export interface FieldSpec {
  label: string
  show?: 'text' | 'money' | 'date' | 'list'
  /** For a stored key, the words the screen shows for it (ROLE_LABELS, REPORT_LINE_LABELS, …). */
  labels?: Record<string, string>
}

export type Fields = Record<string, FieldSpec>

type Values = Record<string, unknown>

const blank = (v: unknown) =>
  v == null || v === '' || (Array.isArray(v) && v.length === 0) ? null : v

function shown(v: unknown, spec: FieldSpec): string | null {
  const show = spec.show
  const x = blank(v)
  if (x == null) return null
  if (spec.labels) {
    const word = (k: unknown) => spec.labels?.[String(k)] ?? String(k)
    return Array.isArray(x) ? x.map(word).join(', ') : word(x)
  }
  if (show === 'money') return Number(x).toFixed(2)
  if (show === 'date')
    return x instanceof Date ? x.toISOString().slice(0, 10) : String(x).slice(0, 10)
  if (show === 'list') return Array.isArray(x) ? x.join(', ') : String(x)
  return String(x)
}

/** A comparable form of a value, never logged. */
const key = (v: unknown) => {
  const x = blank(v)
  return x instanceof Date ? x.toISOString() : JSON.stringify(x)
}

/**
 * The fields of `fields` that a change touched. `before` is null for a new row, `after` null for a removed one; on
 * an update, `after` holds only what the request set. Values appear only for fields with `show`.
 */
export function changesOf(
  before: Values | null,
  after: Values | null,
  fields: Fields
): LoggedChange[] {
  const out: LoggedChange[] = []
  for (const [k, spec] of Object.entries(fields)) {
    if (before && after && !(k in after)) continue
    const b = before ? blank(before[k]) : null
    const a = after ? blank(after[k]) : null
    if (b == null && a == null) continue
    if (!spec.show) {
      if (!(before && after && key(b) === key(a))) out.push({ field: spec.label })
      continue
    }
    const c: LoggedChange = { field: spec.label }
    if (before) c.before = shown(b, spec)
    if (after) c.after = shown(a, spec)
    if (before && after && c.before === c.after) continue
    out.push(c)
  }
  return out
}

/** Money as the log writes it in a sentence: $1,234.50. */
export const dollars = (v: unknown) =>
  `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** A month as the screens say it: 2026-09 is September 2026. */
export const monthName = (period: string) =>
  new Date(`${period}-01T00:00:00Z`).toLocaleString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })

/** A count in words: 1 file, 2 files. */
export const howMany = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
