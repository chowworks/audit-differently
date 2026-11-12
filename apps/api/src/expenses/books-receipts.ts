import { score } from '../receipts/match'

/**
 * The receipts of the books' bills (owner's decision, 2026-11-12): a books line on an engagement is a share of one or
 * more bills (the transaction itself, or each bill of the pool an allocation entry shares out), and the month's workspace
 * receipts (the zip's "Receipts" folder) prove the bills, never the share. Each bill has at most one receipt, and each
 * receipt proves at most one bill. Pure.
 */

export interface PlanBill {
  transactionId: string
  /** yyyy-mm-dd */
  date: string
  vendor: string
  /** The whole bill, as its receipt shows it. */
  amount: number
}

export interface PlanReceipt {
  id: string
  fileName: string
  amount: number | null
  /** yyyy-mm-dd */
  date: string | null
  vendor: string | null
}

/** An owner's word on a bill: the receipt that proves it, or dropped for want of one. */
export interface PlanBillChoice {
  transactionId: string
  documentId: string | null
  dropped: boolean
}

export interface BillReceipt {
  documentId: string
  by: 'auto' | 'person'
}

/**
 * The receipt of each bill. An owner's choice first; then, among the rest, a receipt and a bill are matched when each
 * is the other's only candidate: the amount to the cent (or one cent off), dates within a week (`score`). A receipt
 * that fits two bills, or a bill two receipts fit, waits for an owner. A dropped bill takes none.
 */
export function receiptsOfBills(
  bills: PlanBill[],
  receipts: PlanReceipt[],
  choices: PlanBillChoice[]
): Map<string, BillReceipt> {
  const out = new Map<string, BillReceipt>()
  const used = new Set<string>()
  const known = new Set(receipts.map((r) => r.id))
  const chosen = new Map(choices.map((c) => [c.transactionId, c]))
  for (const b of bills) {
    const c = chosen.get(b.transactionId)
    if (c && !c.dropped && c.documentId && known.has(c.documentId) && !used.has(c.documentId)) {
      out.set(b.transactionId, { documentId: c.documentId, by: 'person' })
      used.add(c.documentId)
    }
  }
  const open = () =>
    bills.filter((b) => !out.has(b.transactionId) && !chosen.get(b.transactionId)?.dropped)
  const fits = (r: PlanReceipt, b: PlanBill) =>
    r.amount != null &&
    !!score(
      { id: r.id, amount: r.amount, date: r.date, vendor: r.vendor },
      { id: b.transactionId, amount: b.amount, date: b.date, vendor: b.vendor }
    )
  for (let changed = true; changed;) {
    changed = false
    const free = receipts.filter((r) => !used.has(r.id))
    const left = open()
    for (const b of left) {
      const rs = free.filter((r) => !used.has(r.id) && fits(r, b))
      if (rs.length !== 1) continue
      const r = rs[0]!
      if (left.filter((o) => !out.has(o.transactionId) && fits(r, o)).length !== 1) continue
      out.set(b.transactionId, { documentId: r.id, by: 'auto' })
      used.add(r.id)
      changed = true
    }
  }
  return out
}
