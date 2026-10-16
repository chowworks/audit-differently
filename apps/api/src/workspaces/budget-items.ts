import { BadRequestException } from '@nestjs/common'
import { randomBytes } from 'node:crypto'
import { REPORT_LINES, REPORT_LINE_LABELS, type BudgetItem, type ReportLine } from '@ad/types'

/** A workspace's budget items as stored (a JSON column, DEFAULT_BUDGET_ITEMS until its owners change it). */
export function budgetItemsOf(w: { budgetItems?: unknown }): BudgetItem[] {
  return Array.isArray(w.budgetItems) ? (w.budgetItems as BudgetItem[]) : []
}

/** An item as the access log shows it: "Travel (Program Costs)". */
export const budgetItemWords = (i: BudgetItem) => `${i.label} (${REPORT_LINE_LABELS[i.reportLine]})`

/**
 * The list an owner saved, checked against the list it replaces. An item that names a key keeps it, and its report
 * line: a later mapping of imported categories, and every engagement's lines, rely on both. An item without a key is
 * new and gets one made from its label, with a random tail so it never takes the key of an item removed earlier.
 */
export function cleanBudgetItems(given: unknown, before: BudgetItem[]): BudgetItem[] {
  const bad = (m: string) => new BadRequestException(m)
  if (!Array.isArray(given)) throw bad('budgetItems must be a list')
  if (given.length > 60) throw bad('Up to 60 budget items')
  const known = new Map(before.map((i) => [i.key, i]))
  const keys = new Set<string>()
  const labels = new Set<string>()
  return given.map((raw) => {
    const item = (raw ?? {}) as Partial<BudgetItem>
    const label = typeof item.label === 'string' ? item.label.trim() : ''
    if (!label) throw bad('Each budget item needs a name')
    if (label.length > 80) throw bad('Keep each budget item under 80 characters')
    if (labels.has(label.toLowerCase())) throw bad(`${label} is in the list twice`)
    labels.add(label.toLowerCase())
    if (!REPORT_LINES.includes(item.reportLine as ReportLine))
      throw bad(`Choose the report line ${label} rolls into`)
    const reportLine = item.reportLine as ReportLine
    let key: string
    if (item.key !== undefined && item.key !== null) {
      const was = known.get(String(item.key))
      if (!was) throw bad(`${label} is not an item of this list`)
      if (was.reportLine !== reportLine)
        throw bad(
          `${was.label} rolls into ${REPORT_LINE_LABELS[was.reportLine]}. To use another line, remove it and add a new item`
        )
      key = was.key
    } else {
      const slug =
        label
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 40) || 'item'
      do key = `${slug}-${randomBytes(2).toString('hex')}`
      while (known.has(key) || keys.has(key))
    }
    if (keys.has(key)) throw bad(`${label} is in the list twice`)
    keys.add(key)
    return { key, label, reportLine }
  })
}
