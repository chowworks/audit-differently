import { RECEIPT_KINDS, type ReceiptDto, type ReceiptMatching, type ReceiptReadBy } from '@ad/types'
import { documentDto } from '../documents/document.dto'
import { aiConfigured } from '../imports/ai-guess'
import { suggest, type ExpenseFacts, type ReceiptFacts } from './match'

const isoDate = (d: Date) => d.toISOString().slice(0, 10)

/** A month's receipt row as matching reads it: the document, what was read, and the expenses it is linked to. */
export type ReceiptRow = Parameters<typeof documentDto>[0] & {
  engagementId: string | null
  receiptAmount?: unknown
  receiptDate?: Date | null
  receiptVendor?: string | null
  receiptReadBy?: string | null
  receiptDismissed?: boolean
  expenses?: { purpose?: string; expense: { id: string; itemNumber: string } }[]
}

/** The query for a month's receipts: financial receipts and invoices of the engagement filed in that month. */
export const receiptsWhere = (engagementId: string, period: string) => ({
  engagementId,
  period,
  sensitivity: 'financial',
  kind: { in: [...RECEIPT_KINDS] },
})

export const receiptsInclude = {
  expenses: { include: { expense: { select: { id: true, itemNumber: true } } } },
} as const

export function receiptDto(d: ReceiptRow): ReceiptDto {
  return {
    document: documentDto(d),
    amount: d.receiptAmount == null ? null : Number(d.receiptAmount),
    date: d.receiptDate ? isoDate(d.receiptDate) : null,
    vendor: d.receiptVendor ?? null,
    readBy: (d.receiptReadBy as ReceiptReadBy | null) ?? null,
    dismissed: !!d.receiptDismissed,
    // Matched means the expense's invoice proof; the same file attached as another proof is not a match.
    matchedTo: (d.expenses ?? [])
      .filter((l) => l.purpose === 'invoice')
      .map((l) => ({
        expenseId: l.expense.id,
        itemNumber: l.expense.itemNumber,
      })),
  }
}

export const receiptFacts = (r: ReceiptDto): ReceiptFacts => ({
  id: r.document.id,
  amount: r.amount,
  date: r.date,
  vendor: r.vendor,
})

/** An expense with no invoice proof yet, as matching sees it. */
export const expenseFacts = (e: {
  id: string
  totalCost: unknown
  date: Date
  vendor: string
}): ExpenseFacts => ({
  id: e.id,
  amount: Number(e.totalCost),
  date: isoDate(e.date),
  vendor: e.vendor,
})

/** Expenses that still need invoice proof (an invoice, receipt or purchase order). */
export const needsInvoice = (e: { documents: { purpose: string }[] }) =>
  !e.documents.some((d) => d.purpose === 'invoice')

/**
 * The month's matching panel: its receipts (personal documents are never among them: the query takes financial
 * receipts and invoices only, and so does this filter) and the suggestions for each unmatched one.
 */
export function matchingOf(
  rows: ReceiptRow[],
  expenses: {
    id: string
    totalCost: unknown
    date: Date
    vendor: string
    documents: { purpose: string }[]
  }[]
): ReceiptMatching {
  const receipts = rows
    .filter(
      (d) => d.sensitivity === 'financial' && (RECEIPT_KINDS as readonly string[]).includes(d.kind)
    )
    .map(receiptDto)
  const open = receipts.filter((r) => !r.dismissed && r.matchedTo.length === 0)
  return {
    receipts,
    suggestions: suggest(open.map(receiptFacts), expenses.filter(needsInvoice).map(expenseFacts)),
    aiAvailable: aiConfigured(),
  }
}
