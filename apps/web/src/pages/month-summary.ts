import type { PayrollReconciliationDto, PayrollSlot } from '@ad/types'

/**
 * What the Summary step shows of the month's payroll (owner's decision, 2026-11-13), from the saved reconciliation: the
 * engagements' payroll items, those with every proof on file, the pay lines found on the bank statements, and each item
 * still missing a proof. Per engagement too, for its bar. Pure.
 */
export function payrollSummary(r: Pick<PayrollReconciliationDto, 'items' | 'unproved' | 'pays'>) {
  const unproved = new Set(r.unproved.map((u) => `${u.item.target}:${u.item.id}`))
  const engagements = new Map<string, { items: number; proved: number }>()
  for (const { item } of r.items) {
    const e = engagements.get(item.engagementId) ?? { items: 0, proved: 0 }
    e.items += 1
    if (!unproved.has(`${item.target}:${item.id}`)) e.proved += 1
    engagements.set(item.engagementId, e)
  }
  return {
    items: r.items.length,
    proved: r.items.length - r.unproved.length,
    bankPaid: r.pays.filter((p) => p.state === 'matched').length,
    engagements,
    todo: r.unproved.map((u) => ({
      title: u.item.title,
      engagementName: u.item.engagementName,
      missing: u.missing as PayrollSlot[],
    })),
  }
}
