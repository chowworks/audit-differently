import { aliasKey } from '@ad/types'

/** A row of the QuickBooks names list as the lookup reads it. */
export interface AliasRow {
  id: string
  engagementId: string | null
  name: string
  budgetLineName: string | null
  unallowable: boolean
}

/** Where a QuickBooks name goes on one engagement, and why. */
export type Resolved<L> =
  | { status: 'line'; line: L; alias: AliasRow | null }
  | { status: 'unallowable'; alias: AliasRow }
  /** The list names a budget line this engagement has no line of that name for. */
  | { status: 'no-line'; alias: AliasRow; want: string }
  | { status: 'unmapped' }

/**
 * A QuickBooks name on one engagement (owner's decision, 2026-11-27, #132): the engagement's own override, else the
 * workspace's entry, else the engagement's budget line named as the name itself is; or unmapped. An entry names a budget
 * line by its name, so it goes to the engagement's line of that name.
 */
export function resolveAlias<L extends { name: string }>(
  name: string,
  engagementId: string,
  aliases: AliasRow[],
  lines: L[]
): Resolved<L> {
  const key = aliasKey(name)
  if (!key) return { status: 'unmapped' }
  const find = (k: string) =>
    aliases.find((a) => a.engagementId === engagementId && aliasKey(a.name) === k) ??
    aliases.find((a) => a.engagementId === null && aliasKey(a.name) === k)
  // The name exactly as the books write it first. An account written with its parents ("60000 G&A:60901 Rent
  // Expense") is then found by an entry of its own part ("60901 Rent Expense"), as an account mapping sheet writes it;
  // the list keeps each name as given, never shortened (owner's rule, 2026-11-27).
  const own = name.includes(':') ? aliasKey(name.split(':').pop()!) : ''
  const hit = find(key) ?? (own && own !== key ? find(own) : undefined)
  const lineNamed = (n: string) => lines.find((l) => aliasKey(l.name) === aliasKey(n)) ?? null
  if (hit) {
    if (hit.unallowable) return { status: 'unallowable', alias: hit }
    const line = lineNamed(hit.budgetLineName ?? '')
    if (line) return { status: 'line', line, alias: hit }
    // The workspace's line is not on this engagement, but a line named as the name itself is: that one.
    const same = hit.engagementId === null ? lineNamed(name) : null
    if (same) return { status: 'line', line: same, alias: null }
    return { status: 'no-line', alias: hit, want: hit.budgetLineName ?? '' }
  }
  const line = lineNamed(name)
  return line ? { status: 'line', line, alias: null } : { status: 'unmapped' }
}

/** What a person chose for a name on one engagement: a budget line's name, or Unallowable (null). */
export interface AliasChoice {
  name: string
  engagementId: string
  budgetLineName: string | null
}

/** A write the list needs for a choice: a new or changed workspace entry, or an engagement's override. */
export interface AliasWrite {
  engagementId: string | null
  name: string
  budgetLineName: string | null
  unallowable: boolean
}

/**
 * How a choice is kept (owner's decision, 2026-11-27): a name the workspace has no entry for becomes the workspace's
 * (its budget line carries to every engagement with a line of that name), except Unallowable, which is this engagement's
 * alone; a choice that differs from the workspace's entry is this engagement's override. Nothing when the list already
 * says it.
 */
export function writeFor(choice: AliasChoice, aliases: AliasRow[]): AliasWrite | null {
  const key = aliasKey(choice.name)
  const target = choice.budgetLineName ? aliasKey(choice.budgetLineName) : null
  const says = (a: AliasRow | undefined) =>
    !!a &&
    (target === null
      ? a.unallowable
      : !a.unallowable && aliasKey(a.budgetLineName ?? '') === target)
  const own = aliases.find(
    (a) => a.engagementId === choice.engagementId && aliasKey(a.name) === key
  )
  const ws = aliases.find((a) => a.engagementId === null && aliasKey(a.name) === key)
  if (says(own) || (!own && says(ws))) return null
  const write = {
    name: choice.name.trim(),
    budgetLineName: choice.budgetLineName?.trim() || null,
    unallowable: choice.budgetLineName === null,
  }
  if (!ws && !own && !write.unallowable) return { ...write, engagementId: null }
  return { ...write, engagementId: choice.engagementId }
}
