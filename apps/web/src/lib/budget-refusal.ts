import type { BudgetFileDto } from '@ad/types'
import { ApiError } from '@/services/api'

/**
 * The check a refused budget upload carries (GitHub issue #98): Save checks the file again against the budget as it
 * stands, which may have changed since the person checked it (an expense added to a line the file leaves out, another
 * upload). The refusal answers with that check, so the screen shows it, with every problem and its row, in place of the
 * one the person saw. Null for any other error.
 */
export function refusedCheck(e: unknown): BudgetFileDto | null {
  if (!(e instanceof ApiError) || e.status !== 400) return null
  const check = (e.body as { check?: unknown } | null)?.check as BudgetFileDto | undefined
  return check && Array.isArray(check.rows) && Array.isArray(check.problems) ? check : null
}
