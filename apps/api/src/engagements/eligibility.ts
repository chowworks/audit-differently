import { DEFAULT_ELIGIBILITY_ITEMS, type EligibilityItemDef } from '@ad/types'

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)

/** The engagement's participant-file checklist: what its owners set, or the defaults. */
export function eligibilityItemsOf(e: { eligibilityItems: unknown }): EligibilityItemDef[] {
  const raw = Array.isArray(e.eligibilityItems) ? (e.eligibilityItems as EligibilityItemDef[]) : []
  const clean = raw.filter((i) => i && typeof i.key === 'string' && typeof i.label === 'string')
  return clean.length
    ? clean.map((i) => ({ key: i.key, label: i.label, required: !!i.required }))
    : DEFAULT_ELIGIBILITY_ITEMS
}

/** Validates and normalizes a checklist from a request; throws a plain message on a bad one. */
export function cleanEligibilityItems(input: unknown): EligibilityItemDef[] {
  if (!Array.isArray(input)) throw new Error('eligibilityItems must be a list')
  if (input.length > 30) throw new Error('Up to 30 items')
  const out: EligibilityItemDef[] = []
  const seen = new Set<string>()
  for (const raw of input as Partial<EligibilityItemDef>[]) {
    const label = String(raw?.label ?? '').trim()
    if (!label || label.length > 60)
      throw new Error('Each item needs a label of up to 60 characters')
    const key =
      (typeof raw?.key === 'string' && raw.key.trim() ? slug(raw.key) : slug(label)) ||
      `item-${out.length + 1}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ key, label, required: !!raw?.required })
  }
  if (out.length === 0) throw new Error('Keep at least one item, or reset to the defaults')
  return out
}
