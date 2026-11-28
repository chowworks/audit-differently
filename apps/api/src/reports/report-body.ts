import type { ClosingInput, DocumentPurpose, ExpenseInput, WexPaymentInput } from '@ad/types'
import { BodyReader } from '../core/body'

const optional = { optional: true, nullable: true }

/**
 * The body of POST /reports/:id/expenses and PATCH /expenses/:id, with the type of each field checked. Both send the
 * whole expense. An edit that leaves out `tags` keeps the expense's tags, so `tags` is kept out when it is not sent.
 */
export function parseExpenseBody(body: unknown): ExpenseInput {
  const r = new BodyReader(body)
  const out: Record<string, unknown> = {
    itemNumber: r.string('itemNumber'),
    date: r.string('date'),
    vendor: r.string('vendor'),
    memo: r.string('memo', optional),
    account: r.string('account', optional),
    totalCost: r.numberLike('totalCost'),
    allocatedAmount: r.numberLike('allocatedAmount'),
    allocationType: r.string('allocationType'),
    allocationNote: r.string('allocationNote', optional),
    // Left out or null: the service asks for a budget line in plain words.
    budgetLineId: r.string('budgetLineId', optional) ?? null,
  }
  if (r.has('tags')) out.tags = r.strings('tags', optional)
  r.done()
  return out as unknown as ExpenseInput
}

/** The body of POST /reports/:id/wex and PATCH /wex/:id: who was paid, the pay period, the hours and the pay. */
export function parseWexBody(body: unknown): WexPaymentInput {
  const r = new BodyReader(body)
  const out = {
    participantId: r.string('participantId'),
    payPeriodStart: r.string('payPeriodStart'),
    payPeriodEnd: r.string('payPeriodEnd'),
    hours: r.numberLike('hours', optional),
    grossAmount: r.numberLike('grossAmount'),
    tags: r.strings('tags', optional),
  }
  r.done()
  return out as unknown as WexPaymentInput
}

/** The body of POST /expenses/:id/documents and POST /wex/:id/documents. The service checks the purpose. */
export function parseAttachBody(body: unknown): { documentId: string; purpose: DocumentPurpose } {
  const r = new BodyReader(body)
  const documentId = r.string('documentId')
  const purpose = r.string('purpose') as DocumentPurpose
  r.done()
  return { documentId, purpose }
}

/** The body of POST /reports/:id/closing: who approved the month-end closing, on which day, and a note. */
export function parseClosingBody(body: unknown): ClosingInput {
  const r = new BodyReader(body)
  const approvedBy = r.string('approvedBy')
  const approvedOn = r.string('approvedOn')
  const note = r.string('note', optional) ?? undefined
  r.done()
  return { approvedBy, approvedOn, note }
}

/** The body of POST /reports/:id/send-back and POST /reports/:id/reopen. The service asks for a reason in words. */
export function parseReasonBody(body: unknown): string {
  const r = new BodyReader(body)
  const reason = r.string('reason', optional) ?? ''
  r.done()
  return reason
}

/** The body of POST /reports/:id/request-edits. The service asks for a comment in words. */
export function parseCommentBody(body: unknown): string {
  const r = new BodyReader(body)
  const comment = r.string('comment', optional) ?? ''
  r.done()
  return comment
}
