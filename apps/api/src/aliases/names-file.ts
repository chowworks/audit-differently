/**
 * The Bulk Add Names file (#132): a sheet the team fills from the sample on the workspace page, one QuickBooks name a row,
 * with the budget line it goes to (or Unallowable) and, for an engagement's own answer, the engagement. Told from an
 * account mapping by its header row. Pure.
 */

export interface NamesFileRow {
  name: string
  /** The budget line's name; null: Unallowable; '' when the row leaves it blank (not added). */
  goesTo: string | null
  /** The engagement's name, number or code as the file writes it; null: the whole workspace. */
  engagement: string | null
}

// The sample's own headings, kept narrow so an account mapping (an "Account" column, a "Budget line" one) is never
// taken for this file.
const NAME = /^(financial category|quickbooks name)$/i
const GOES_TO = /^(maps to(?: budget category)?|goes to)$/i
const ENGAGEMENT = /^(applies to|engagement)$/i
const UNALLOWABLE = /^unallowable$/i

const cell = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()

/** The file's rows, or null when no header row in its first ten names a QuickBooks name and where it goes. */
export function namesFileOf(grid: string[][]): NamesFileRow[] | null {
  for (let h = 0; h < Math.min(grid.length, 10); h++) {
    const head = grid[h]!.map(cell)
    const name = head.findIndex((c) => NAME.test(c))
    const goes = head.findIndex((c) => GOES_TO.test(c))
    if (name < 0 || goes < 0) continue
    const eng = head.findIndex((c) => ENGAGEMENT.test(c))
    const rows: NamesFileRow[] = []
    for (const row of grid.slice(h + 1)) {
      const n = cell(row[name])
      const g = cell(row[goes])
      if (!n) continue
      rows.push({
        name: n,
        goesTo: g && UNALLOWABLE.test(g) ? null : g,
        engagement: eng >= 0 ? cell(row[eng]) || null : null,
      })
    }
    return rows
  }
  return null
}
