import { BadRequestException } from '@nestjs/common'
import { randomBytes } from 'node:crypto'
import {
  TAG_TARGET_LABELS,
  TAG_TARGETS,
  tagLabel,
  type TagTarget,
  type TagType,
  type TagValue,
} from '@ad/types'

const bad = (m: string) => new BadRequestException(m)

/** A workspace's own tag types as stored (a JSON column, empty until its owners add one). */
export function tagTypesOf(w: { tagTypes?: unknown }): TagType[] {
  return Array.isArray(w.tagTypes) ? (w.tagTypes as TagType[]) : []
}

/** Every tag type of a workspace ("Funding source" is one like any other). */
export const allTagTypes = (w: { tagTypes?: unknown }) => tagTypesOf(w)

/** A type as the access log shows it: "Age group (Participants): Under 18, 18 to 24". Owners' labels, never personal. */
export const tagTypeWords = (t: TagType) =>
  `${t.label} (${t.appliesTo.map((a) => TAG_TARGET_LABELS[a]).join(', ')}): ${t.values.map((v) => v.label).join(', ')}`

/** Every tag of a workspace in words, for `changesOf`'s `labels`: tag → "Age group: Under 18". */
export function tagWords(w: { tagTypes?: unknown }) {
  const types = allTagTypes(w)
  const out: Record<string, string> = {}
  for (const t of types)
    for (const v of t.values) out[`${t.key}:${v.key}`] = tagLabel(types, `${t.key}:${v.key}`)
  return out
}

/** A new key made from a label, with a random tail so it never takes the key of one removed earlier. */
function newKey(label: string, taken: (k: string) => boolean): string {
  const slug =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'tag'
  let key: string
  do key = `${slug}-${randomBytes(2).toString('hex')}`
  while (taken(key))
  return key
}

/** A label: trimmed, required, at most 60 characters. */
function labelOf(given: unknown, what: string): string {
  const label = typeof given === 'string' ? given.trim() : ''
  if (!label) throw bad(`Each ${what} needs a name`)
  if (label.length > 60) throw bad(`Keep each ${what} under 60 characters`)
  return label
}

/**
 * The tag types an owner saved, checked against the list they replace. A type or value that names a key keeps it, so
 * a rename keeps every record's tags; one without a key is new and gets one. A type or value left out is removed
 * (`removedTags`): the caller takes it off every record in the same transaction.
 */
export function cleanTagTypes(given: unknown, before: TagType[]): TagType[] {
  if (!Array.isArray(given)) throw bad('tagTypes must be a list')
  if (given.length > 20) throw bad('Up to 20 tag types')
  const known = new Map(before.map((t) => [t.key, t]))
  const keys = new Set<string>()
  const labels = new Set<string>()
  return given.map((raw) => {
    const t = (raw ?? {}) as Partial<TagType>
    const label = labelOf(t.label, 'tag type')
    if (labels.has(label.toLowerCase())) throw bad(`${label} is in the list twice`)
    labels.add(label.toLowerCase())
    const appliesTo = TAG_TARGETS.filter(
      (x) => Array.isArray(t.appliesTo) && t.appliesTo.includes(x)
    )
    if (
      !Array.isArray(t.appliesTo) ||
      appliesTo.length === 0 ||
      t.appliesTo.some((x) => !TAG_TARGETS.includes(x as TagTarget))
    )
      throw bad(
        `Choose what ${label} applies to: engagements, expenses, payroll items or participants`
      )
    let was: TagType | undefined
    if (t.key !== undefined && t.key !== null) {
      was = known.get(String(t.key))
      if (!was) throw bad(`${label} is not a tag type of this list`)
    }
    const key = was?.key ?? newKey(label, (k) => known.has(k) || keys.has(k))
    if (keys.has(key)) throw bad(`${label} is in the list twice`)
    keys.add(key)
    return { key, label, appliesTo, values: cleanValues(t.values, was?.values ?? [], label) }
  })
}

function cleanValues(given: unknown, before: TagValue[], type: string): TagValue[] {
  if (!Array.isArray(given) || given.length === 0) throw bad(`Give ${type} at least one value`)
  if (given.length > 50) throw bad(`Up to 50 values for ${type}`)
  const known = new Map(before.map((v) => [v.key, v]))
  const keys = new Set<string>()
  const labels = new Set<string>()
  return given.map((raw) => {
    const v = (raw ?? {}) as Partial<TagValue>
    const label = labelOf(v.label, 'value')
    if (labels.has(label.toLowerCase())) throw bad(`${label} is in ${type} twice`)
    labels.add(label.toLowerCase())
    let key: string
    if (v.key !== undefined && v.key !== null) {
      const was = known.get(String(v.key))
      if (!was) throw bad(`${label} is not a value of ${type}`)
      key = was.key
    } else key = newKey(label, (k) => known.has(k) || keys.has(k))
    if (keys.has(key)) throw bad(`${label} is in ${type} twice`)
    keys.add(key)
    return { key, label }
  })
}

/**
 * The tags a record is given, checked against the workspace's list: only values of types that apply to this kind
 * of record, no free text, each once, in the list's order. A tag the record already had stays allowed if it is no
 * longer offered (a type that stopped applying to this kind of record), so editing never forces it off.
 */
export function cleanTags(
  given: unknown,
  w: { tagTypes?: unknown },
  target: TagTarget,
  had: string[] = []
): string[] {
  if (given === undefined || given === null) return []
  if (!Array.isArray(given) || given.some((t) => typeof t !== 'string'))
    throw bad('tags must be a list')
  const allowed = allTagTypes(w)
    .filter((t) => t.appliesTo.includes(target))
    .flatMap((t) => t.values.map((v) => `${t.key}:${v.key}`))
  const wanted = new Set(given as string[])
  for (const tag of wanted)
    if (!allowed.includes(tag) && !had.includes(tag))
      throw bad(
        `${tag} is not a tag of this workspace for ${TAG_TARGET_LABELS[target].toLowerCase()}`
      )
  return [...allowed, ...had.filter((t) => !allowed.includes(t))].filter((t) => wanted.has(t))
}

/** A removed tag: what the list had, in its words, for the access log. */
export interface RemovedTag {
  tag: string
  type: string
  value: string
}

/** The tags `before` had that `after` no longer has: a value removed, or every value of a type removed. */
export function removedTags(before: TagType[], after: TagType[]): RemovedTag[] {
  const kept = new Set(after.flatMap((t) => t.values.map((v) => `${t.key}:${v.key}`)))
  return before.flatMap((t) =>
    t.values
      .filter((v) => !kept.has(`${t.key}:${v.key}`))
      .map((v) => ({ tag: `${t.key}:${v.key}`, type: t.label, value: v.label }))
  )
}
