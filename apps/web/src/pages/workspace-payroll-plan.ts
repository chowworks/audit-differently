import {
  DOCUMENT_KIND_LABELS,
  PAY_LINE_FLAG_LABELS,
  PAYROLL_SLOT_KIND,
  STAFF_REPORT_LINES,
  type PayrollMatchSaveInput,
  type PayrollSlot,
  type PlanFileDto,
  type PlanProofDto,
  type ProofSpotDto,
  type StaffFoundDto,
  type StubPayDto,
  type WorkspacePayrollItemDto,
  type WorkspacePayrollRunDto,
} from '@ad/types'
import { money, payPeriodWords, shortDate } from '@/lib/format'
import {
  SLOT_LABEL,
  slotWhy,
  sourceWords,
  type WhyBlock,
  type WhyRow,
} from '@/components/payroll-match/why'
import { autoPick, keyOf, lacksLine, slotKey, slotsOf, type Picks } from '@/pages/workspace-payroll'

/**
 * Step 2 of the workspace payroll page, in words (GitHub issue #22; owner's decisions, 2026-10-19): who was found, what
 * each item gets, and what Save will do, worked out from the run's plan and the owner's own choices on the table.
 */

type Run = Pick<WorkspacePayrollRunDto, 'items' | 'files' | 'plan' | 'pays' | 'slots'>
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

/** Under a payment's amount on the Participants grid: what Save does with it, in a few words. */
export function paymentNote(x: StubPayDto): string {
  if (x.action === 'create' && x.grossAmount !== null) return 'New payment'
  if (corrected(x)) return `Was ${money(x.previousAmount!)}`
  if (x.action === 'update' || x.action === 'same') return 'Already recorded'
  return 'No payment: look at the flag'
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

/** "Sep 11 Payroll Run": a payroll run by its pay date. */
export const runLabel = (payDate: string) =>
  `${new Date(`${payDate}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })} Payroll Run`

/** A staff member fully found: on an engagement, with their timesheet, register row and bank line (not a guess). */
export const staffMatched = (s: StaffFoundDto) =>
  s.engagements.length > 0 && s.timesheet.length > 0 && s.register.length > 0 && s.bank.length > 0

/** Staff: how many Auto-Match matched, how many are on no engagement (the people on no list too), the rest to review. */
export function staffTally(run: Run): { matched: number; off: number; toReview: number } {
  const rows = staffRows(run)
  const matched = rows.filter(staffMatched).length
  const off = rows.filter((s) => !s.engagements.length).length + run.plan.unlisted.length
  return { matched, off, toReview: rows.length + run.plan.unlisted.length - matched - off }
}

/** A pay stub whose payment Save makes or keeps with nothing to check. */
export const stubMatched = (run: Run, x: StubPayDto) =>
  !!x.participant &&
  x.action !== 'none' &&
  x.flags.length === 0 &&
  !run.plan.twoProofs.some((t) => t.target === 'wex' && t.id === x.wexPaymentId)

/** One person's pay stubs of the month, one per payroll run, in pay-date order: the participant, or the name printed. */
export interface ParticipantRow {
  key: string
  stubs: StubPayDto[]
}

/** The pay stubs by person, as the staff are: one row each, the stubs of every payroll run that paid them. */
export function participantRows(run: Run): ParticipantRow[] {
  const rows = new Map<string, StubPayDto[]>()
  for (const x of run.plan.stubs) {
    const key = x.participant
      ? `p-${x.participant.id}`
      : x.named
        ? `n-${x.named.toLowerCase()}`
        : `f-${x.fileId}`
    rows.set(key, [...(rows.get(key) ?? []), x])
  }
  return [...rows].map(([key, stubs]) => ({
    key,
    stubs: [...stubs].sort((a, b) => (a.payDate ?? '').localeCompare(b.payDate ?? '')),
  }))
}

/** Participants: how many people are matched (every stub of theirs), and how many the owner must look at. */
export function participantTally(run: Run): { matched: number; off: number; toReview: number } {
  const rows = participantRows(run)
  const matched = rows.filter((r) => r.stubs.every((x) => stubMatched(run, x))).length
  // A pay stub naming someone on no engagement's participant list.
  const off = rows.filter((r) => !r.stubs[0]!.participant).length
  return { matched, off, toReview: rows.length - matched - off }
}

/** "Auto-matched 3 staff found in the files: Morgan Lee, Priya Shah, Sam Ortiz". */
export function staffWords(run: Run): string {
  const found = staffRows(run).filter(foundInFiles)
  if (!found.length) return 'Nobody on your staff list was found in the files'
  return `Auto-matched ${count(found.length, 'staff', 'staff')} found in the files: ${found.map((s) => s.name).join(', ')}`
}

/**
 * The pays that land on no engagement: register and bank lines naming nobody on either list, and those of staff on no
 * engagement. A participant's bank line is left out: their pay stub is their proof of payment.
 */
export const paysNowhere = (run: Run) =>
  run.pays.filter(
    (p) =>
      p.state === 'unassigned' &&
      (p.flags.includes('not-on-a-list') || p.flags.includes('staff-untagged'))
  )

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

// ── "How Auto-Match decided" ────────────────────────────────────────────────
// The bookkeeper's panel (`WhyPanel`), with the owner's blocks: one per staff member, one per participant, one per
// payroll item still to match that neither covers, and the lines and files that land on no engagement. Each row uses
// Auto-Match's own words where it gave them (`match-proof.ts`).

const NO_FILE = 'No file of this kind in the zip.'
const nothingOf = (name: string) => `Nothing of ${name}.`
const flagWords = (flags: (keyof typeof PAY_LINE_FLAG_LABELS)[]) =>
  flags.map((f) => PAY_LINE_FLAG_LABELS[f]).join('. ')
const capital = (t: string) => t.charAt(0).toUpperCase() + t.slice(1)
/** A register that names no one: the run's company totals, the register proof of everyone the run paid. */
const registerTotalWords = (page?: number) =>
  `The payroll run's company totals${page ? ` on page ${page}` : ''}: the register names no one.`
/** A pay run's one debit, the bank line of everyone it paid. */
const runWords = (page?: number) =>
  `The payroll run's one debit${page ? ` on page ${page}` : ''}, which paid everyone on the register.`

/** One block per person on the staff list found in the files or tagged to an engagement. */
export function staffBlocks(run: Run): WhyBlock[] {
  const nameOf = (id: string) => run.files.find((f) => f.id === id)?.fileName ?? id
  const anyOf = (kind: string) => run.files.some((f) => f.kind === kind)
  return staffRows(run).map((s) => {
    const missing = (label: string, kind: string): WhyRow => ({
      label,
      tone: 'missing',
      text: anyOf(kind) ? nothingOf(s.name) : NO_FILE,
    })
    // One row per run that paid them, each proof in its run's words.
    const perRun = (
      slot: 'timesheet' | 'register' | 'bank',
      spots: ProofSpotDto[],
      text: (spot: ProofSpotDto) => string
    ): WhyRow[] =>
      spots.map((spot) => ({
        label: spot.payDate ? `${SLOT_LABEL[slot]}, ${runLabel(spot.payDate)}` : SLOT_LABEL[slot],
        tone: 'ok',
        file: nameOf(spot.fileId),
        text: text(spot) + sourceWords(spot.source),
      }))
    const payOn = (payDate?: string | null) =>
      s.payByRun.find((r) => r.payDate === (payDate ?? null))?.amount ??
      (s.payByRun.length === 1 ? s.payByRun[0]!.amount : null)
    const timesheet = perRun('timesheet', s.found.timesheet, (spot) =>
      spot.amount != null
        ? `${s.name} and ${money(spot.amount)}${spot.mark ? ` on page ${spot.mark.page}` : ''}.`
        : `${s.name} is on it.`
    )
    const register = perRun('register', s.found.register, (spot) => {
      if (spot.run) return registerTotalWords(spot.mark?.page)
      const pay = spot.amount ?? payOn(spot.payDate)
      // A spreadsheet (payroll details) is placed by its row, not a page.
      const sheet = run.files.find((f) => f.id === spot.fileId)?.kind === 'payroll-details'
      const page = spot.mark
        ? sheet
          ? ` on row ${spot.mark.y}`
          : ` on page ${spot.mark.page}`
        : ''
      return pay !== null
        ? `${s.name} and ${money(pay)}${page}.`
        : `${s.name}${page || ' is on it'}.`
    })
    const bank = perRun('bank', s.found.bank, (spot) =>
      spot.run
        ? runWords(spot.mark?.page)
        : `${s.name}${spot.mark ? ` on page ${spot.mark.page}` : ' is on it'}.`
    )
    const rows: WhyRow[] = [
      ...(timesheet.length ? timesheet : [missing(SLOT_LABEL.timesheet, 'timesheet')]),
      ...(register.length ? register : [missing(SLOT_LABEL.register, 'payroll-register')]),
      ...(bank.length
        ? bank
        : s.found.bankGuess.length
          ? s.found.bankGuess.map((g): WhyRow => ({
              label: SLOT_LABEL.bank,
              tone: 'guessed',
              file: nameOf(g.fileId),
              text: `${s.name}'s pay by its amount, not the name: confirm it in the reconciliation after Save.`,
            }))
          : [missing(SLOT_LABEL.bank, 'bank-statement')]),
    ]
    const on = s.engagements.length
      ? s.engagements.map((e) => e.name).join(', ')
      : PAY_LINE_FLAG_LABELS['staff-untagged']
    const pay =
      s.pay === null
        ? ''
        : s.payByRun.length > 1
          ? ` · ${s.payByRun.map((r) => `${r.payDate ? runLabel(r.payDate) : 'a run'} ${money(r.amount)}`).join(', ')}, ${money(s.pay)} in all`
          : ` · ${money(s.pay)}`
    return { key: `staff-${s.staffId}`, title: s.name, sub: `${on}${pay}`, rows }
  })
}

/** The owner's choice for an item's slot: a file chosen by hand, a guess confirmed, or nothing (Auto-Match's pick). */
export const ownChoice = (
  run: Run,
  picks: Picks,
  confirmed: Set<string>,
  i: WorkspacePayrollItemDto,
  slot: PayrollSlot
) =>
  picks[keyOf(i)]?.[slot] ??
  (confirmed.has(slotKey(i, slot)) ? (autoPick(run, i, slot).pick ?? undefined) : undefined)

/** One proof row of an engagement's payroll item: on file, attached by Save, or Auto-Match's pick and its reason. */
export function itemRow(
  run: Run,
  i: WorkspacePayrollItemDto,
  slot: PayrollSlot,
  planned: PlanProofDto[],
  chosen: string | undefined
): WhyRow {
  const label = SLOT_LABEL[slot]
  const match = run.slots.find((m) => m.target === i.target && m.id === i.id && m.slot === slot)
  const from = slotSource(i, slot, planned)
  if (from?.on === 'file') return { label, tone: 'ok', text: 'Already attached.' }
  if (from) {
    const f = planned
      .find((p) => p.target === i.target && p.id === i.id)
      ?.files.find((x) => x.slot === slot)
    const why = f && match?.candidates.find((c) => c.fileId === f.fileId)?.why
    const people = from.people.length
      ? `${from.people.join(', ')} ${from.people.length === 1 ? 'is' : 'are'} on it.`
      : undefined
    return { label, tone: 'ok', file: f?.fileName, text: why || people || 'Found.' }
  }
  // A staff line's proof comes from the staff tagged to its engagement, never a file chosen on the table.
  if (isStaffLine(i)) return { label, tone: 'missing', text: `${staffMissingWhy(run, i, slot)}.` }
  return {
    label,
    ...slotWhy({
      attached: null,
      chosen,
      match,
      fileName: (id) => run.files.find((f) => f.id === id)?.fileName,
      noLine: (id) => lacksLine(run, i, slot, id),
      noLineText: 'No line for this payment was found on it: link it from the reconciliation.',
    }),
  }
}

/** One block per participant a pay stub names: their timesheet, register and pay stub. */
export function participantBlocks(
  run: Run,
  planned: PlanProofDto[],
  choice: (i: WorkspacePayrollItemDto, slot: PayrollSlot) => string | undefined
): WhyBlock[] {
  return run.plan.stubs.flatMap((x) => {
    const who = x.participant
    if (!who) return []
    const item = x.wexPaymentId
      ? run.items.find((i) => i.target === 'wex' && i.id === x.wexPaymentId)
      : undefined
    const made = planned.find((p) => p.target === 'wex' && !p.id && p.stubFileId === x.fileId)
    const row = (slot: 'timesheet' | 'register'): WhyRow => {
      if (slot === 'register' && x.register?.run && !item)
        return {
          label: SLOT_LABEL.register,
          tone: 'ok',
          file: run.files.find((f) => f.id === x.register!.fileId)?.fileName,
          text: registerTotalWords(x.register.mark?.page),
        }
      if (item) return itemRow(run, item, slot, planned, choice(item, slot))
      const f = made?.files.find((y) => y.slot === slot)
      if (f)
        return {
          label: SLOT_LABEL[slot],
          tone: 'ok',
          file: f.fileName,
          text: `${who.name} is on it.`,
        }
      return {
        label: SLOT_LABEL[slot],
        tone: 'missing',
        text: run.files.some((y) => y.kind === PAYROLL_SLOT_KIND[slot])
          ? nothingOf(who.name)
          : NO_FILE,
      }
    }
    const period =
      x.payPeriodStart && x.payPeriodEnd
        ? `, for ${payPeriodWords(x.payPeriodStart, x.payPeriodEnd)}`
        : ''
    const stub: WhyRow = x.flags.length
      ? {
          label: SLOT_LABEL.stub,
          tone: 'guessed',
          file: x.fileName,
          text: `${flagWords(x.flags)}.`,
        }
      : {
          label: SLOT_LABEL.stub,
          tone: 'ok',
          file: x.fileName,
          text: `${capital(paymentWords(x))}${period}.${sourceWords(x.source)}`,
        }
    const bank: WhyRow[] = x.bank
      ? [
          {
            label: SLOT_LABEL.bank,
            tone: 'ok',
            file: run.files.find((f) => f.id === x.bank!.fileId)?.fileName,
            text: runWords(x.bank.mark?.page),
          },
        ]
      : []
    return [
      {
        key: `stub-${x.fileId}`,
        title: who.name,
        sub: `${who.participantId} · ${who.engagementName}`,
        rows: [row('timesheet'), row('register'), stub, ...bank],
      },
    ]
  })
}

/** The items still to match that no participant block covers: staff lines, and payments no pay stub names. */
export function itemBlocks(
  run: Run,
  open: WorkspacePayrollItemDto[],
  planned: PlanProofDto[],
  choice: (i: WorkspacePayrollItemDto, slot: PayrollSlot) => string | undefined
): WhyBlock[] {
  const stubbed = new Set(
    run.plan.stubs.filter((x) => x.participant && x.wexPaymentId).map((x) => x.wexPaymentId)
  )
  return open
    .filter((i) => !(i.target === 'wex' && stubbed.has(i.id)))
    .map((i) => ({
      key: keyOf(i),
      title: i.title,
      sub: `${i.engagementName} · ${paidWords(i)} · ${money(i.amount)}`,
      rows: slotsOf(i).map((slot) => itemRow(run, i, slot, planned, choice(i, slot))),
    }))
}

/** The last block: lines naming nobody (the payroll tax debit), pay stubs naming nobody, files matched to nothing. */
export function nobodyBlock(run: Run, chosen: Links): WhyBlock | null {
  // A register's summary lines (taxes, deductions, totals) name no one: the register shows once (owner's decision,
  // 2026-10-19).
  const nowhere = paysNowhere(run)
  const registers = [
    ...new Set(nowhere.filter((p) => p.kind === 'payroll-register').map((p) => p.fileId)),
  ]
  const rows: WhyRow[] = [
    ...registers.map((id): WhyRow => ({
      label: kindWord('payroll-register'),
      tone: 'missing',
      file: run.files.find((f) => f.id === id)?.fileName,
      text: 'Company totals only: the register names no one.',
    })),
    ...nowhere
      .filter((p) => p.kind !== 'payroll-register')
      .map((p): WhyRow => ({
        label: kindWord(p.kind),
        tone: 'missing',
        file: p.fileName,
        text: `${p.mark ? `“${p.mark.text}” on page ${p.mark.page}` : 'The whole file (scanned)'}: ${
          p.flags.length ? flagWords(p.flags) : 'On no engagement'
        }.`,
      })),
    ...run.plan.stubs
      .filter((x) => !x.participant)
      .map((x): WhyRow => ({
        label: SLOT_LABEL.stub,
        tone: 'missing',
        file: x.fileName,
        text: `${x.named ? `${x.named}: ` : ''}${x.flags.length ? flagWords(x.flags) : PAY_LINE_FLAG_LABELS['no-participant']}.`,
      })),
    ...nowhereFiles(run, chosen).map((f): WhyRow => ({
      label: kindWord(f.kind),
      tone: 'missing',
      file: f.fileName,
      text: 'A file matched to no engagement.',
    })),
  ]
  return rows.length
    ? {
        key: 'nobody',
        title: 'Not matched to anyone',
        sub: 'Lines and files that land on no engagement',
        rows,
      }
    : null
}
