import {
  DOCUMENT_KIND_LABELS,
  PAYROLL_SLOT_KIND,
  STAFF_REPORT_LINES,
  type PayrollMatchSaveInput,
  type PayrollSlot,
  type PlanFileDto,
  type PlanProofDto,
  type StaffFoundDto,
  type StubPayDto,
  type WorkspacePayrollItemDto,
  type WorkspacePayrollRunDto,
} from '@ad/types'
import { money, payPeriodWords, shortDate } from '@/lib/format'
import { keyOf, slotsOf } from '@/pages/workspace-payroll'

/**
 * Step 2 of the workspace payroll page, in words (GitHub issue #22; owner's decisions, 2026-10-19): who was found, what
 * each item gets, and what Save will do, worked out from the run's plan and the owner's own choices on the table.
 */

type Run = Pick<WorkspacePayrollRunDto, 'items' | 'files' | 'plan' | 'pays' | 'slots'> &
  Partial<Pick<WorkspacePayrollRunDto, 'totalsOnly'>>
type Links = PayrollMatchSaveInput['links']

const count = (n: number, one: string, more = `${one}s`) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : more}`
const list = (parts: [number, string][]) =>
  parts
    .filter(([n]) => n > 0)
    .map(([n, w]) => `${n.toLocaleString('en-US')} ${w}`)
    .join(', ')

/** A staff payroll line (Staff Salaries, Staff Fringe): its proof comes from the staff tagged to its engagement. */
export const isStaffLine = (i: Pick<WorkspacePayrollItemDto, 'target' | 'sub'>) =>
  i.target === 'expense' && (STAFF_REPORT_LINES as readonly string[]).includes(i.sub)

/** Someone on the staff list found in the files, or tagged to an engagement: their row in Staff. */
export const staffRows = (run: Run): StaffFoundDto[] =>
  run.plan.staff.filter(
    (s) => s.engagements.length || s.timesheet.length || s.register.length || s.bank.length
  )
const foundInFiles = (s: StaffFoundDto) =>
  s.timesheet.length > 0 || s.register.length > 0 || s.bank.length > 0

/** The proof Save attaches, by item: the plan's links and the owner's own choices on the table. */
export function proofList(run: Run, chosen: Links): PlanProofDto[] {
  const out = run.plan.proof.map((p) => ({ ...p, files: [...p.files] }))
  for (const l of chosen) {
    const item = run.items.find((i) => i.target === l.target && i.id === l.id)
    const file = run.files.find((f) => f.id === l.fileId)
    if (!item || !file) continue
    let entry = out.find((p) => p.target === l.target && p.id === l.id)
    if (!entry) {
      entry = {
        target: item.target,
        id: item.id,
        stubFileId: null,
        title: item.title,
        engagementId: item.engagementId,
        engagementName: item.engagementName,
        reportId: item.reportId,
        files: [],
      }
      out.push(entry)
    }
    entry.files = entry.files.filter((f) => f.slot !== l.slot)
    entry.files.push({
      fileId: file.id,
      fileName: file.fileName,
      kind: file.kind,
      slot: l.slot,
      people: [],
    })
  }
  return out
}

/** Where an item's proof for a slot comes from after Save: on file now, attached by Save (with whose line), or nowhere. */
export function slotSource(
  i: WorkspacePayrollItemDto,
  slot: PayrollSlot,
  proof: PlanProofDto[]
): { on: 'file' } | { on: 'save'; people: string[] } | null {
  if (i.proved.includes(slot)) return { on: 'file' }
  const f = proof
    .find((p) => p.target === i.target && p.id === i.id)
    ?.files.find((x) => x.slot === slot)
  return f ? { on: 'save', people: f.people } : null
}

/** The slots still missing after Save. */
export const missingAfterSave = (i: WorkspacePayrollItemDto, proof: PlanProofDto[]) =>
  slotsOf(i).filter((s) => !slotSource(i, s, proof))

const SLOT_FILE: Record<PayrollSlot, string> = {
  timesheet: 'timesheet',
  register: 'payroll register',
  stub: 'pay stub',
  bank: 'bank statement',
}

/** Why a staff line's proof is still missing, in plain words, from the staff list and the files. */
export function staffMissingWhy(run: Run, i: WorkspacePayrollItemDto, slot: PayrollSlot): string {
  const tagged = run.plan.staff.filter((s) => s.engagements.some((e) => e.id === i.engagementId))
  if (!tagged.length) return 'Nobody is tagged to this engagement in Engagement staffing'
  if (!run.files.some((f) => f.kind === PAYROLL_SLOT_KIND[slot]))
    return `No ${SLOT_FILE[slot]} in the files`
  if (slot === 'bank') {
    const guessed = tagged.filter((s) => s.bankGuess.length && !s.bank.length)
    if (guessed.length)
      return `${guessed.map((s) => s.name).join(', ')}: bank line guessed by amount, confirm it in the reconciliation after Save`
  }
  return `Nobody tagged to this engagement was found in the ${SLOT_FILE[slot]}`
}

/** What Save does to one participant's payment: "payment to make $280.00", "payment corrected $300.00 → $280.00". */
export function paymentWords(x: StubPayDto): string {
  if (x.action === 'create' && x.grossAmount !== null)
    return `payment to make ${money(x.grossAmount)}`
  if (
    x.action === 'update' &&
    x.grossAmount !== null &&
    x.previousAmount !== null &&
    x.previousAmount !== x.grossAmount
  )
    return `payment corrected ${money(x.previousAmount)} → ${money(x.grossAmount)}`
  if (x.action === 'update' || x.action === 'same') return 'no change'
  return 'no payment: look at the flag'
}

const corrected = (x: StubPayDto) =>
  x.action === 'update' && x.previousAmount !== null && x.previousAmount !== x.grossAmount

/** One item in "Review the N fully proved": its name, engagement and amount, and the file of each proof. */
export interface ProvedRowDto {
  key: string
  title: string
  engagementName: string
  amount: number
  proofs: { slot: PayrollSlot; file: string | undefined }[]
}

/**
 * The payroll items fully proved once Save attaches the plan's proof (the owner's own choices on the table count only
 * once saved, as on the bookkeeper's wizard), and the payments a pay stub makes with every proof it needs.
 */
export function provedRows(run: Run, planned: PlanProofDto[]): ProvedRowDto[] {
  const fileOf = (p: PlanProofDto | undefined, slot: PayrollSlot) =>
    p?.files.find((f) => f.slot === slot)?.fileName
  const existing = run.items
    .filter((i) => missingAfterSave(i, planned).length === 0)
    .map((i) => {
      const p = planned.find((x) => x.target === i.target && x.id === i.id)
      return {
        key: keyOf(i),
        title: i.title,
        engagementName: i.engagementName,
        amount: i.amount,
        proofs: slotsOf(i).map((slot) => ({ slot, file: fileOf(p, slot) })),
      }
    })
  const slots = slotsOf({ kind: 'participant' })
  const made = planned
    .filter(
      (p) => p.target === 'wex' && !p.id && slots.every((s) => p.files.some((f) => f.slot === s))
    )
    .map((p) => ({
      key: proofKey(p),
      title: p.title,
      engagementName: p.engagementName,
      amount: run.plan.stubs.find((x) => x.fileId === p.stubFileId)?.grossAmount ?? 0,
      proofs: slots.map((slot) => ({ slot, file: fileOf(p, slot) })),
    }))
  return [...existing, ...made]
}

/** The files after Save that reach no engagement (a file the owner chose on the table does reach one). */
export function nowhereFiles(run: Run, chosen: Links): PlanFileDto[] {
  const picked = new Set(chosen.map((l) => l.fileId))
  return run.plan.files.filter((f) => !f.engagements.length && !picked.has(f.fileId))
}

/** The files after Save, and which reach an engagement (a file the owner chose on the table does too). */
export function filesWords(run: Run, chosen: Links): { line: string; nowhere: string[] } {
  const nowhere = nowhereFiles(run, chosen)
  const total = run.plan.files.length
  return {
    line: `${count(total, 'file')}: ${(total - nowhere.length).toLocaleString('en-US')} matched to your engagements, ${nowhere.length.toLocaleString('en-US')} matched to nothing`,
    nowhere: nowhere.map((f) => f.fileName),
  }
}

/** "Matched 6 payments for 3 participants: 3 to make, 1 to correct, 2 unchanged": one payment per pay run. */
export function paymentsWords(run: Run): string {
  const stubs = run.plan.stubs.filter((x) => x.action !== 'none')
  const made = stubs.filter((x) => x.action === 'create').length
  const fixed = stubs.filter(corrected).length
  const parts = list([
    [made, 'to make'],
    [fixed, 'to correct'],
    [run.plan.payments.remove, 'to remove'],
    [stubs.length - made - fixed, 'unchanged'],
  ])
  const people = new Set(stubs.map((x) => x.participant?.id ?? x.fileId)).size
  return `Matched ${count(stubs.length, 'payment')} for ${count(people, 'participant')}${parts ? `: ${parts}` : ''}`
}

/**
 * The payroll items fully proved already that Save attaches nothing to: with the items Save attaches proof to, the
 * same items the header's "N of M fully proved" counts.
 */
export const alreadyComplete = (run: Run, proof: PlanProofDto[]) =>
  run.items.filter(
    (i) =>
      missingAfterSave(i, proof).length === 0 &&
      !proof.some((p) => p.target === i.target && p.id === i.id)
  )

/**
 * "Proof attached: 39 files to 11 payroll items (1 already complete)" (and the proofs already on file, and what Save
 * unlinks).
 */
export function proofWords(run: Run, proof: PlanProofDto[]): string {
  const files = proof.reduce((n, p) => n + p.files.length, 0)
  const complete = alreadyComplete(run, proof).length
  const notes = [
    complete && `${complete.toLocaleString('en-US')} already complete`,
    run.plan.alreadyOnFile && `${run.plan.alreadyOnFile.toLocaleString('en-US')} already on file`,
  ].filter(Boolean)
  const removed = run.plan.unlinks ? `; ${count(run.plan.unlinks, 'link')} removed` : ''
  return `Proof attached: ${count(files, 'file')} to ${count(proof.length, 'payroll item')}${notes.length ? ` (${notes.join(', ')})` : ''}${removed}`
}

/** "Auto-matched 3 staff found in the files: Morgan Lee, Priya Shah, Sam Ortiz". */
export function staffWords(run: Run): string {
  const found = staffRows(run).filter(foundInFiles)
  if (!found.length) return 'Nobody on your staff list was found in the files'
  return `Auto-matched ${count(found.length, 'staff', 'staff')} found in the files: ${found.map((s) => s.name).join(', ')}`
}

/** A stable key for an item in a proof list. */
export const proofKey = (p: PlanProofDto) =>
  p.id ? keyOf({ target: p.target, id: p.id }) : `stub-${p.stubFileId}`

/** A file kind in words, capitalised: "Payroll register". */
export const kindWord = (k: string) => {
  const w = DOCUMENT_KIND_LABELS[k as keyof typeof DOCUMENT_KIND_LABELS] ?? k
  return w.charAt(0).toUpperCase() + w.slice(1)
}

/** The "Date" column: a staff line's date, a participant's pay period. */
export const paidWords = (i: Pick<WorkspacePayrollItemDto, 'kind' | 'start' | 'end'>) =>
  i.kind === 'participant' ? payPeriodWords(i.start, i.end) : shortDate(i.start)
