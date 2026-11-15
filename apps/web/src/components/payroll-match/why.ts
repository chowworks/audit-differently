import type { PayrollSlot } from '@ad/types'

/**
 * The words both payroll match screens share (owner's decision, 2026-10-19): the bookkeeper's per-engagement wizard
 * (`PayrollProof.tsx`) and the owner's workspace match (`WorkspacePayrollPage.tsx`) look and work the same.
 */

export const SLOT_LABEL: Record<PayrollSlot, string> = {
  timesheet: 'Timesheet',
  register: 'Payroll register',
  stub: 'Pay stub',
  bank: 'Bank line',
}

/** "3 of 7 payroll items complete": as Payroll & Proof's Complete counts them once saved. */
export const provedWords = (proved: number, total: number) =>
  `${proved} of ${total} payroll item${total === 1 ? '' : 's'} complete`
