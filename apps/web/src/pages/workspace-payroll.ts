import type {
  PayrollMatchSaveInput,
  PayrollSlot,
  WorkspacePayrollItemDto,
  WorkspacePayrollRunDto,
} from '@ad/types'

/** The proofs a payroll item needs: a participant's pay stub, a staff line's bank line. */
export const slotsOf = (i: Pick<WorkspacePayrollItemDto, 'kind'>): PayrollSlot[] =>
  i.kind === 'participant' ? ['timesheet', 'register', 'stub'] : ['timesheet', 'register', 'bank']
export const keyOf = (i: { target: string; id: string }) => `${i.target}-${i.id}`
export const slotKey = (i: { target: string; id: string }, slot: PayrollSlot) =>
  `${keyOf(i)}-${slot}`

/** The owner's choices on the match table: a file chosen by hand per item and slot. */
export type Picks = Record<string, Partial<Record<PayrollSlot, string>>>

type Run = Pick<WorkspacePayrollRunDto, 'items' | 'slots'>

/** Auto-Match's pick for an item's slot, and whether it is sure enough for the server to link it on its own. */
export function autoPick(run: Run, i: { target: string; id: string }, slot: PayrollSlot) {
  const m = run.slots.find((s) => s.target === i.target && s.id === i.id && s.slot === slot)
  const pick = m?.pick ?? null
  const c = pick ? m!.candidates.find((x) => x.fileId === pick) : undefined
  // A bank statement proves a payment only by its line: the server never links one without it.
  const sure = !!c?.sure && !(slot === 'bank' && !c.mark)
  return { pick, sure }
}

/** A bank statement chosen with no line found for the item is left for the reconciliation, never saved. */
export function lacksLine(
  run: Run,
  i: { target: string; id: string },
  slot: PayrollSlot,
  fileId: string
) {
  if (slot !== 'bank') return false
  const m = run.slots.find((s) => s.target === i.target && s.id === i.id && s.slot === slot)
  return !m?.candidates.find((c) => c.fileId === fileId)?.mark
}

/**
 * The links Save sends: the owner's own decisions only (owner's decision, 2026-10-18). The server links Auto-Match's
 * sure picks itself on every match, so a default pick is never sent; a file the owner chose instead of the pick is, and
 * so is a guess the owner confirmed (Auto-Match's pick that was not sure, accepted by Confirm or chosen by hand).
 */
export function ownLinks(
  run: Run,
  picks: Picks,
  confirmed: Set<string>
): PayrollMatchSaveInput['links'] {
  const out: PayrollMatchSaveInput['links'] = []
  for (const i of run.items)
    for (const slot of slotsOf(i)) {
      if (i.proved.includes(slot)) continue
      const auto = autoPick(run, i, slot)
      const manual = picks[keyOf(i)]?.[slot]
      const value = manual ?? auto.pick ?? ''
      if (!value || lacksLine(run, i, slot, value)) continue
      const changed = manual !== undefined && manual !== auto.pick
      const confirmedGuess = !auto.sure && (confirmed.has(slotKey(i, slot)) || manual !== undefined)
      if (changed || confirmedGuess) out.push({ target: i.target, id: i.id, slot, fileId: value })
    }
  return out
}

/** The contents' sha256, as hex: the server knows a file by it. */
export async function sha256Hex(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * How many different files (by contents) a zip holds: what Replace all tells the server, so Save waits until every
 * one of them has arrived. The same file twice in the zip is one file.
 */
export async function distinctFileCount(
  files: Blob[],
  hash: (f: Blob) => Promise<string> = sha256Hex
): Promise<number> {
  const seen = new Set<string>()
  for (const f of files) seen.add(await hash(f))
  return seen.size
}
