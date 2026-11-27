import { aliasKey } from '@ad/types'
import { budgetLineOfCategory, type AccountMappingRead } from '../expenses/account-mapping'
import { writeFor, type AliasRow } from './resolve'

/**
 * An account mapping file's accounts as QuickBooks names (#132): each account as QuickBooks writes it ("60901 Rent
 * Expense") and the budget line its category bills to, by name: the line of the file's side box when the file's
 * engagement is known (`lines`), else the line the box names, else the category itself. An account left blank goes to
 * null (Unallowable, when the engagement is known).
 */
export function mappingNames(
  read: Pick<AccountMappingRead, 'accounts' | 'names' | 'categories'>,
  lines: { id: string; name: string; amount: number }[] | null
): { name: string; budgetLineName: string | null }[] {
  const lineOf = (category: string) => {
    const box = read.categories.find((c) => aliasKey(c.category) === aliasKey(category))
    return (lines && budgetLineOfCategory(category, read, lines)?.name) ?? box?.line ?? category
  }
  return Object.keys(read.accounts).map((no) => {
    const category = read.accounts[no]
    return {
      name: `${no} ${read.names[no] ?? ''}`.trim(),
      budgetLineName: category ? lineOf(category) : null,
    }
  })
}

/**
 * The list several account mapping files make, merged in order as the workspace page merges them (`writeFor`): for
 * the sample and the tests, which plan the books with no database.
 */
export function listOfMappings(
  files: {
    read: Pick<AccountMappingRead, 'accounts' | 'names' | 'categories'>
    engagement: { id: string; budgetLines: { id: string; name: string; amount: number }[] } | null
  }[]
): AliasRow[] {
  const rows: AliasRow[] = []
  for (const f of files)
    for (const n of mappingNames(f.read, f.engagement?.budgetLines ?? null)) {
      if (!f.engagement) continue
      const w = writeFor({ ...n, engagementId: f.engagement.id }, rows)
      if (!w) continue
      const at = rows.findIndex(
        (r) => r.engagementId === w.engagementId && aliasKey(r.name) === aliasKey(w.name)
      )
      const row = { id: `alias-${rows.length}`, ...w }
      if (at >= 0) rows[at] = { ...row, id: rows[at]!.id }
      else rows.push(row)
    }
  return rows
}
