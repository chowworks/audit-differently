/**
 * Each engagement's colour on the staffing page and the payroll cards (GitHub issue #22): ten distinct colours, given
 * by the engagement's place in the workspace's list (the staff list's engagements, by name), and again after ten.
 */
export const ENGAGEMENT_COLORS = [
  '#0f766e',
  '#6d28d9',
  '#c2410c',
  '#1d4ed8',
  '#be123c',
  '#4d7c0f',
  '#a16207',
  '#0e7490',
  '#a21caf',
  '#475569',
] as const

/** The colour of each engagement id, in the order given. */
export function engagementColors(ids: string[]): Map<string, string> {
  return new Map(ids.map((id, i) => [id, ENGAGEMENT_COLORS[i % ENGAGEMENT_COLORS.length]!]))
}
