import type { Prisma } from '@prisma/client'
import { RECEIPT_KINDS } from '@ad/types'

/**
 * The receipts the books' bills are matched to (owner's decision, 2026-11-12): the month's financial receipts and
 * invoices, the workspace's own (the zip's "Receipts" folder) and those filed to an engagement's month (emailed, or
 * uploaded there), but not one dismissed or already the proof of a line that is not from the books. File
 * Management's Receipts folder, and its download, list the same.
 */
export const monthReceiptsWhere = (
  workspaceId: string,
  period: string
): Prisma.DocumentWhereInput => ({
  workspaceId,
  period,
  sensitivity: 'financial',
  kind: { in: [...RECEIPT_KINDS] },
  receiptDismissed: false,
  NOT: { expenses: { some: { purpose: 'invoice', expense: { booksKey: null } } } },
})
