import type { PayrollSlot, PayrollSlotMatch } from '@ad/types'

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

/** How a proof row of "How Auto-Match decided" came out. */
export type WhyTone = 'ok' | 'guess' | 'guessed' | 'next' | 'missing'

export const WHY_RESULT: Record<WhyTone, string> = {
  ok: '✓ Matched',
  guess: '⚠️ Best guess',
  guessed: '⚠️ Guessed',
  next: '→ Next step',
  missing: '✕ Not matched',
}

/** One proof row: what it is, how it came out, the file, and what was found there or why nothing was. */
export interface WhyRow {
  label: string
  tone: WhyTone
  file?: string
  text: string
}

/** One block of the panel: an item, a person, or the lines naming nobody. */
export interface WhyBlock {
  key: string
  title: string
  sub?: string
  rows: WhyRow[]
}

/** Where a value came from, after its reason: AI (checked against the file's text) or the payroll details. */
export const sourceWords = (source?: 'ai' | 'details' | 'rules') =>
  source === 'ai'
    ? " ✨ AI read it, checked against the file's text."
    : source === 'details'
      ? " From the payroll company's payroll details."
      : ''

/** "3 of 7 payroll items fully proved". */
export const provedWords = (proved: number, total: number) =>
  `${proved} of ${total} payroll item${total === 1 ? '' : 's'} fully proved`

/**
 * Why one slot of an item was filled or left empty: already attached, chosen by hand (or cleared), Auto-Match's pick
 * with the reason it gave, or the reason it picked nothing.
 */
export function slotWhy(input: {
  /** The proof already on file for the slot, with its file's name when known. */
  attached: { file?: string } | null
  /** The person's own choice: a file id, '' when they cleared it, undefined when they left Auto-Match's pick. */
  chosen: string | undefined
  match: PayrollSlotMatch | undefined
  fileName: (fileId: string) => string | undefined
  /** A bank statement chosen with no line found for the item: it is not saved as proof. */
  noLine: (fileId: string) => boolean
  /** Where such a payment goes next, in the screen's words. */
  noLineText: string
}): Omit<WhyRow, 'label'> {
  const { attached, chosen, match: m } = input
  if (attached) return { tone: 'ok', file: attached.file, text: 'Already attached.' }
  if (chosen === '') return { tone: 'missing', file: undefined, text: 'Cleared by you.' }
  const id = chosen ?? m?.pick ?? undefined
  const c = id ? m?.candidates.find((x) => x.fileId === id) : undefined
  if (id && input.noLine(id))
    return { tone: 'next', file: input.fileName(id), text: input.noLineText }
  if (chosen)
    return { tone: 'ok', file: input.fileName(chosen), text: `Chosen by you. ${c?.why ?? ''}` }
  if (!c) return { tone: 'missing', file: undefined, text: m?.why ?? 'Nothing read yet.' }
  return { tone: c.sure ? 'ok' : 'guess', file: input.fileName(c.fileId), text: c.why }
}
