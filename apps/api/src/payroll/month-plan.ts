import {
  namesOfEngagement,
  PAYROLL_SLOT_KIND,
  type HighlightField,
  type PayrollCandidate,
  type PayrollDocumentKind,
  type PayrollSlot,
  type PayrollSlotMatch,
  type StatementLine,
} from '@ad/types'
import type { Caller } from '../core/caller'
import type { PrismaService } from '../prisma/prisma.service'
import { matchSlot, slotsOf } from './match-proof'
import { programNamesIn } from './program-names'
import {
  isStaffLine,
  planMatch,
  printedName,
  type MatchFile,
  type ParticipantRow,
  type Plan,
  type StaffRow,
} from './staff-match'
import { lineOfKey, slotOfLink, workspaceItems, type WorkspaceItem } from './workspace-items'
import { twoDiffer } from './two-proofs'

/** The workspace's staff list (each person with their engagements), its participants and its program names. */
export async function payrollLists(prisma: PrismaService, workspaceId: string) {
  const [staff, participants, workspace] = await Promise.all([
    prisma.staffMember.findMany({
      where: { workspaceId },
      orderBy: { name: 'asc' },
      include: { assignments: { include: { engagement: { select: { id: true, name: true } } } } },
    }),
    prisma.participant.findMany({
      where: { workspaceId },
      select: { id: true, engagementId: true, displayName: true, participantId: true },
    }),
    prisma.workspace.findFirst({
      where: { id: workspaceId },
      select: { programNames: true },
    }),
  ])
  const rows: StaffRow[] = staff.map((s) => ({
    id: s.id,
    name: s.name,
    engagementIds: s.assignments.map((a) => a.engagementId),
  }))
  const engagementNames = new Map(
    staff.flatMap((s) => s.assignments.map((a) => [a.engagement.id, a.engagement.name] as const))
  )
  return {
    staff: rows,
    participants: participants as ParticipantRow[],
    engagementNames,
    programs: programNamesIn(workspace?.programNames),
  }
}

const SLOT_FILE: Record<PayrollSlot, string> = {
  timesheet: 'timesheet',
  register: 'payroll register',
  stub: 'pay stub',
  bank: 'bank statement',
}

/** A file of the bookkeeper's run, as the owner's match reads it, with its contents' fingerprint. */
export type MonthFile = MatchFile & { sha256: string }

/**
 * The bookkeeper's match worked out as the owner's workspace match works it out (owner's decision, 2026-11-14: the two
 * screens agree): one engagement's month matched by `planMatch`, so a staff line is proved only by its own person's
 * rows (the staff list's people tagged to the engagement, of the run that paid it), a participant's pay by their own,
 * and anything the lists leave open by Auto-Match's sure pick alone, as the owner's Save links it. A staff line is
 * offered nothing else: no guess, no free choice of file. Each slot also says when its pick is a second, different file
 * than the one already on the item (`twoProofs`, as the reconciliation flags it).
 */
export async function monthSlots(
  prisma: PrismaService,
  caller: Caller,
  input: {
    workspaceId: string
    reportId: string
    period: string
    files: MonthFile[]
    highlight: Record<PayrollDocumentKind, readonly HighlightField[]>
    /** Replacing the engagement's own payroll files: only the workspace's files (in `files`) stay on the items. */
    replace: boolean
  }
): Promise<PayrollSlotMatch[]> {
  const { files, highlight } = input
  const [{ items: all, months }, { staff, participants, programs }] = await Promise.all([
    workspaceItems(prisma, caller, input.workspaceId, input.period),
    payrollLists(prisma, input.workspaceId),
  ])
  const items = all.filter((i) => i.month.reportId === input.reportId)
  const month = months.find((m) => m.reportId === input.reportId)
  if (!month) return []
  const plan = planMatch({
    files,
    period: input.period,
    staff,
    participants,
    months: [
      {
        ...month,
        names: namesOfEngagement(programs, { id: month.engagementId, name: month.engagementName }),
        staffItems: items
          .filter((i) => i.target === 'expense' && isStaffLine(i.reportLine))
          .map((i) => ({ id: i.id, date: i.proof.start, ...lineOfKey(i.payrollKey) })),
      },
    ],
    wex: items
      .filter((i) => i.target === 'wex' && i.wex)
      .map((i) => ({
        id: i.id,
        reportId: i.month.reportId,
        participantRowId: i.wex!.participantRowId,
        start: i.proof.start,
        end: i.proof.end,
        amount: i.proof.amount,
        stubDocumentId: i.wex!.stubDocumentId,
      })),
    highlight,
    programs: programs.flatMap((g) => g.names),
  })
  const tagged = plan.staff.filter((s) => s.staff.engagementIds.includes(month.engagementId))
  const staffNames = staff.map((s) => printedName(s.name))
  const fileById = new Map(files.map((f) => [f.id, f]))
  const runDocs = new Set(files.map((f) => f.documentId).filter((d): d is string => !!d))
  return items.flatMap((i) =>
    slotsOf(i.proof).map((slot) => {
      const m = slotOf(i, slot, plan, tagged, files, highlight)
      const pick = m.pick ? fileById.get(m.pick) : undefined
      const chosen = m.candidates.find((c) => c.fileId === m.pick)
      if (!pick || !chosen) return m
      // What is already on the item as this proof (a person's link, or the owner's match's), that stays after Save.
      const theirs = i.links
        .filter(
          (l) =>
            slotOfLink(l) === slot &&
            l.documentId !== pick.documentId &&
            (!input.replace || runDocs.has(l.documentId))
        )
        .map((l) => ({ sha: l.sha256, marks: l.marks }))
      return twoDiffer(i, slot, theirs, [{ sha: pick.sha256, marks: chosen.marks }], staffNames)
        ? { ...m, twoProofs: true }
        : m
    })
  )
}

/** One slot of one item: the lists' proof when they found it, else Auto-Match's (for a staff line, its sure pick only). */
function slotOf(
  i: WorkspaceItem,
  slot: PayrollSlot,
  plan: Plan,
  tagged: Plan['staff'],
  files: MonthFile[],
  highlight: Record<PayrollDocumentKind, readonly HighlightField[]>
): PayrollSlotMatch {
  const base = { target: i.target, id: i.id, slot }
  const listed = plan.links.filter(
    (l) => l.target === i.target && l.itemId === i.id && l.slot === slot
  )
  if (listed.length) {
    const found = slot === 'stub' ? null : slot
    const candidates: PayrollCandidate[] = listed.map((l) => {
      const people =
        i.target === 'wex'
          ? [i.proof.name ?? 'the participant']
          : found
            ? tagged
                .filter((s) => s[found].some((x) => x.fileId === l.fileId))
                .map((s) => s.staff.name)
            : []
      return {
        fileId: l.fileId,
        // The planner's marks are the lines it found, as matchSlot's are.
        mark: l.mark as StatementLine | null,
        marks: l.marks as StatementLine[],
        sure: true,
        score: 100,
        ...(l.payRun ? { payRun: true } : {}),
        why: people.length
          ? `Found for ${people.join(', ')}, from the staff list and participants.`
          : 'Found from the staff list and participants.',
      }
    })
    return { ...base, candidates, pick: candidates[0]!.fileId, why: candidates[0]!.why }
  }
  const m = matchSlot(i.proof, slot, files, highlight[PAYROLL_SLOT_KIND[slot]], files)
  if (i.target === 'wex') return m
  // A staff line: Auto-Match's sure pick, as the owner's Save links it; otherwise nothing, and why.
  const sure = m.candidates.filter((c) => c.sure && (slot !== 'bank' || !!c.mark))
  if (sure.length && m.pick && sure.some((c) => c.fileId === m.pick))
    return { ...m, candidates: sure }
  return { ...base, candidates: [], pick: null, why: `${staffMissingWhy(tagged, files, slot)}.` }
}

/** Why a staff line's proof is missing, in the owner's screen's words (`staffMissingWhy` in the web app). */
function staffMissingWhy(tagged: Plan['staff'], files: MonthFile[], slot: PayrollSlot): string {
  if (!tagged.length) return 'Nobody is tagged to this engagement in Engagement staffing'
  if (!files.some((f) => f.kind === PAYROLL_SLOT_KIND[slot]))
    return `No ${SLOT_FILE[slot]} in the files`
  if (slot === 'bank') {
    const guessed = tagged.filter((s) => s.bankGuess.length && !s.bank.length)
    if (guessed.length)
      return `${guessed.map((s) => s.staff.name).join(', ')}: bank line guessed by amount; find it under Unmatched payments`
  }
  return `Nobody tagged to this engagement was found in the ${SLOT_FILE[slot]}`
}
