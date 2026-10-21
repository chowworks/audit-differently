import { createHash, randomUUID } from 'node:crypto'
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import {
  MAX_PAY_LINES,
  PAYROLL_BUDGET_KIND_LABELS,
  DOCUMENT_SENSITIVITY,
  MAX_WORKSPACE_PAYROLL_FILES,
  PAY_LINE_FLAGS,
  PAYROLL_DOCUMENT_KINDS,
  PAYROLL_SLOT_KIND,
  STAFF_REPORT_LINES,
  WEX_REPORT_LINES,
  type DroppedDecisionDto,
  type DroppedDecisionWhy,
  type EngagementPayrollCardDto,
  type PayLineDto,
  type PayLineFlag,
  type PayLineKind,
  type PayLineLinkInput,
  type PayLineState,
  type PayrollDocumentKind,
  type PayrollMatchFileDto,
  type PayrollMatchProgress,
  type PayrollReconciliationDto,
  type PayrollSlot,
  type PlanProofDto,
  type ReportStatus,
  type StaffSuggestionDto,
  type StatementLine,
  type StatementMark,
  type TwoProofsDto,
  type UnlistedPersonDto,
  type ProofSpotDto,
  type BooksRunDto,
  type PayrollBudgetKind,
  type WorkspacePayrollFilesDto,
  type WorkspacePayrollMode,
  type WorkspacePayrollMonthDto,
  type WorkspacePayrollOutputDto,
  type WorkspacePayrollPeriodDto,
  type WorkspacePayrollPlanDto,
  type WorkspacePayrollRunDto,
  type WorkspacePayrollSaveInput,
  type WorkspacePayrollStartInput,
} from '@ad/types'
import type { Document, Prisma } from '@prisma/client'
import { ChecksService } from '../checks/checks.service'
import { AccessLogService, type LogEntry } from '../core/access-log.service'
import { allow, staffName, tenantWhere, workspaceRole, type Caller } from '../core/caller'
import { changesOf, howMany, monthName, type Fields } from '../core/changes'
import { MatchStatsService } from '../core/match-stats.service'
import {
  DocumentsService,
  keyInWorkspace,
  storedFileName,
  type Uploaded,
} from '../documents/documents.service'
import { describe, type StagedFile } from '../documents/staged-file'
import { PrismaService } from '../prisma/prisma.service'
import { refuseLocked, ReportsService, WEX_FIELDS } from '../reports/reports.service'
import { DOCUMENT_STORAGE, type DocumentStorage } from '../storage/document-storage.interface'
import { highlightsFor } from './highlights'
import { HighlightSettingsService } from './highlight-settings.service'
import {
  computeBudgetLines,
  countedTwice,
  countsOnBudget,
  holdsPayroll,
  participantPaySpend,
  PAYROLL_KIND_OF_COVER,
  payrollCovers,
  payrollRowKind,
  type PayrollCover,
} from '../reports/report-lines'
import { PayrollAiService } from './payroll-ai.service'
import { PayrollReadingService } from './payroll-reading.service'
import { COPIED_TYPES, itemCopy } from './mark-pdf'
import { candidateFor, matchSlot, personIn, slotsOf } from './match-proof'
import { isPayKind, linkCovers, overPayLineCap, PAY_SLOT, payLinesOf, sameLine } from './pay-lines'
import {
  isKind,
  PayrollMatchService,
  proofFile,
  PURPOSE,
  RUN_HOURS,
  SLOT_WORDS,
  type RunRow,
} from './payroll-match.service'
import { PayrollMatchWorker, storageName } from './payroll-match.worker'
import { cleanMark, MAX_PAYROLL_FILES } from './payroll.service'
import {
  isStaffLine,
  payUnclearLines,
  planMatch,
  printedName,
  registerPerson,
  severalPeopleLines,
  stubName,
  type MatchFile,
  type MatchMonth,
  type MatchWex,
  type ParticipantRow,
  type PersonLine,
  type Plan,
  type PlannedLink,
  type StaffFound,
  type StaffRow,
} from './staff-match'
import { amountsOn, payDateOn, payMonthOf, payRunsOf, runOfLine, suggestedRuns } from './pay-runs'
import { chargesOf } from './payroll-details'
import {
  payrollItemNumber,
  payrollLinesOf,
  type LineMonth,
  type PayrollLineWrite,
} from './payroll-lines'
import { readStatement, type PageItem } from './statement-lines'
import { proved, slotOfLink, workspaceItems, type WorkspaceItem } from './workspace-items'

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/
/** A file's sha256, as staging records it: how a file sent again is known. */
const sha256Of = (f: Uploaded) =>
  Buffer.isBuffer(f?.buffer) ? createHash('sha256').update(f.buffer).digest('hex') : ''
/** Said when a file of an upload was removed, or the upload itself went, before Save. */
export const UPLOAD_CHANGED = 'A file in this upload was removed; start the upload again'
/** Said when the month's set changed (another owner saved a change) after this change was started. */
export const SET_CHANGED =
  "The month's payroll files changed since this was started: discard it and start again"
const RUN_MS = RUN_HOURS * 3_600_000
const MAX = MAX_WORKSPACE_PAYROLL_FILES
const TOO_MANY = (n: number) =>
  `A month's payroll files are at most ${MAX.toLocaleString('en-US')}; this would make ${n.toLocaleString('en-US')}. Nothing was changed: remove files first, or replace them all.`

/** The owners' setting in the access log, by value: on or off. */
const SEE_PAYROLL_FIELDS: Fields = {
  bookkeepersSeeStaffPayroll: {
    label: 'Bookkeepers see staff payroll',
    show: 'text',
    labels: { true: 'on', false: 'off' },
  },
}

/** What each kind of change is called in the access log. */
const MODE_WORDS: Record<WorkspacePayrollMode, { start: string; save: string }> = {
  replace: { start: 'replacing all the payroll files', save: 'replaced all the payroll files' },
  add: { start: 'adding payroll files', save: 'added payroll files' },
  remove: { start: 'removing a payroll file', save: 'removed a payroll file' },
  match: { start: 'matching the payroll files again', save: 'matched the payroll files again' },
}

/** A month's names in a sentence: "March 2027 of Riverbend Youth Works and March 2027 of Harbor Tech". */
const monthsWords = (ms: { engagementName: string; period: string }[]) => {
  const names = ms.map((m) => `${monthName(m.period)} of ${m.engagementName}`)
  return names.length < 2
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

type RunFile = RunRow['files'][number]
type WorkspaceRun = RunRow & { workspaceId: string; period: string }
const modeOf = (run: { mode: string | null }): WorkspacePayrollMode =>
  (run.mode as WorkspacePayrollMode | null) ?? 'add'
const linkKey = (target: string, itemId: string, documentId: string) =>
  `${target}:${itemId}:${documentId}`

/** One proof link Save writes to an item that is already there: what it is, and its highlights. */
interface LinkWrite {
  target: 'expense' | 'wex'
  itemId: string
  documentId: string
  purpose: string
  slot: PayrollSlot
  mark: StatementMark | null
  marks: StatementMark[]
  reportId: string
  fileId: string
  /** Auto-Match's sure pick for an item's open proof, rather than the lists' (a choice by hand for the slot wins). */
  pick?: boolean
  /** The bank line is the debit of the pay run that paid the item (`ExpenseDocument.payRun`). */
  payRun?: boolean
}

/**
 * "Match payroll & timecards" for the whole workspace (GitHub issue #22; owner's decisions, 2026-10-17 and 2026-10-18).
 *
 * Each workspace month has one set of payroll files: its workspace payroll documents (`<workspaceId>/workspace/<period>/`,
 * filed to no engagement), and matching always comes from that set. An owner changes the set by a run of one kind
 * (`WORKSPACE_PAYROLL_MODES`): Replace all (the uploaded zip becomes the set), Add files, Remove a file, or Match again
 * (the set as it is, after a participant was added or staff were tagged). A file is known by its contents (sha256): the
 * same file uploaded again is the same file, never a second copy. The background job reads every file of the run
 * (`payroll-match.worker.ts`); the plan works out, from the whole set as it will be, what Save will write; and Save writes
 * only the difference, in one transaction:
 * - files that leave the set go (their links, pays and staff proofs with them); new ones are filed once each;
 * - the work-experience payments made from pay stubs are made, changed or removed (a payment made from a stub that left
 *   goes; one typed by hand is never removed);
 * - the match's own proof links are added, changed or removed, on each engagement month where they change;
 * - what was found of each person on the staff list is rewritten (StaffPayProof).
 * Only engagement months whose links or payments change are touched; one that is closed or submitted is listed in the
 * plan and reopened inside the save with the owner's one reason, exactly as its own page does it.
 *
 * An owner's decisions (a proof linked by hand or a guess confirmed, a pay marked not grant-funded) are never changed by
 * matching again: they are kept while the file they were made on stays the same file (its name and contents). When that
 * file changes or leaves, they go, and the reconciliation says so (`PayrollDroppedDecision`).
 *
 * Owners change it; owners and auditors read the reconciliation; nothing here is a bookkeeper's.
 */
/**
 * A payroll line in the access log: its number, date, amounts and account by value; whose pay (a name) and the
 * description by name alone, as the log keeps personal and free-text fields.
 */
const PAYROLL_LINE_FIELDS: Fields = {
  itemNumber: { label: 'Item number', show: 'text' },
  date: { label: 'Date', show: 'date' },
  vendor: { label: 'Paid' },
  memo: { label: 'Description' },
  account: { label: 'Account (general ledger)', show: 'text' },
  allocatedAmount: { label: 'Amount', show: 'money' },
}

/** What a payroll line is, in the log's words: never whose. */
const whoseWords = (w: PayrollLineWrite) =>
  w.staffId
    ? w.kind.endsWith('taxes')
      ? "a staff member's payroll taxes"
      : "a staff member's pay"
    : "the participants' payroll taxes"

/** A participant's pay is of the first books' run dated this many days after its pay period ends. */
const WEX_RUN_DAYS = 14
const addDays = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

@Injectable()
export class WorkspacePayrollService {
  private readonly logger = new Logger(WorkspacePayrollService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly log: AccessLogService,
    private readonly checks: ChecksService,
    private readonly reports: ReportsService,
    private readonly documents: DocumentsService,
    private readonly worker: PayrollMatchWorker,
    private readonly highlights: HighlightSettingsService,
    @Inject(DOCUMENT_STORAGE) private readonly storage: DocumentStorage,
    private readonly stats: MatchStatsService,
    private readonly match: PayrollMatchService,
    private readonly reading: PayrollReadingService,
    private readonly ai: PayrollAiService
  ) {}

  // ── Who ──────────────────────────────────────────────────────────────────

  private owner(caller: Caller, workspaceId: string) {
    if (!caller.workspaceIds.includes(workspaceId)) throw new NotFoundException()
    allow(
      workspaceRole(caller, workspaceId, ['owner']),
      'Only an owner matches payroll for the whole workspace'
    )
  }

  /**
   * Owners and auditors read the page; anyone else, a bookkeeper included, finds nothing here (404, so the screen shows
   * the app's own not-found page rather than a refusal).
   */
  private reader(caller: Caller, workspaceId: string) {
    if (!workspaceRole(caller, workspaceId, ['owner', 'auditor'])) throw new NotFoundException()
  }

  private period(given: unknown): string {
    if (typeof given !== 'string' || !PERIOD.test(given))
      throw new BadRequestException('The month must be YYYY-MM')
    return given
  }

  // ── The set ──────────────────────────────────────────────────────────────

  /** The month's set: its workspace payroll documents, each under its workspace's own folder. */
  private async setOf(workspaceId: string, period: string): Promise<Document[]> {
    const docs = await this.prisma.document.findMany({
      where: {
        workspaceId,
        engagementId: null,
        period,
        kind: { in: [...PAYROLL_DOCUMENT_KINDS] },
      },
      orderBy: [{ kind: 'asc' }, { fileName: 'asc' }],
    })
    return docs.filter((d) => keyInWorkspace(d))
  }

  /** The month's set as the page lists it, for Remove a file. Owners and auditors; one list line. */
  async files(
    caller: Caller,
    workspaceId: string,
    period: unknown
  ): Promise<WorkspacePayrollFilesDto> {
    this.reader(caller, workspaceId)
    const p = this.period(period)
    const docs = await this.setOf(workspaceId, p)
    await this.log.log(caller, {
      workspaceId,
      resource: 'document',
      action: 'list',
      description: `Listed the workspace's payroll files for ${monthName(p)} (${howMany(docs.length, 'file')})`,
    })
    return {
      workspaceId,
      period: p,
      files: docs.map((d) => ({
        id: d.id,
        kind: d.kind as PayrollDocumentKind,
        fileName: d.fileName,
        size: d.size,
        sha256: d.sha256,
        uploadedAt: d.uploadedAt.toISOString(),
        personal: d.sensitivity === 'personal',
      })),
      can: { change: workspaceRole(caller, workspaceId, ['owner']) },
    }
  }

  /**
   * The set after this run's change: the run's files that stay or join (`matching`), the set's files that leave and why
   * (one a staged file takes the place of, by the same contents or the same name and kind, has `changed`; one simply no
   * longer there has `left`), and the files that join. `stale` when the set is not what it was when the run started.
   */
  private setChange(run: WorkspaceRun, set: Document[]) {
    const staged = run.files.filter((f) => !f.documentId)
    const held = new Set(run.files.map((f) => f.documentId).filter((d): d is string => !!d))
    const supersededBy = (d: Document) =>
      staged.find((f) => f.sha256 === d.sha256 && f.kind === d.kind) ??
      staged.find((f) => f.fileName === d.fileName && f.kind === d.kind) ??
      staged.find((f) => f.sha256 === d.sha256)
    const leaving = set
      .map((doc) => ({ doc, by: supersededBy(doc) }))
      .filter((x) => !held.has(x.doc.id) || x.by)
      .map((x) => ({
        doc: x.doc,
        why: (x.by ? 'changed' : 'left') as DroppedDecisionWhy,
        by: x.by,
      }))
    const leavingIds = new Set(leaving.map((l) => l.doc.id))
    const inSet = new Set(set.map((d) => d.id))
    const matching = run.files.filter(
      (f) => !f.documentId || (inSet.has(f.documentId) && !leavingIds.has(f.documentId))
    )
    const previousOf = new Map<string, string>()
    for (const l of leaving) if (l.by && !previousOf.has(l.by.id)) previousOf.set(l.by.id, l.doc.id)
    const was = [...run.setDocumentIds].sort().join(',')
    const now = set
      .map((d) => d.id)
      .sort()
      .join(',')
    const distinct = new Set(run.files.map((f) => f.sha256)).size
    return {
      leaving,
      leavingIds,
      joining: staged,
      matching,
      previousOf,
      unchanged: matching.length - staged.length,
      total: matching.length,
      stale: was !== now,
      complete: modeOf(run) !== 'replace' || distinct === (run.expectedFiles ?? 0),
    }
  }

  // ── The lists ────────────────────────────────────────────────────────────

  /**
   * The staff list with each person's engagements, and every engagement's participant list, as the match reads them.
   * Read as the caller: an owner reads both (an auditor never runs a match).
   */
  private async lists(workspaceId: string) {
    const [staff, participants] = await Promise.all([
      this.prisma.staffMember.findMany({
        where: { workspaceId },
        orderBy: { name: 'asc' },
        include: { assignments: { include: { engagement: { select: { id: true, name: true } } } } },
      }),
      this.prisma.participant.findMany({
        where: { workspaceId },
        select: { id: true, engagementId: true, displayName: true, participantId: true },
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
    return { staff: rows, participants: participants as ParticipantRow[], engagementNames }
  }

  /**
   * The whole month matched again from the set as this run leaves it (`staff-match.ts`), and the difference Save writes:
   * the match's own links to add, change and remove (a person's link is never touched), the payments from stubs to make,
   * change and remove, the decisions that go with a leaving file, and the months all of that touches.
   */
  private async planOf(
    run: WorkspaceRun,
    items: WorkspaceItem[],
    months: WorkspacePayrollMonthDto[]
  ) {
    // A books' payroll row this Save covers is no item to prove (owner's decision, 2026-10-20): planned again without
    // it, once, since the second plan covers the same from the same files and payments.
    const first = await this.planFor(run, items, months)
    const covered = new Set(first.payrollLines.books.map((b) => b.id))
    return items.some((i) => i.target === 'expense' && covered.has(i.id))
      ? this.planFor(
          run,
          items.filter((i) => !(i.target === 'expense' && covered.has(i.id))),
          months
        )
      : first
  }

  private async planFor(
    run: WorkspaceRun,
    items: WorkspaceItem[],
    months: WorkspacePayrollMonthDto[]
  ) {
    const [{ staff, participants, engagementNames }, highlight, set] = await Promise.all([
      this.lists(run.workspaceId),
      this.highlights.current(),
      this.setOf(run.workspaceId, run.period),
    ])
    const change = this.setChange(run, set)
    const files: MatchFile[] = change.matching.map((f) => ({
      ...proofFile(f),
      documentId: f.documentId,
      previousDocumentId: change.previousOf.get(f.id) ?? null,
    }))
    const matchMonths: MatchMonth[] = months.map((m) => ({
      ...m,
      staffItems: items
        .filter(
          (i) =>
            i.target === 'expense' && i.month.reportId === m.reportId && isStaffLine(i.reportLine)
        )
        .map((i) => ({ id: i.id, date: i.proof.start })),
    }))
    const wexItems = items.filter((i) => i.target === 'wex' && i.wex)
    const wex: MatchWex[] = wexItems.map((i) => ({
      id: i.id,
      reportId: i.month.reportId,
      participantRowId: i.wex!.participantRowId,
      start: i.proof.start,
      end: i.proof.end,
      amount: i.proof.amount,
      stubDocumentId: i.wex!.stubDocumentId,
      stubLeaving: !!i.wex!.stubDocumentId && change.leavingIds.has(i.wex!.stubDocumentId),
    }))
    const plan = planMatch({
      files,
      period: run.period,
      staff,
      participants,
      months: matchMonths,
      wex,
      highlight,
    })
    const docOf = new Map(change.matching.map((f) => [f.id, f.documentId]))
    const byKey = new Map(items.map((i) => [`${i.target}-${i.id}`, i]))

    // The same file already on file (owner's decision, 2026-10-19): a file of the set whose contents are already on an
    // item (the bookkeeper's copy), or filed on the item's engagement month, is linked as that document, never as a copy.
    const runFile = new Map(change.matching.map((f) => [f.id, f]))
    const setIds = new Set(set.map((d) => d.id))
    const shas = [...new Set(change.matching.map((f) => f.sha256))]
    const twins = shas.length
      ? (
          await this.prisma.document.findMany({
            where: {
              workspaceId: run.workspaceId,
              engagementId: { not: null },
              period: run.period,
              sha256: { in: shas },
              kind: { in: [...PAYROLL_DOCUMENT_KINDS] },
            },
            select: {
              id: true,
              workspaceId: true,
              engagementId: true,
              kind: true,
              sha256: true,
              storageKey: true,
            },
          })
        ).filter((d) => keyInWorkspace(d))
      : []
    /** The proofs Save attaches that are already on file (`target:itemId:fileId`). */
    const onFile = new Set<string>()
    const docFor = (item: WorkspaceItem | undefined, fileId: string): string | null => {
      const own = docOf.get(fileId) ?? null
      const f = runFile.get(fileId)
      if (!item || !f) return own
      const same = item.links.find(
        (l) =>
          l.sha256 === f.sha256 &&
          l.kind === f.kind &&
          l.documentId !== own &&
          !change.leavingIds.has(l.documentId)
      )
      const twin = same
        ? undefined
        : twins.find(
            (d) =>
              d.sha256 === f.sha256 &&
              d.kind === f.kind &&
              d.engagementId === item.month.engagementId
          )
      const found = same?.documentId ?? twin?.id
      if (!found) return own
      onFile.add(`${item.target}:${item.id}:${fileId}`)
      return found
    }

    // Payments: made or changed from a stub; one whose stub leaves (and no stub of the set takes it over) goes, or, typed
    // by hand first, stays and is no longer tied to it.
    const stubWrites = plan.stubs.filter((x) => x.action === 'create' || x.action === 'update')
    const taken = new Set(stubWrites.map((x) => x.wexId).filter((id): id is string => !!id))
    const paymentsGone = wexItems
      .filter(
        (i) =>
          !!i.wex!.stubDocumentId &&
          change.leavingIds.has(i.wex!.stubDocumentId) &&
          !taken.has(i.id)
      )
      .map((i) => ({ item: i, detach: i.wex!.stubTookOver }))
    const goneIds = new Set(paymentsGone.filter((g) => !g.detach).map((g) => g.item.id))

    // Links: the match's links to items already there and files already on file, against what is there.
    const clean = (l: PlannedLink): PlannedLink => ({
      ...l,
      mark: l.mark ? cleanMark(l.mark) : null,
      marks: l.marks.map(cleanMark),
    })
    const desired = new Map<string, LinkWrite>()
    const fresh: (PlannedLink & { pick?: boolean })[] = []
    for (const raw of plan.links) {
      const l = clean(raw)
      const documentId = l.itemId
        ? docFor(byKey.get(`${l.target}-${l.itemId}`), l.fileId)
        : docOf.get(l.fileId)
      if (!documentId || !l.itemId) {
        fresh.push(l)
        continue
      }
      desired.set(linkKey(l.target, l.itemId, documentId), {
        target: l.target,
        itemId: l.itemId,
        documentId,
        purpose: l.purpose,
        slot: l.slot,
        mark: l.mark,
        marks: l.marks,
        reportId: l.reportId,
        fileId: l.fileId,
        payRun: l.payRun === true,
      })
    }
    const staying = new Set(
      change.matching.map((f) => f.documentId).filter((d): d is string => !!d)
    )
    // Auto-Match's sure pick for each proof an item still needs, beside the lists': the match's own link too. An item's
    // proof counts as there when a person linked it, or it is on a file outside the set; the match's own earlier links
    // are what this works out again.
    const byLists = new Set(
      plan.links.filter((l) => l.itemId).map((l) => `${l.target}:${l.itemId}:${l.slot}`)
    )
    for (const i of items) {
      if (i.target === 'wex' && goneIds.has(i.id)) continue
      const kept = i.links.filter(
        (l) => !change.leavingIds.has(l.documentId) && (!l.byMatch || !staying.has(l.documentId))
      )
      for (const slot of slotsOf(i.proof)) {
        if (proved(kept, slot) || byLists.has(`${i.target}:${i.id}:${slot}`)) continue
        const m = matchSlot(i.proof, slot, files, highlight[PAYROLL_SLOT_KIND[slot]])
        const c = m.pick ? m.candidates.find((x) => x.fileId === m.pick) : undefined
        if (!m.pick || !c?.sure || (slot === 'bank' && !c.mark)) continue
        const link = {
          target: i.target,
          itemId: i.id,
          fileId: m.pick,
          purpose: PURPOSE[slot] as PlannedLink['purpose'],
          slot,
          mark: c.mark ? cleanMark(c.mark) : null,
          marks: c.marks.slice(0, 20).map(cleanMark),
          reportId: i.month.reportId,
          payRun: c.payRun === true,
        }
        const documentId = docFor(i, m.pick)
        if (documentId)
          desired.set(linkKey(i.target, i.id, documentId), { ...link, documentId, pick: true })
        else fresh.push({ ...link, stubFileId: null, pick: true })
      }
    }
    // Every link of the set as Save leaves it, by file: the match's (kept, changed or new) and a person's on a file that
    // stays. A file in none of them reaches no engagement's records.
    const fileOfDoc = new Map(
      change.matching.filter((f) => f.documentId).map((f) => [f.documentId!, f.id] as const)
    )
    const reached = [
      ...[...desired.values()].map((l) => ({ fileId: l.fileId, reportId: l.reportId })),
      ...fresh.map((l) => ({ fileId: l.fileId, reportId: l.reportId })),
      ...items
        .filter((i) => !(i.target === 'wex' && goneIds.has(i.id)))
        .flatMap((i) =>
          i.links
            .filter((l) => !l.byMatch && fileOfDoc.has(l.documentId))
            .map((l) => ({ fileId: fileOfDoc.get(l.documentId)!, reportId: i.month.reportId }))
        ),
    ]
    const creates: LinkWrite[] = []
    const updates: LinkWrite[] = []
    const deletes: (Omit<LinkWrite, 'mark' | 'marks' | 'slot' | 'fileId'> & { kind: string })[] = []
    for (const i of items) {
      if (goneIds.has(i.id) && i.target === 'wex') continue
      for (const link of i.links) {
        const key = linkKey(i.target, i.id, link.documentId)
        const want = desired.get(key)
        if (!link.byMatch) {
          // A person's link: kept as it is, whatever the match finds (the same file already on the item included).
          desired.delete(key)
          continue
        }
        // The match's link to a file leaving the set goes with it; one to a document already on file is the match's too.
        if (!staying.has(link.documentId) && setIds.has(link.documentId)) continue
        if (!want) {
          deletes.push({
            target: i.target,
            itemId: i.id,
            documentId: link.documentId,
            purpose: link.purpose,
            reportId: i.month.reportId,
            kind: link.kind,
          })
          continue
        }
        desired.delete(key)
        if (
          link.purpose !== want.purpose ||
          boxKey(link.mark) !== boxKey(want.mark) ||
          boxesKey(link.marks) !== boxesKey(want.marks) ||
          link.payRun !== (want.payRun === true)
        )
          updates.push(want)
      }
    }
    for (const want of desired.values()) creates.push(want)

    // What goes with the leaving files: every link to them, the decisions among them, and the pays marked by hand.
    const leavingLinks = items.flatMap((i) =>
      i.links.filter((l) => change.leavingIds.has(l.documentId)).map((l) => ({ item: i, link: l }))
    )
    const notFunded = change.leavingIds.size
      ? await this.prisma.payrollPayLine.findMany({
          where: {
            documentId: { in: [...change.leavingIds] },
            notFundedReason: { not: null },
          },
          select: { documentId: true },
        })
      : []
    const leavingDoc = new Map(change.leaving.map((l) => [l.doc.id, l]))
    const dropped: Omit<DroppedDecisionDto, 'id' | 'by' | 'at'>[] = [
      ...leavingLinks
        .filter((x) => !x.link.byMatch)
        .map((x) => {
          const l = leavingDoc.get(x.link.documentId)!
          return {
            fileName: l.doc.fileName,
            kind: l.doc.kind as PayrollDocumentKind,
            decision: 'linked' as const,
            why: l.why,
            itemTitle: x.item.dto.title,
            engagementName: x.item.month.engagementName,
          }
        }),
      ...notFunded.map((n) => {
        const l = leavingDoc.get(n.documentId)!
        return {
          fileName: l.doc.fileName,
          kind: l.doc.kind as PayrollDocumentKind,
          decision: 'not-funded' as const,
          why: l.why,
          itemTitle: null,
          engagementName: null,
        }
      }),
    ]

    // The month's payroll on each engagement's budget (owner's decision, 2026-10-20): from payroll details, the lines
    // Save writes, changes or removes, and why a charge reached none.
    const paidMonths = new Set([
      ...wexItems.filter((i) => !goneIds.has(i.id)).map((i) => i.month.reportId),
      ...stubWrites.map((x) => x.month!.reportId),
    ])
    const payrollLines = await this.payrollLinesPlan(
      files,
      plan,
      staff,
      participants,
      months,
      paidMonths
    )
    // The files proving the payroll lines reach those lines' months, as a link to any other item does.
    const asFile = new Map(files.map((f) => [f.id, f.id] as const))
    for (const w of payrollLines.writes)
      for (const l of this.payrollLineProofs(w, plan, files, asFile))
        reached.push({ fileId: l.documentId, reportId: w.reportId })

    const touched = new Set([
      ...payrollLines.touched,
      ...creates.map((l) => l.reportId),
      ...updates.map((l) => l.reportId),
      ...deletes.map((l) => l.reportId),
      ...fresh.map((l) => l.reportId),
      ...stubWrites.map((x) => x.month!.reportId),
      ...paymentsGone.map((g) => g.item.month.reportId),
      ...leavingLinks.map((x) => x.item.month.reportId),
    ])
    const fileNames = new Map(run.files.map((f) => [f.id, f.fileName]))
    // Items Save leaves with two different files as one proof: a person's (the bookkeeper's) and the match's.
    const twoProofs: TwoProofsDto[] = []
    const staffNames = staff.map((x) => printedName(x.name))
    const gone = new Set(deletes.map((d) => linkKey(d.target, d.itemId, d.documentId)))
    for (const i of items) {
      if (i.target === 'wex' && goneIds.has(i.id)) continue
      const added = [...creates, ...fresh].filter((l) => l.target === i.target && l.itemId === i.id)
      for (const slot of slotsOf(i.proof)) {
        const live = i.links.filter(
          (l) => slotOfLink(l) === slot && !change.leavingIds.has(l.documentId)
        )
        const theirs = live
          .filter((l) => !l.byMatch)
          .map((l) => ({ sha: l.sha256, marks: l.marks }))
        const ours = [
          ...live
            .filter((l) => l.byMatch && !gone.has(linkKey(i.target, i.id, l.documentId)))
            .map((l) => ({ sha: l.sha256, marks: l.marks })),
          ...added
            .filter((l) => l.slot === slot)
            .map((l) => ({ sha: runFile.get(l.fileId)?.sha256 ?? '', marks: l.marks as unknown })),
        ]
        if (twoDiffer(i, slot, theirs, ours, staffNames)) twoProofs.push(twoProofsOf(i, slot))
      }
    }
    return {
      // The items it planned with: a books' payroll row this Save covers is not among them.
      items,
      plan,
      onFile,
      twoProofs,
      change,
      set,
      creates,
      updates,
      deletes,
      fresh,
      stubWrites,
      payrollLines,
      paymentsGone,
      leavingLinks,
      dropped,
      touched,
      staff,
      participants,
      engagementNames,
      highlight,
      fileNames,
      byKey,
      files,
      reached,
    }
  }

  /** The plan as the page shows it before Save. */
  private planDto(
    p: Awaited<ReturnType<WorkspacePayrollService['planOf']>>,
    months: WorkspacePayrollMonthDto[]
  ): WorkspacePayrollPlanDto {
    const names = new Map([
      ...p.engagementNames,
      ...months.map((m) => [m.engagementId, m.engagementName] as const),
    ])
    const uniq = (xs: string[]) => [...new Set(xs)]
    // Each proof of a run says which run: its pay date (the period's end when none is printed).
    const runs = payRunsOf(p.files)
    const payDateOf = (runId?: string) => {
      const r = runs.find((x) => x.fileId === runId)
      return r ? (r.payDate ?? r.end) : null
    }
    const runSpot = (x: PersonLine): ProofSpotDto => ({
      ...spot(x),
      ...(x.runId ? { payDate: payDateOf(x.runId) } : {}),
    })
    // One entry per file and run (owner's decision, 2026-10-19): a person has a row per job on a time report, and the
    // rules and AI each mark one. Shown once, ✨ when AI found them there too, with the pay of all AI's (or the pay list's) rows in that file;
    // every row is still highlighted on the saved copy.
    const runSpots = (xs: PersonLine[]) => {
      const out = new Map<string, ProofSpotDto>()
      for (const x of xs) {
        const s = runSpot(x)
        const key = `${s.fileId}|${s.payDate ?? ''}`
        const had = out.get(key)
        if (!had) out.set(key, s)
        else if (s.source && s.source === had.source)
          had.amount = Math.round(((had.amount ?? 0) + (s.amount ?? 0)) * 100) / 100
        else if (s.source && !had.source) out.set(key, s)
      }
      return [...out.values()]
    }
    const payByRun = (rows: PersonLine[]) => {
      const out = new Map<string | null, number>()
      for (const r of rows)
        if (r.amount !== null) {
          const d = payDateOf(r.runId)
          out.set(d, Math.round(((out.get(d) ?? 0) + r.amount) * 100) / 100)
        }
      return [...out.entries()]
        .map(([payDate, amount]) => ({ payDate, amount }))
        .sort((a, b) => (a.payDate ?? '').localeCompare(b.payDate ?? ''))
    }
    const sheetIds = new Set(p.files.filter((f) => f.kind === 'payroll-details').map((f) => f.id))
    const touched = months.filter((m) => p.touched.has(m.reportId))
    const monthOf = new Map(months.map((m) => [m.reportId, m]))
    const fileOf = new Map(p.change.matching.map((f) => [f.id, f]))
    const engagementsOf = (reportIds: string[]) =>
      uniq(reportIds)
        .map((r) => monthOf.get(r))
        .filter((m): m is WorkspacePayrollMonthDto => !!m)
        .map((m) => ({ id: m.engagementId, name: m.engagementName }))
        .filter((e, n, all) => all.findIndex((x) => x.id === e.id) === n)
    // The links Save adds or changes, by item; whose line each is, from what the match found of each person.
    const FOUND: Record<PayrollSlot, 'timesheet' | 'register' | 'bank' | null> = {
      timesheet: 'timesheet',
      register: 'register',
      bank: 'bank',
      stub: null,
    }
    const proof = new Map<string, PlanProofDto>()
    for (const l of [
      ...p.creates.map((x) => ({ ...x, stubFileId: null as string | null })),
      ...p.updates.map((x) => ({ ...x, stubFileId: null as string | null })),
      ...p.fresh,
    ]) {
      const month = monthOf.get(l.reportId)
      const file = fileOf.get(l.fileId)
      if (!month || !file) continue
      const key = `${l.target}:${l.itemId ?? `stub-${l.stubFileId}`}`
      const item = l.itemId ? p.byKey.get(`${l.target}-${l.itemId}`) : undefined
      const stub = p.plan.stubs.find(
        (x) => (l.itemId ? x.wexId === l.itemId : x.fileId === l.stubFileId) && x.participant
      )
      const participant = l.target === 'wex' ? (stub?.participant?.displayName ?? null) : null
      let entry = proof.get(key)
      if (!entry) {
        entry = {
          target: l.target,
          id: l.itemId,
          stubFileId: l.itemId ? null : l.stubFileId,
          title: item?.dto.title ?? `${participant ?? 'A participant'}'s work-experience pay`,
          engagementId: month.engagementId,
          engagementName: month.engagementName,
          reportId: month.reportId,
          files: [],
        }
        proof.set(key, entry)
      }
      const found = FOUND[l.slot]
      const people =
        l.target === 'wex'
          ? participant
            ? [participant]
            : []
          : found
            ? p.plan.staff
                .filter(
                  (f) =>
                    f.staff.engagementIds.includes(month.engagementId) &&
                    f[found].some((x) => x.fileId === l.fileId)
                )
                .map((f) => f.staff.name)
            : []
      entry.files.push({
        fileId: l.fileId,
        fileName: file.fileName,
        kind: file.kind as PayrollDocumentKind,
        slot: l.slot,
        people,
      })
    }
    return {
      staff: p.plan.staff.map((f) => ({
        staffId: f.staff.id,
        name: f.staff.name,
        engagements: f.staff.engagementIds.map((id) => ({ id, name: names.get(id) ?? '' })),
        pay: f.pay,
        timesheet: uniq(f.timesheet.map((x) => x.fileId)),
        register: uniq(f.register.map((x) => x.fileId)),
        bank: uniq(f.bank.map((x) => x.fileId)),
        bankGuess: uniq(f.bankGuess.map((x) => x.fileId)),
        // Their own register rows' pay when the registers name them; else what payroll details charge, never both.
        payByRun: payByRun(
          f.register.some((x) => !sheetIds.has(x.fileId) && x.amount !== null)
            ? f.register.filter((x) => !sheetIds.has(x.fileId))
            : f.register
        ),
        charged: f.charged ?? [],
        found: {
          timesheet: runSpots(f.timesheet),
          register: runSpots(f.register),
          bank: runSpots(f.bank),
          bankGuess: runSpots(f.bankGuess),
        },
      })),
      stubs: p.plan.stubs.map((x) => ({
        fileId: x.fileId,
        fileName: p.fileNames.get(x.fileId) ?? '',
        participant:
          x.participant && x.month
            ? {
                id: x.participant.id,
                name: x.participant.displayName,
                participantId: x.participant.participantId,
                engagementId: x.month.engagementId,
                engagementName: x.month.engagementName,
              }
            : null,
        payPeriodStart: x.reading.start,
        payPeriodEnd: x.reading.end,
        payDate: x.reading.payDate ?? x.reading.end,
        source: x.reading.source ?? 'rules',
        grossAmount: x.reading.gross,
        action: x.action,
        wexPaymentId: x.wexId,
        reportId: x.month?.reportId ?? null,
        flags: x.flags,
        previousAmount:
          x.wexId && (x.action === 'update' || x.action === 'same')
            ? (p.byKey.get(`wex-${x.wexId}`)?.proof.amount ?? null)
            : null,
        payLine: x.reading.payLine,
        bank: x.debit ? spot(x.debit) : null,
        timesheet: x.timesheet ? spot(x.timesheet) : null,
        register: x.register ? spot(x.register) : null,
        named: x.named,
      })),
      links: p.creates.length + p.updates.length + p.fresh.length,
      unlinks: p.deletes.length + p.leavingLinks.length,
      files: p.change.matching.map((f) => ({
        fileId: f.id,
        fileName: f.fileName,
        kind: f.kind as PayrollDocumentKind,
        engagements: engagementsOf(
          p.reached.filter((r) => r.fileId === f.id).map((r) => r.reportId)
        ),
      })),
      proof: [...proof.values()],
      change: {
        joining: p.change.joining.map((f) => ({
          fileId: f.id,
          fileName: f.fileName,
          kind: f.kind as PayrollDocumentKind,
        })),
        leaving: p.change.leaving.map((l) => ({
          documentId: l.doc.id,
          fileName: l.doc.fileName,
          kind: l.doc.kind as PayrollDocumentKind,
          why: l.why,
        })),
        unchanged: p.change.unchanged,
        total: p.change.total,
      },
      payments: {
        create: p.stubWrites.filter((x) => x.action === 'create').length,
        update: p.stubWrites.filter((x) => x.action === 'update').length,
        remove: p.paymentsGone.filter((g) => !g.detach).length,
      },
      payrollLines: {
        write: p.payrollLines.create.length + p.payrollLines.change.length,
        keep: [...p.payrollLines.keep, ...p.payrollLines.books].map((e) => ({
          ...e,
          engagementName: engagementsOf([e.reportId])[0]?.name ?? '',
        })),
      },
      dropped: p.dropped.map((d) => ({ ...d, id: null, by: null, at: null })),
      months: touched,
      reopen: touched.filter((m) => m.status !== 'draft'),
      alreadyOnFile: p.onFile.size,
      twoProofs: p.twoProofs,
      unlisted: unlistedPeople(p.plan, p.files, p.staff, p.participants),
      complete: p.change.complete,
    }
  }

  // ── The months ───────────────────────────────────────────────────────────

  /** The months any engagement of the workspace has, newest first, with how many pays were kept for each. Counts only. */
  async periods(caller: Caller, workspaceId: string): Promise<WorkspacePayrollPeriodDto[]> {
    this.reader(caller, workspaceId)
    // Counted by the database, per month: no row is read just to be counted.
    const [months, lines] = await Promise.all([
      this.prisma.monthlyReport.groupBy({
        by: ['period'],
        where: { workspaceId },
        _count: { _all: true },
      }),
      this.prisma.payrollPayLine.groupBy({
        by: ['period'],
        where: { workspaceId },
        _count: { _all: true },
      }),
    ])
    const out = new Map<string, WorkspacePayrollPeriodDto>()
    const of = (period: string) =>
      out.get(period) ?? out.set(period, { period, months: 0, payLines: 0 }).get(period)!
    for (const m of months) of(m.period).months += m._count._all
    for (const l of lines) of(l.period).payLines += l._count._all
    return [...out.values()].sort((a, b) => b.period.localeCompare(a.period))
  }

  // ── The run ──────────────────────────────────────────────────────────────

  private async load(caller: Caller, runId: string): Promise<RunRow> {
    const run = await this.prisma.payrollMatchRun.findFirst({
      where: { id: runId, monthlyReportId: null, ...tenantWhere(caller) },
      include: { files: { orderBy: [{ kind: 'asc' }, { fileName: 'asc' }] } },
    })
    if (!run || !run.period) throw new NotFoundException()
    // The admin's reading words and what AI read, in force before anything is matched.
    await this.reading.current()
    const row: RunRow = run
    await this.ai.attach(run.workspaceId!, row.files)
    return row
  }

  /** The run, its starter's own, while they own the workspace and within RUN_HOURS. */
  private async open(caller: Caller, runId: string) {
    const run = await this.load(caller, runId)
    if (run.createdById !== caller.userId) throw new NotFoundException()
    this.owner(caller, run.workspaceId!)
    if (run.createdAt.getTime() < Date.now() - RUN_MS)
      throw new BadRequestException('This match was left for over a day. Upload the zip again.')
    return run as WorkspaceRun
  }

  /**
   * The caller's own unsaved run of the month, for the page to pick up where it was; one read line, as `get`. An
   * auditor never has one (null); anyone not an owner or auditor finds nothing here (404, as `reader`).
   */
  async latest(
    caller: Caller,
    workspaceId: string,
    period: unknown
  ): Promise<WorkspacePayrollRunDto | null> {
    this.reader(caller, workspaceId)
    const p = this.period(period)
    if (!workspaceRole(caller, workspaceId, ['owner'])) return null
    const run = await this.openRunOf(caller, workspaceId, p)
    return run ? this.get(caller, run.id) : null
  }

  /** The caller's newest unsaved run of the workspace and month still within RUN_HOURS, if any. */
  private openRunOf(caller: Caller, workspaceId: string, period: string) {
    return this.prisma.payrollMatchRun.findFirst({
      where: {
        workspaceId,
        period,
        monthlyReportId: null,
        createdById: caller.userId,
        createdAt: { gte: new Date(Date.now() - RUN_MS) },
      },
      include: { files: true },
      orderBy: { createdAt: 'desc' },
    })
  }

  /**
   * Starts a change of the month's set by upload: Replace all (`expected`: how many different files, by contents, the
   * zip holds) or Add files. The caller's own unsaved run of the month for the same change is answered as it stands
   * (one read line, as `get`), so an upload that stopped halfway carries on: the page sends the files again and `add`
   * skips each one the run already has. An unsaved run of another change is discarded first.
   */
  async start(
    caller: Caller,
    workspaceId: string,
    period: unknown,
    input: WorkspacePayrollStartInput = {}
  ): Promise<WorkspacePayrollRunDto> {
    this.owner(caller, workspaceId)
    const p = this.period(period)
    const mode = input?.mode ?? 'add'
    if (mode !== 'replace' && mode !== 'add')
      throw new BadRequestException('Say whether the files replace all of the month or are added')
    let expected: number | null = null
    if (mode === 'replace') {
      const n = input?.expected
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 1)
        throw new BadRequestException('Say how many different files the zip holds')
      if (n > MAX) throw new BadRequestException(TOO_MANY(n))
      expected = n
    }
    return this.begin(caller, workspaceId, p, mode, { expected })
  }

  /** Remove a file: a change of the set that takes this one file out, matched again from the rest. */
  async removeFile(
    caller: Caller,
    workspaceId: string,
    period: unknown,
    documentId: string
  ): Promise<WorkspacePayrollRunDto> {
    this.owner(caller, workspaceId)
    const p = this.period(period)
    const set = await this.setOf(workspaceId, p)
    if (!set.some((d) => d.id === documentId)) throw new NotFoundException()
    return this.begin(caller, workspaceId, p, 'remove', { removeId: documentId })
  }

  /**
   * Match again: the set as it is, matched again, after a participant was added or staff were tagged to an engagement.
   * Saved as any change, so a payment or proof link that is already so is not written again.
   */
  async matchAgain(
    caller: Caller,
    workspaceId: string,
    period: unknown
  ): Promise<WorkspacePayrollRunDto> {
    this.owner(caller, workspaceId)
    const p = this.period(period)
    const onFile = await this.prisma.document.count({
      where: {
        workspaceId,
        engagementId: null,
        period: p,
        kind: { in: [...PAYROLL_DOCUMENT_KINDS] },
      },
    })
    if (!onFile)
      throw new BadRequestException(
        `No workspace payroll files are saved for ${monthName(p)}: upload them first`
      )
    return this.begin(caller, workspaceId, p, 'match', {})
  }

  /**
   * A run of the change, with the files of the set it keeps (each read again by the job, as a staged file is), in one
   * transaction with its lines. Replace all keeps none at first: each file of the zip that is already in the set, the
   * same name, kind and contents, is taken from the set as it arrives (`add`). Only the caller's own unsaved run of this
   * month is ever removed here, never anyone else's (the sweeper removes runs left over a day).
   */
  private async begin(
    caller: Caller,
    workspaceId: string,
    period: string,
    mode: WorkspacePayrollMode,
    opts: { expected?: number | null; removeId?: string }
  ): Promise<WorkspacePayrollRunDto> {
    const open = await this.openRunOf(caller, workspaceId, period)
    if (open && modeOf(open) === mode) {
      const removed = open.setDocumentIds.filter(
        (id) => !open.files.some((f) => f.documentId === id)
      )
      const same =
        mode === 'replace'
          ? open.expectedFiles === (opts.expected ?? null)
          : mode === 'remove'
            ? removed.length === 1 && removed[0] === opts.removeId
            : true
      if (same) return this.get(caller, open.id)
    }
    // The set's size first: a refusal changes nothing, the caller's unsaved uploads included.
    const set = await this.setOf(workspaceId, period)
    if (set.length > MAX) throw new BadRequestException(TOO_MANY(set.length))
    const mine = await this.prisma.payrollMatchRun.findMany({
      where: { workspaceId, period, monthlyReportId: null, createdById: caller.userId },
      include: { files: true },
    })
    for (const run of mine)
      await this.match.remove(
        caller,
        run,
        'Removed an unsaved',
        run.createdAt.getTime() < Date.now() - RUN_MS ? 'expired' : 'discarded'
      )
    const keep = mode === 'replace' ? [] : set.filter((d) => d.id !== opts.removeId)
    const removed = set.find((d) => d.id === opts.removeId)
    const runId = randomUUID()
    const lines: LogEntry[] = keep.length
      ? [
          {
            workspaceId,
            resource: 'document',
            action: 'read',
            description: `Sent ${howMany(keep.length, 'workspace payroll file')} for ${monthName(period)} to be read and matched`,
          },
        ]
      : []
    await this.log.change(
      caller,
      async (tx) => {
        const run = await tx.payrollMatchRun.create({
          data: {
            id: runId,
            workspaceId,
            period,
            createdById: caller.userId,
            mode,
            expectedFiles: opts.expected ?? null,
            setDocumentIds: set.map((d) => d.id),
            replace: mode === 'replace',
          },
        })
        if (keep.length)
          await tx.payrollMatchFile.createMany({
            data: keep.map((d) => ({
              runId,
              documentId: d.id,
              kind: d.kind,
              sensitivity: d.sensitivity,
              fileName: d.fileName,
              contentType: d.contentType,
              size: d.size,
              sha256: d.sha256,
              storageKey: d.storageKey,
              storage: storageName(),
            })),
          })
        await this.log.alsoMany(tx, caller, lines)
        return run
      },
      {
        workspaceId,
        resource: 'workspace',
        subjectId: workspaceId,
        action: 'create',
        description: `Started ${MODE_WORDS[mode].start} for ${monthName(period)} for the whole workspace${removed ? ` (${describe(removed)})` : ''}`,
      }
    )
    if (keep.length) this.worker.kick()
    return this.dto(caller, (await this.load(caller, runId)) as WorkspaceRun)
  }

  /**
   * Files of a Replace all or Add files run, 20 at a time, each with the kind its folder gave it, checked as any upload
   * and staged. A file is known by its contents: one the run already has (sent again after a batch failed, or twice in
   * the zip) is skipped; in Replace all, one already in the set with the same name and kind is taken from the set, not
   * stored again. Over MAX_WORKSPACE_PAYROLL_FILES for the month is refused, nothing dropped. The batch's rows go in one
   * transaction with its line; its stored objects are deleted again if that fails.
   */
  async add(
    caller: Caller,
    runId: string,
    files: Uploaded[],
    kinds: unknown
  ): Promise<WorkspacePayrollRunDto> {
    const run = await this.open(caller, runId)
    const mode = modeOf(run)
    if (mode !== 'replace' && mode !== 'add')
      throw new BadRequestException('This change takes no files')
    const list = Array.isArray(kinds) ? kinds : kinds == null ? [] : [kinds]
    if (!Array.isArray(files) || !files.length)
      throw new BadRequestException('Choose at least one file')
    if (files.length > MAX_PAYROLL_FILES)
      throw new BadRequestException(`Send at most ${MAX_PAYROLL_FILES} files at a time`)
    if (list.length !== files.length || !list.every(isKind))
      throw new BadRequestException(
        'Say for each file whether it is a timesheet, a payroll register, a pay stub or a bank statement'
      )
    const set =
      mode === 'replace' && run.setDocumentIds.length
        ? await this.prisma.document.findMany({
            where: { id: { in: run.setDocumentIds }, workspaceId: run.workspaceId },
          })
        : []
    const have = new Set(run.files.map((f) => f.sha256))
    const fresh: { file: Uploaded; kind: PayrollDocumentKind; sha: string }[] = []
    const claimed: Document[] = []
    for (const [i, f] of files.entries()) {
      const sha = sha256Of(f)
      if (have.has(sha)) continue
      have.add(sha)
      const kind = list[i] as PayrollDocumentKind
      const same = set.find(
        (d) =>
          d.sha256 === sha &&
          d.kind === kind &&
          d.fileName === storedFileName(f.originalname) &&
          keyInWorkspace(d)
      )
      if (same) claimed.push(same)
      else fresh.push({ file: f, kind, sha })
    }
    // The set this would make: in Replace all, the zip's files; in Add files, the set with these joining (one of the
    // same contents, or the same name and kind, takes its place).
    const staged = [
      ...run.files.filter((f) => !f.documentId).map((f) => ({ ...f })),
      ...fresh.map((f) => ({
        sha256: f.sha,
        fileName: storedFileName(f.file.originalname),
        kind: f.kind as string,
      })),
    ]
    const total =
      mode === 'replace'
        ? run.files.length + claimed.length + fresh.length
        : run.files.filter(
            (f) =>
              f.documentId &&
              !staged.some(
                (s) => s.sha256 === f.sha256 || (s.fileName === f.fileName && s.kind === f.kind)
              )
          ).length + staged.length
    if (total > MAX) throw new BadRequestException(TOO_MANY(total))
    if (mode === 'replace' && run.files.length + claimed.length + fresh.length > run.expectedFiles!)
      throw new BadRequestException(
        `The zip was said to hold ${howMany(run.expectedFiles!, 'different file')}; these make more. Start again with the right count.`
      )
    if (!fresh.length && !claimed.length) return this.dto(caller, run)
    const stagedFiles: StagedFile[] = []
    for (const f of fresh)
      stagedFiles.push(
        await this.documents.stage(caller, f.file, {
          workspaceId: run.workspaceId,
          period: run.period,
          kind: f.kind,
        })
      )
    const rows: Prisma.PayrollMatchFileCreateManyInput[] = [
      ...stagedFiles.map((s) => ({
        runId: run.id,
        kind: s.data.kind,
        sensitivity: s.data.sensitivity,
        fileName: s.data.fileName,
        contentType: s.data.contentType,
        size: s.data.size,
        sha256: s.data.sha256,
        storageKey: s.data.storageKey,
        storage: storageName(),
      })),
      ...claimed.map((d) => ({
        runId: run.id,
        documentId: d.id,
        kind: d.kind,
        sensitivity: d.sensitivity,
        fileName: d.fileName,
        contentType: d.contentType,
        size: d.size,
        sha256: d.sha256,
        storageKey: d.storageKey,
        storage: storageName(),
      })),
    ]
    const save = () =>
      this.log.change(
        caller,
        (tx) => tx.payrollMatchFile.createMany({ data: rows }),
        () => ({
          workspaceId: run.workspaceId,
          resource: 'document',
          action: 'create',
          description: `Sent ${howMany(rows.length, 'payroll file')} for ${monthName(run.period)} to be read and matched for the whole workspace${claimed.length ? ` (${howMany(claimed.length, 'file')} already among the month's payroll files)` : ''}`,
        })
      )
    // Every object stored first, each deleted again if the rows' transaction fails.
    const commitFrom = (i: number): Promise<unknown> =>
      i === stagedFiles.length ? save() : stagedFiles[i]!.commit(() => commitFrom(i + 1))
    await commitFrom(0)
    this.worker.kick()
    return this.dto(caller, (await this.load(caller, run.id)) as WorkspaceRun)
  }

  /** How far the job is: counts only, so polling it writes no line. */
  async progress(caller: Caller, runId: string): Promise<PayrollMatchProgress> {
    const run = await this.open(caller, runId)
    const count = (s: string) => run.files.filter((f) => f.status === s).length
    return { total: run.files.length, read: count('read'), failed: count('failed') }
  }

  /** The run as the page shows it, opened again: one read line. */
  async get(caller: Caller, runId: string): Promise<WorkspacePayrollRunDto> {
    const run = await this.open(caller, runId)
    await this.log.log(caller, {
      workspaceId: run.workspaceId,
      resource: 'document',
      action: 'read',
      description: `Opened the workspace payroll match for ${monthName(run.period)} (${howMany(run.files.length, 'file')})`,
    })
    return this.dto(caller, run)
  }

  /** One file's bytes, for the viewer. Logged. */
  async file(caller: Caller, runId: string, fileId: string) {
    const run = await this.open(caller, runId)
    const f = run.files.find((x) => x.id === fileId)
    if (!f || !f.storageKey.startsWith(`${run.workspaceId}/`)) throw new NotFoundException()
    const bytes = await this.storage.read(f.storageKey)
    await this.log.log(caller, {
      workspaceId: run.workspaceId,
      resource: 'document',
      subjectId: f.documentId,
      action: 'read',
      description: `Opened ${describe({ ...f, period: run.period })} while matching the workspace's payroll`,
    })
    return { bytes, contentType: f.contentType, fileName: f.fileName }
  }

  /** One item's own copy of a file of the run, with only its highlights, as Save will keep them. Logged. */
  async copy(
    caller: Caller,
    runId: string,
    fileId: string,
    target: string,
    id: string,
    slot: string
  ): Promise<{ bytes: Uint8Array; contentType: string; fileName: string }> {
    const run = await this.open(caller, runId)
    const f = run.files.find((x) => x.id === fileId)
    if (!f || !f.storageKey.startsWith(`${run.workspaceId}/`)) throw new NotFoundException()
    const { items } = await workspaceItems(this.prisma, caller, run.workspaceId, run.period)
    const item = items.find((i) => i.target === target && i.id === id)
    if (!item || !slotsOf(item.proof).includes(slot as PayrollSlot)) throw new NotFoundException()
    const highlight = await this.highlights.current()
    const c = matchSlot(
      item.proof,
      slot as PayrollSlot,
      [proofFile(f)],
      highlight[PAYROLL_SLOT_KIND[slot as PayrollSlot]],
      run.files.map(proofFile)
    ).candidates[0]
    const marks = c?.marks.length ? c.marks : c?.mark ? [c.mark] : []
    const original = new Uint8Array(await this.storage.read(f.storageKey))
    const bytes = COPIED_TYPES.includes(f.contentType)
      ? (await itemCopy(original, marks)).bytes
      : original
    await this.log.log(caller, {
      workspaceId: run.workspaceId,
      resource: 'document',
      subjectId: f.documentId,
      action: 'read',
      description: `Opened ${describe({ ...f, period: run.period })} highlighted for ${item.subject} of ${item.month.engagementName} while matching the workspace's payroll`,
    })
    return { bytes, contentType: f.contentType, fileName: f.fileName }
  }

  /**
   * Save the change, all in one transaction, so a failure anywhere leaves every month and every file as it was.
   * Everything is checked before anything is written (the files read, Replace all's zip complete, the set unchanged
   * since the run started, the limit, the reason for any month that must be reopened). Then, in order:
   * - the months the save changes that are closed or submitted are reopened, each exactly as its own page does it;
   * - payments made from a stub that leaves go (one typed by hand first stays, untied);
   * - the decisions on leaving files are recorded as dropped, and the leaving files go (their links, pays and staff
   *   proofs with them), after the run, which holds some of them;
   * - every staged file becomes one workspace document with its person-pays kept;
   * - the staff proofs are rewritten, each stub's payment made or changed, and the match's links added, changed and
   *   removed; each proof the owner chose by hand is linked as theirs.
   * Every write has its line in the same transaction (in batches). The months' checks run again after; the leaving
   * files' stored objects go once it committed. Answers the reconciliation, unlogged (the person's own action).
   */
  async save(
    caller: Caller,
    runId: string,
    input: WorkspacePayrollSaveInput
  ): Promise<PayrollReconciliationDto> {
    const run = await this.open(caller, runId)
    const mode = modeOf(run)
    if (run.files.some((f) => f.status === 'waiting' || f.status === 'reading'))
      throw new BadRequestException('The files are still being read. Save once they are done.')
    const found = await workspaceItems(this.prisma, caller, run.workspaceId, run.period)
    const months = found.months
    const planned = await this.planOf(run, found.items, months)
    const { plan, change, items } = planned
    if (!change.complete)
      throw new ConflictException(
        `${new Set(run.files.map((f) => f.sha256)).size} of the zip's ${run.expectedFiles} files have arrived: send the zip again to finish the upload`
      )
    if (change.stale) throw new ConflictException(SET_CHANGED)
    if (change.total > MAX) throw new BadRequestException(TOO_MANY(change.total))
    const byKey = planned.byKey
    const links = Array.isArray(input?.links) ? input.links : []
    if (links.length > 2000) throw new BadRequestException('Too many links at once')
    const highlight = planned.highlight
    const files = new Map(change.matching.map((f) => [f.id, f]))
    const chosen = links.map((l) => {
      const item = byKey.get(`${l?.target}-${l?.id}`)
      if (!item)
        throw new BadRequestException(
          `A payroll item is not of an engagement's ${monthName(run.period)}`
        )
      if (!slotsOf(item.proof).includes(l.slot))
        throw new BadRequestException(`That proof is not one ${item.proof.kind} pay needs`)
      const f = files.get(l.fileId)
      if (!f || f.kind !== PAYROLL_SLOT_KIND[l.slot])
        throw new BadRequestException(`Choose a ${SLOT_WORDS[l.slot]} of this zip`)
      const found = matchSlot(
        item.proof,
        l.slot,
        [proofFile(f)],
        highlight[PAYROLL_SLOT_KIND[l.slot]],
        planned.files
      ).candidates[0]
      const mark = found?.mark ? cleanMark(found.mark) : null
      if (l.slot === 'bank' && !mark)
        throw new BadRequestException(
          `No line for this payment was found on ${f.fileName}: link it from the reconciliation after saving`
        )
      return {
        target: item.target,
        itemId: item.id,
        fileId: f.id,
        purpose: PURPOSE[l.slot],
        slot: l.slot,
        mark,
        marks: (found?.marks ?? []).slice(0, 20).map(cleanMark),
        reportId: item.month.reportId,
        payRun: found?.payRun === true && !!mark,
      }
    })
    // The months the save changes; a closed or submitted one is reopened in the save, before anything is written to it.
    const monthById = new Map(months.map((m) => [m.reportId, m]))
    const touched = new Set([...planned.touched, ...chosen.map((c) => c.reportId)])
    const locked = [...touched]
      .map((id) => monthById.get(id))
      .filter((m): m is (typeof months)[number] => !!m && m.status !== 'draft')
    const why = typeof input?.reopenReason === 'string' ? input.reopenReason.trim() : ''
    if (locked.length && !why)
      throw new BadRequestException(
        `Say why ${monthsWords(locked.map((m) => ({ ...m, period: run.period })))} ${locked.length === 1 ? 'is' : 'are'} reopened`
      )
    if (why.length > 500) throw new BadRequestException('The reason must be at most 500 characters')
    const unlocks: ((tx: Prisma.TransactionClient) => Promise<void>)[] = []
    for (const m of locked)
      unlocks.push(
        m.status === 'submitted'
          ? await this.reports.reopenWith(caller, m.reportId, why)
          : await this.reports.sendBackWith(caller, m.reportId, why)
      )
    const leavingIds = [...change.leavingIds]
    if (
      leavingIds.length &&
      (await this.prisma.payrollMatchFile.count({
        where: { documentId: { in: leavingIds }, runId: { not: run.id } },
      }))
    )
      throw new ConflictException(HELD)

    // The documents the staged files become, with their ids now, so every row can name them.
    const docIds = new Map(change.matching.map((f) => [f.id, f.documentId]))
    const newDocs = change.joining.map((f) => {
      const id = randomUUID()
      docIds.set(f.id, id)
      return {
        id,
        workspaceId: run.workspaceId,
        engagementId: null,
        period: run.period,
        kind: f.kind,
        sensitivity: DOCUMENT_SENSITIVITY[f.kind as PayrollDocumentKind],
        fileName: f.fileName,
        contentType: f.contentType,
        size: f.size,
        sha256: f.sha256,
        storageKey: f.storageKey,
        uploadedById: caller.userId,
      }
    })
    const stubFlags = new Map(plan.stubs.map((x) => [x.fileId, x.flags]))
    const away = awayLines(planned.files, run.period)
    const kindOf = new Map(planned.files.map((f) => [f.id, f.kind]))
    const proofRows = staffProofRows(plan, docIds, run.period, items, kindOf)
    const unchangedStubs = change.matching.filter((f) => f.documentId && f.kind === 'paystub')
    const subject = (target: 'expense' | 'wex', itemId: string) =>
      byKey.get(`${target}-${itemId}`)?.subject ?? 'a work-experience payment'
    const engagementOf = (reportId: string) => monthById.get(reportId)?.engagementName ?? ''
    const fileOf = (fileId: string) => ({ ...files.get(fileId)!, period: run.period })
    const engagements = new Set(
      [...touched].map((id) => monthById.get(id)?.engagementId).filter(Boolean)
    )
    const staffFound = plan.staff.filter(
      (f) => f.register.length || f.timesheet.length || f.bank.length
    )
    const flagged = plan.stubs.filter((x) => x.flags.length).length
    const removedPayments = planned.paymentsGone.filter((g) => !g.detach)
    let kept = 0
    const leavingDocs = change.leaving.map((l) => l.doc)
    await this.log.change(
      caller,
      async (tx) => {
        // One change of a month's set at a time: a second owner's save waits here, then finds the set changed.
        await tx.$queryRaw`SELECT 1 AS "locked" FROM pg_advisory_xact_lock(hashtext(${`payroll-set:${run.workspaceId}:${run.period}`}))`
        const setNow = await tx.document.findMany({
          where: {
            workspaceId: run.workspaceId,
            engagementId: null,
            period: run.period,
            kind: { in: [...PAYROLL_DOCUMENT_KINDS] },
          },
          select: { id: true, workspaceId: true, engagementId: true, storageKey: true },
        })
        if (
          setNow
            .filter((d) => keyInWorkspace(d))
            .map((d) => d.id)
            .sort()
            .join(',') !== [...run.setDocumentIds].sort().join(',')
        )
          throw new ConflictException(SET_CHANGED)
        // The run as it stands, checked again inside the save: a run discarded or saved meanwhile (another tab, an
        // engagement deleted) or a file removed meanwhile refuses the whole save.
        const still = await tx.payrollMatchRun.findFirst({
          where: { id: run.id },
          select: { files: { select: { id: true, documentId: true } } },
        })
        if (!still || still.files.length !== run.files.length)
          throw new ConflictException(UPLOAD_CHANGED)
        for (const unlock of unlocks) await unlock(tx)
        const lines: LogEntry[] = []
        const line = (e: Omit<LogEntry, 'workspaceId'>) =>
          lines.push({ workspaceId: run.workspaceId, ...e })

        // Payments made from a stub that leaves: gone, or (typed by hand first) kept and no longer tied to it.
        for (const g of planned.paymentsGone) {
          const m = g.item.month
          if (g.detach) {
            await tx.wexPayment.update({
              where: { id: g.item.id },
              data: { stubDocumentId: null, stubTookOver: false },
            })
            line({
              resource: 'report',
              subjectId: g.item.id,
              action: 'update',
              description: `Kept a work-experience payment in ${monthName(run.period)} of ${m.engagementName}, typed by hand, when its pay stub left the month's payroll files`,
            })
          } else {
            await tx.wexPayment.delete({ where: { id: g.item.id } })
            line({
              resource: 'report',
              subjectId: g.item.id,
              action: 'delete',
              description: `Removed a work-experience payment from ${monthName(run.period)} of ${m.engagementName}: its pay stub left the month's payroll files`,
            })
          }
        }

        // The decisions on leaving files, recorded as dropped; then the run, which holds some of them; then the files.
        if (planned.dropped.length)
          await tx.payrollDroppedDecision.createMany({
            data: planned.dropped.map((d) => ({
              workspaceId: run.workspaceId,
              period: run.period,
              fileName: d.fileName,
              kind: d.kind,
              decision: d.decision,
              why: d.why,
              itemTitle: d.itemTitle,
              engagementName: d.engagementName,
              droppedById: caller.userId,
              droppedByEmail: staffName(caller),
            })),
          })
        await tx.payrollMatchRun.delete({ where: { id: run.id } })
        if (leavingDocs.length) {
          await tx.document.deleteMany({ where: { id: { in: leavingIds } } })
          for (const l of change.leaving) {
            const decisions = planned.dropped.filter(
              (d) => d.fileName === l.doc.fileName && d.kind === l.doc.kind
            ).length
            line({
              resource: 'document',
              subjectId: l.doc.id,
              action: 'delete',
              description: `Removed ${describe(l.doc)} from the workspace's payroll files${l.why === 'changed' ? ', replaced by a new copy' : ''}${decisions ? `, with ${howMany(decisions, 'decision')} made on it` : ''}`,
            })
          }
        }

        // The staged files, each one workspace document, with every person-pay in it kept for the reconciliation.
        if (newDocs.length) {
          await tx.document.createMany({ data: newDocs })
          const pays: Prisma.PayrollPayLineCreateManyInput[] = []
          for (const f of change.joining) {
            const doc = newDocs.find((d) => d.id === docIds.get(f.id))!
            line({
              resource: 'document',
              subjectId: doc.id,
              action: 'create',
              description: `Uploaded ${describe(doc)} with the workspace's payroll`,
            })
            if (!isPayKind(f.kind)) continue
            const fileLines = payLinesOf(proofFile(f))
            if (companyTotals(f.kind, fileLines, planned.staff, planned.participants)) continue
            const unclear = payUnclearLines(proofFileOf(f))
            const paidAway = f.kind === 'payroll-register' && away.files.has(f.id)
            for (const l of fileLines)
              pays.push({
                documentId: doc.id,
                period: run.period,
                kind: f.kind,
                ...(l ? { mark: cleanMark(l) as object } : {}),
                flags: [
                  ...(stubFlags.get(f.id) ?? []),
                  ...(l && unclear.has(l) ? (['pay-unclear'] as const) : []),
                  ...(paidAway || (f.kind === 'bank-statement' && l && away.isDebit(f.id, l))
                    ? (['other-month'] as const)
                    : []),
                ],
              })
          }
          for (let i = 0; i < pays.length; i += 1000)
            await tx.payrollPayLine.createMany({ data: pays.slice(i, i + 1000) })
          kept = pays.length
        }
        // A pay stub already in the set keeps its pay; its flags are those of this match (grouped, one write per kind).
        const byFlags = new Map<string, string[]>()
        for (const f of unchangedStubs) {
          const key = (stubFlags.get(f.id) ?? []).join(',')
          byFlags.set(key, [...(byFlags.get(key) ?? []), f.documentId!])
        }
        for (const [key, ids] of byFlags)
          await tx.payrollPayLine.updateMany({
            where: { documentId: { in: ids }, kind: 'paystub' },
            data: { flags: key ? key.split(',') : [] },
          })
        // A bank statement already in the set: its lines that are another month's run debit say so, as the set is now.
        const unchangedBanks = change.matching.filter(
          (f) => f.documentId && f.kind === 'bank-statement'
        )
        if (unchangedBanks.length) {
          const kept = await tx.payrollPayLine.findMany({
            where: { documentId: { in: unchangedBanks.map((f) => f.documentId!) } },
            select: { id: true, documentId: true, mark: true, flags: true },
          })
          for (const l of kept) {
            const file = unchangedBanks.find((f) => f.documentId === l.documentId)!
            const mark = l.mark as StatementLine | null
            const want = !!mark && away.isDebit(file.id, mark)
            const has = l.flags.includes('other-month')
            if (want === has) continue
            await tx.payrollPayLine.update({
              where: { id: l.id },
              data: {
                flags: want
                  ? [...l.flags, 'other-month']
                  : l.flags.filter((x) => x !== 'other-month'),
              },
            })
          }
        }

        // What was found of each person in the set, rewritten for the month.
        await tx.staffPayProof.deleteMany({
          where: { workspaceId: run.workspaceId, period: run.period },
        })
        for (let i = 0; i < proofRows.length; i += 1000)
          await tx.staffPayProof.createMany({ data: proofRows.slice(i, i + 1000) })

        // Each stub's payment, made or changed from it: the pay period and the gross pay it prints.
        const wexOf = new Map<string, string>()
        for (const x of planned.stubWrites) {
          const m = x.month!
          const data = {
            participantId: x.participant!.id,
            payPeriodStart: new Date(`${x.reading.start}T00:00:00Z`),
            payPeriodEnd: new Date(`${x.reading.end}T00:00:00Z`),
            grossAmount: x.reading.gross!.toFixed(2),
            stubDocumentId: docIds.get(x.fileId)!,
          }
          if (x.action === 'create') {
            const w = await tx.wexPayment.create({ data: { monthlyReportId: m.reportId, ...data } })
            wexOf.set(x.fileId, w.id)
            line({
              resource: 'report',
              subjectId: w.id,
              action: 'create',
              description: `Added a work-experience payment to ${monthName(run.period)} of ${m.engagementName} from a pay stub`,
              changes: changesOf(null, data, WEX_FIELDS),
            })
            continue
          }
          const before = await tx.wexPayment.findFirst({ where: { id: x.wexId! } })
          if (!before) throw new ConflictException(UPLOAD_CHANGED)
          await tx.wexPayment.update({
            where: { id: before.id },
            data: { ...data, ...(x.takesOverTyped ? { stubTookOver: true } : {}) },
          })
          line({
            resource: 'report',
            subjectId: before.id,
            action: 'update',
            description: x.takesOverTyped
              ? `Took over a work-experience payment typed by hand in ${monthName(run.period)} of ${m.engagementName} with its pay stub`
              : `Changed a work-experience payment in ${monthName(run.period)} of ${m.engagementName} from its pay stub`,
            changes: changesOf(before, data, WEX_FIELDS),
          })
        }

        // The match's own links: removed where it no longer finds them, changed where their highlights moved, added.
        for (const target of ['expense', 'wex'] as const) {
          const gone = planned.deletes.filter((d) => d.target === target)
          for (let i = 0; i < gone.length; i += 500) {
            const part = gone.slice(i, i + 500)
            if (target === 'expense')
              await tx.expenseDocument.deleteMany({
                where: {
                  byMatch: true,
                  OR: part.map((d) => ({ expenseId: d.itemId, documentId: d.documentId })),
                },
              })
            else
              await tx.wexPaymentDocument.deleteMany({
                where: {
                  byMatch: true,
                  OR: part.map((d) => ({ wexPaymentId: d.itemId, documentId: d.documentId })),
                },
              })
          }
        }
        for (const d of planned.deletes)
          line({
            resource: d.target === 'expense' ? 'expense' : 'report',
            subjectId: d.itemId,
            action: 'update',
            description: `Unlinked ${describe({ kind: d.kind, sensitivity: DOCUMENT_SENSITIVITY[d.kind as PayrollDocumentKind] ?? 'financial', period: run.period })} from ${subject(d.target, d.itemId)} of ${engagementOf(d.reportId)}: the match no longer finds it there`,
          })
        for (const u of planned.updates) {
          const data = {
            purpose: u.purpose,
            mark: (u.mark ?? undefined) as object | undefined,
            marks: u.marks as object[],
            payRun: u.payRun === true,
          }
          if (u.target === 'expense')
            await tx.expenseDocument.update({
              where: { expenseId_documentId: { expenseId: u.itemId, documentId: u.documentId } },
              data,
            })
          else
            await tx.wexPaymentDocument.update({
              where: {
                wexPaymentId_documentId: { wexPaymentId: u.itemId, documentId: u.documentId },
              },
              data,
            })
          line({
            resource: u.target === 'expense' ? 'expense' : 'report',
            subjectId: u.itemId,
            action: 'update',
            description: `Changed the highlights of ${describe(fileOf(u.fileId))} on ${subject(u.target, u.itemId)} of ${engagementOf(u.reportId)}`,
          })
        }
        // New links: to items already there, and to the payments just made from stubs.
        const adds: LinkWrite[] = [
          ...planned.creates,
          ...planned.fresh.flatMap((l): LinkWrite[] => {
            const itemId = l.itemId ?? wexOf.get(l.stubFileId ?? '')
            const documentId = docIds.get(l.fileId)
            return itemId && documentId
              ? [
                  {
                    target: l.target,
                    itemId,
                    documentId,
                    purpose: l.purpose,
                    slot: l.slot,
                    mark: l.mark,
                    marks: l.marks,
                    reportId: l.reportId,
                    fileId: l.fileId,
                    pick: l.pick,
                    payRun: l.payRun === true,
                  },
                ]
              : []
          }),
        ]
        // A proof the owner chose for an item wins over the match's link to the same file, and over Auto-Match's
        // pick of another file for the same proof.
        const handKeys = new Set(
          chosen.map((c) => linkKey(c.target, c.itemId, docIds.get(c.fileId)!))
        )
        const handSlots = new Set(chosen.map((c) => `${c.target}:${c.itemId}:${c.slot}`))
        const auto = adds.filter(
          (a) =>
            !handKeys.has(linkKey(a.target, a.itemId, a.documentId)) &&
            !(a.pick && handSlots.has(`${a.target}:${a.itemId}:${a.slot}`))
        )
        for (const target of ['expense', 'wex'] as const) {
          const rows = auto.filter((a) => a.target === target)
          for (let i = 0; i < rows.length; i += 500) {
            const part = rows.slice(i, i + 500).map((c) => ({
              documentId: c.documentId,
              purpose: c.purpose,
              mark: (c.mark ?? undefined) as object | undefined,
              marks: c.marks as object[],
              byMatch: true,
              payRun: c.payRun === true,
            }))
            if (target === 'expense')
              await tx.expenseDocument.createMany({
                data: part.map((p, n) => ({ ...p, expenseId: rows[i + n]!.itemId })),
                skipDuplicates: true,
              })
            else
              await tx.wexPaymentDocument.createMany({
                data: part.map((p, n) => ({ ...p, wexPaymentId: rows[i + n]!.itemId })),
                skipDuplicates: true,
              })
          }
        }
        for (const a of auto)
          line({
            resource: a.target === 'expense' ? 'expense' : 'report',
            subjectId: a.itemId,
            action: 'update',
            description: `Linked ${describe(fileOf(a.fileId))} to ${subject(a.target, a.itemId)} of ${engagementOf(a.reportId)} as its ${SLOT_WORDS[a.slot]}${a.mark ? ' and marked the line' : ''}`,
          })
        // The proofs the owner chose by hand: theirs, kept while the file stays as it is.
        for (const c of chosen) {
          const documentId = docIds.get(c.fileId)!
          await this.upsertLink(tx, c, c.itemId, documentId)
          line({
            resource: c.target === 'expense' ? 'expense' : 'report',
            subjectId: c.itemId,
            action: 'update',
            description: `Linked ${describe(fileOf(c.fileId))} to ${subject(c.target, c.itemId)} of ${engagementOf(c.reportId)} as its ${SLOT_WORDS[c.slot]} by hand${c.mark ? ' and marked the line' : ''}`,
          })
        }
        // The month's payroll on each engagement's budget: lines from payroll details, each linked to the proofs the
        // match found for that person and run. An earlier save's line is changed in place; one no longer charged goes.
        const pl = planned.payrollLines
        for (const e of pl.remove) {
          await tx.expense.delete({ where: { id: e.id } })
          line({
            resource: 'expense',
            subjectId: e.id,
            action: 'delete',
            description: `Removed a payroll line from ${monthName(run.period)} of ${engagementOf(e.monthlyReportId)}: payroll details no longer charges it`,
          })
        }
        for (const e of pl.keep) {
          await tx.expense.update({ where: { id: e.id }, data: { payrollKind: e.kind } })
          line({
            resource: 'expense',
            subjectId: e.id,
            action: 'update',
            description: `Kept expense ${e.itemNumber} in ${monthName(run.period)} of ${engagementOf(e.reportId)} for payroll reconciliation only: the payroll match counts the same pay (${PAYROLL_BUDGET_KIND_LABELS[e.kind]})`,
            changes: [
              {
                field: 'Payroll transaction',
                before: 'No',
                after: PAYROLL_BUDGET_KIND_LABELS[e.kind],
              },
            ],
          })
        }
        const written: { id: string; write: PayrollLineWrite }[] = []
        for (const w of pl.create) {
          const data = this.payrollLineData(w)
          const e = await tx.expense.create({
            data: {
              ...data,
              engagementId: w.engagementId,
              monthlyReportId: w.reportId,
              payrollKey: w.key,
              createdById: caller.userId,
            },
          })
          written.push({ id: e.id, write: w })
          line({
            resource: 'expense',
            subjectId: e.id,
            action: 'create',
            description: `Added ${whoseWords(w)} for the run paid ${w.date} to ${monthName(run.period)} of ${engagementOf(w.reportId)} from payroll details`,
            changes: changesOf(null, data, PAYROLL_LINE_FIELDS),
          })
        }
        for (const c of pl.change) {
          const data = this.payrollLineData(c.write)
          const before = await tx.expense.findFirst({ where: { id: c.id } })
          if (!before) throw new ConflictException(UPLOAD_CHANGED)
          await tx.expense.update({ where: { id: c.id }, data })
          await tx.expenseDocument.deleteMany({ where: { expenseId: c.id, byMatch: true } })
          written.push({ id: c.id, write: c.write })
          const changes = changesOf(before, data, PAYROLL_LINE_FIELDS)
          if (changes.length)
            line({
              resource: 'expense',
              subjectId: c.id,
              action: 'update',
              description: `Changed ${whoseWords(c.write)} for the run paid ${c.write.date} in ${monthName(run.period)} of ${engagementOf(c.write.reportId)} from payroll details`,
              changes,
            })
        }
        const proofLinks = written.flatMap(({ id, write }) =>
          this.payrollLineProofs(write, plan, planned.files, docIds).map((l) => ({
            ...l,
            expenseId: id,
          }))
        )
        if (proofLinks.length)
          await tx.expenseDocument.createMany({ data: proofLinks, skipDuplicates: true })

        await this.log.alsoMany(tx, caller, lines)
        return { workspaceId: run.workspaceId }
      },
      () => ({
        workspaceId: run.workspaceId,
        resource: 'workspace',
        subjectId: run.workspaceId,
        action: 'update',
        description: `Saved the workspace payroll files for ${monthName(run.period)} (${MODE_WORDS[mode].save}): ${[
          `${howMany(change.joining.length, 'file')} filed`,
          change.leaving.length && `${howMany(change.leaving.length, 'file')} removed`,
          `${howMany(change.total, 'file')} in all`,
          `${howMany(kept, 'pay')} found`,
          staffFound.length &&
            `${howMany(staffFound.length, 'person', 'people')} on the staff list found`,
          planned.stubWrites.length &&
            `${howMany(planned.stubWrites.length, 'work-experience payment')} made or changed from pay stubs`,
          removedPayments.length &&
            `${howMany(removedPayments.length, 'work-experience payment')} removed with their pay stubs`,
          flagged && `${howMany(flagged, 'pay stub')} flagged`,
          `${howMany(planned.creates.length + planned.fresh.length + planned.updates.length + chosen.length, 'proof')} linked or changed`,
          planned.deletes.length + planned.leavingLinks.length &&
            `${howMany(planned.deletes.length + planned.leavingLinks.length, 'proof')} unlinked`,
          `across ${howMany(engagements.size, 'engagement')}`,
          planned.dropped.length &&
            `${howMany(planned.dropped.length, 'decision')} dropped with their files`,
        ]
          .filter(Boolean)
          .join(', ')}`,
      }),
      { timeout: 120_000 }
    )
    // Only now, with the rows gone for good: the stored objects of the files that left the set.
    for (const d of leavingDocs)
      await this.storage
        .delete(d.storageKey)
        .catch((e: unknown) =>
          this.logger.error(
            `Could not delete the object of a removed payroll file ${d.id}: ${(e as Error).message}`
          )
        )
    await this.stats.recordWith('payroll', () => this.match.statOf(caller, run, 'saved'))
    for (const id of touched) await this.checks.refresh(id)
    return this.reconciliationOf(caller, run.workspaceId, run.period)
  }

  /**
   * The payroll lines Save puts on each month (payroll-lines.ts): what payroll details charges, against the lines already
   * written by an earlier save (their keys), so each is added, changed or removed, never doubled. A line already
   * written exactly as Save would write it, its proofs included, is left alone: a closed or submitted month refuses any
   * write, so only a line that differs touches its month.
   */
  private async payrollLinesPlan(
    files: MatchFile[],
    plan: Plan,
    staff: StaffRow[],
    participants: ParticipantRow[],
    months: WorkspacePayrollMonthDto[],
    /** The months that have participants' payments once Save is done (kept or made from stubs). */
    paidMonths: Set<string>
  ) {
    const charges = files
      .filter((f) => f.kind === 'payroll-details')
      .flatMap((f) => chargesOf(f.lines))
    const reportIds = months.map((m) => m.reportId)
    const [lines, onMonths] = await Promise.all([
      // No payroll details in the set: no payroll line is written, so no budget line is needed.
      charges.length
        ? this.prisma.budgetLine.findMany({
            where: { engagementId: { in: months.map((m) => m.engagementId) } },
            select: { id: true, engagementId: true, payroll: true },
          })
        : Promise.resolve([] as { id: string; engagementId: string; payroll: string[] }[]),
      this.prisma.expense.findMany({
        where: { monthlyReportId: { in: reportIds } },
        select: {
          id: true,
          monthlyReportId: true,
          payrollKey: true,
          date: true,
          allocatedAmount: true,
          budgetLineId: true,
          reportLine: true,
          payrollKind: true,
          itemNumber: true,
          account: true,
          memo: true,
          vendor: true,
          totalCost: true,
          allocationType: true,
          documents: {
            where: { byMatch: true },
            select: { documentId: true, purpose: true, mark: true, marks: true, payRun: true },
          },
        },
      }),
    ])
    const staffPayLine = new Set(
      lines.filter((l) => l.payroll.includes('staff-pay')).map((l) => l.id)
    )
    const lineMonths: LineMonth[] = months.map((m) => ({
      reportId: m.reportId,
      engagementId: m.engagementId,
      engagementName: m.engagementName,
      lines: lines.filter((l) => l.engagementId === m.engagementId),
      enteredStaffDates: onMonths
        .filter(
          (e) =>
            e.monthlyReportId === m.reportId &&
            !e.payrollKey &&
            // A books' payroll transaction steps aside once the match covers the run: it never blocks the match.
            !e.payrollKind &&
            ((e.budgetLineId && staffPayLine.has(e.budgetLineId)) || isStaffLine(e.reportLine))
        )
        .map((e) => e.date.toISOString().slice(0, 10)),
    }))
    const { writes, skipped } = charges.length
      ? payrollLinesOf({ charges, staff, participants, months: lineMonths })
      : { writes: [], skipped: [] }
    const had = onMonths.filter((e) => e.payrollKey)
    const keyOfRow = (reportId: string, key: string) => `${reportId}|${key}`
    const wanted = new Set(writes.map((w) => keyOfRow(w.reportId, w.key)))
    const existing = new Map(had.map((e) => [keyOfRow(e.monthlyReportId, e.payrollKey!), e]))
    const create = writes.filter((w) => !existing.has(keyOfRow(w.reportId, w.key)))
    // The proofs Save would link, by the documents they are now; a file joining the set is no document yet, so a proof
    // on it never matches one already linked.
    const docIds = new Map(files.map((f) => [f.id, f.documentId ?? `joining:${f.id}`]))
    const proofsOf = (
      ls: { documentId: string; purpose: string; mark?: unknown; marks: unknown; payRun: boolean }[]
    ) =>
      ls
        .map((l) => canonical([l.documentId, l.purpose, l.mark ?? null, l.marks, l.payRun]))
        .sort()
        .join('\n')
    const unchanged = (e: (typeof had)[number], w: PayrollLineWrite) => {
      const d = this.payrollLineData(w)
      return (
        e.itemNumber === d.itemNumber &&
        e.date.getTime() === d.date.getTime() &&
        e.vendor === d.vendor &&
        e.memo === d.memo &&
        e.account === d.account &&
        Number(e.totalCost).toFixed(2) === d.totalCost &&
        Number(e.allocatedAmount).toFixed(2) === d.allocatedAmount &&
        e.allocationType === d.allocationType &&
        e.budgetLineId === d.budgetLineId &&
        proofsOf(e.documents) === proofsOf(this.payrollLineProofs(w, plan, files, docIds))
      )
    }
    const change = writes.flatMap((w) => {
      const e = existing.get(keyOfRow(w.reportId, w.key))
      return e && !unchanged(e, w) ? [{ write: w, id: e.id }] : []
    })
    // Lines an earlier save wrote that payroll details no longer charges. Only when this set has payroll details:
    // a set without them changes no payroll line.
    const remove = charges.length
      ? had.filter((e) => !wanted.has(keyOfRow(e.monthlyReportId, e.payrollKey!)))
      : []
    // What the match covers on each month once Save is done: the staff and participants' taxes lines it keeps or
    // writes, and the participants' payments. A payroll line entered on that month of a covered kind is the same pay
    // counted twice: Save keeps it for reconciliation only (owner's decision, 2026-10-20).
    const cover = new Map<string, PayrollCover>(
      months.map((m) => [
        m.reportId,
        {
          staffPay: false,
          staffTaxes: false,
          participantPay:
            paidMonths.has(m.reportId) &&
            holdsPayroll(
              lines.filter((l) => l.engagementId === m.engagementId),
              'participant-pay'
            ),
          participantTaxes: false,
        },
      ])
    )
    const removed = new Set(remove.map((e) => e.id))
    for (const k of [
      ...had
        .filter((e) => !removed.has(e.id))
        .map((e) => ({ reportId: e.monthlyReportId, key: e.payrollKey! })),
      ...writes.map((w) => ({ reportId: w.reportId, key: w.key })),
    ]) {
      const c = cover.get(k.reportId)
      if (!c) continue
      if (k.key.startsWith('participants:')) c.participantTaxes = true
      else if (k.key.endsWith(':taxes')) c.staffTaxes = true
      else c.staffPay = true
    }
    const keep = onMonths
      .filter((e) => countedTwice(e, cover.get(e.monthlyReportId)))
      .map((e) => ({
        id: e.id,
        reportId: e.monthlyReportId,
        itemNumber: e.itemNumber,
        date: e.date.toISOString().slice(0, 10),
        amount: Number(e.allocatedAmount),
        kind: PAYROLL_KIND_OF_COVER[payrollRowKind(e)] as PayrollBudgetKind,
      }))
    // The books' payroll transactions of a kind Save covers on their month: not items to prove, kept for the
    // reconciliation alone (owner's decision, 2026-10-20). Already marked, so Save writes nothing to them.
    const books = onMonths
      .filter((e) => e.payrollKind && !countsOnBudget(e, cover.get(e.monthlyReportId)))
      .map((e) => ({
        id: e.id,
        reportId: e.monthlyReportId,
        itemNumber: e.itemNumber,
        date: e.date.toISOString().slice(0, 10),
        amount: Number(e.allocatedAmount),
        kind: e.payrollKind as PayrollBudgetKind,
      }))
    return {
      create,
      change,
      remove,
      skipped,
      keep,
      books,
      /** Every line payroll details asks for, written or already as written: the files that prove them reach their months. */
      writes,
      touched: [
        ...keep.map((e) => e.reportId),
        ...create.map((w) => w.reportId),
        ...change.map((c) => c.write.reportId),
        ...remove.map((e) => e.monthlyReportId),
      ],
    }
  }

  /**
   * The books against the payroll files for each engagement month of the period: the books' payroll transactions by
   * run date and kind, against the lines the match wrote for that run and the participants' payments of it (a payment is
   * of the run dated within WEX_RUN_DAYS after its pay period ends).
   */
  private async booksAgainstFiles(months: WorkspacePayrollMonthDto[]): Promise<BooksRunDto[]> {
    if (!months.length) return []
    const ids = months.map((m) => m.reportId)
    const [lines, payments] = await Promise.all([
      this.prisma.expense.findMany({
        where: {
          monthlyReportId: { in: ids },
          OR: [{ payrollKind: { not: null } }, { payrollKey: { not: null } }],
        },
        select: {
          monthlyReportId: true,
          date: true,
          allocatedAmount: true,
          payrollKind: true,
          payrollKey: true,
        },
      }),
      this.prisma.wexPayment.findMany({
        where: { monthlyReportId: { in: ids } },
        select: { monthlyReportId: true, payPeriodEnd: true, grossAmount: true },
      }),
    ])
    const day = (d: Date) => d.toISOString().slice(0, 10)
    const out = new Map<string, BooksRunDto>()
    const at = (reportId: string, date: string, kind: PayrollBudgetKind) => {
      const k = `${reportId}|${date}|${kind}`
      let row = out.get(k)
      if (!row) {
        const m = months.find((x) => x.reportId === reportId)!
        row = {
          engagementId: m.engagementId,
          engagementName: m.engagementName,
          reportId,
          date,
          kind,
          books: null,
          files: null,
        }
        out.set(k, row)
      }
      return row
    }
    const add = (n: number | null, v: number) => Math.round(((n ?? 0) + v) * 100) / 100
    for (const l of lines) {
      const amount = Number(l.allocatedAmount)
      if (l.payrollKind) {
        const row = at(l.monthlyReportId, day(l.date), l.payrollKind as PayrollBudgetKind)
        row.books = add(row.books, amount)
      } else if (l.payrollKey) {
        const kind: PayrollBudgetKind = l.payrollKey.startsWith('participants:')
          ? 'participant-taxes'
          : l.payrollKey.endsWith(':taxes')
            ? 'staff-taxes'
            : 'staff-pay'
        const row = at(l.monthlyReportId, day(l.date), kind)
        row.files = add(row.files, amount)
      }
    }
    // The participants' pay: each payment on the run it falls in, by the pay date of the books' participant pay, else
    // of any other payroll of that run (its taxes), else its own pay period's end. A payment has no pay date of its own.
    const runs = [...out.values()]
    for (const p of payments) {
      const end = day(p.payPeriodEnd)
      const inRun = (x: BooksRunDto) =>
        x.reportId === p.monthlyReportId && x.date >= end && x.date <= addDays(end, WEX_RUN_DAYS)
      const first = (xs: BooksRunDto[]) => xs.sort((a, b) => a.date.localeCompare(b.date))[0]
      const date =
        first(runs.filter((x) => inRun(x) && x.kind === 'participant-pay'))?.date ??
        first(runs.filter(inRun))?.date ??
        end
      const row = at(p.monthlyReportId, date, 'participant-pay')
      row.files = add(row.files, Number(p.grossAmount))
    }
    return [...out.values()].sort(
      (a, b) =>
        a.engagementName.localeCompare(b.engagementName) ||
        a.date.localeCompare(b.date) ||
        a.kind.localeCompare(b.kind)
    )
  }

  /** A payroll line as Save writes it: the run's pay date, whose pay, the account and the amount on its budget line. */
  private payrollLineData(w: PayrollLineWrite) {
    const period = w.start ? `${w.start} to ${w.end}` : `ending ${w.end}`
    return {
      itemNumber: payrollItemNumber(w),
      date: new Date(`${w.date}T00:00:00Z`),
      vendor: w.who,
      memo: `${w.kind.endsWith('taxes') ? 'Employer payroll taxes and benefits' : 'Pay'}, pay period ${period}, from payroll details`,
      account: w.account || null,
      totalCost: w.amount.toFixed(2),
      allocatedAmount: w.amount.toFixed(2),
      allocationType: 'direct',
      // Set from the budget line by the database (Expense_4_budget_line); named here for the insert.
      reportLine: 'program-costs',
      budgetLineId: w.budgetLineId,
    }
  }

  /**
   * The proofs a payroll line gets: what the match found for the person in that run (time report row, register row
   * and payroll details rows, the run's bank debit), or, for the participants' taxes, each stub's of the run.
   */
  private payrollLineProofs(
    w: PayrollLineWrite,
    plan: Plan,
    files: MatchFile[],
    docIds: Map<string, string | null>
  ): {
    documentId: string
    purpose: string
    mark?: object
    marks: object[]
    byMatch: true
    payRun: boolean
  }[] {
    // A run is its register: its pay date is the one the register prints.
    const payDateOf = new Map(
      files.filter((f) => f.kind === 'payroll-register').map((f) => [f.id, payDateOn(f.lines)])
    )
    const ofRun = (p: PersonLine | null | undefined): p is PersonLine =>
      !!p &&
      (p.runId
        ? payDateOf.get(p.runId) === w.date
        : p.source === 'details'
          ? !!p.line?.text.includes(w.date)
          : true)
    const spots: { purpose: string; spot: PersonLine }[] = []
    if (w.staffId) {
      const found = plan.staff.find((s) => s.staff.id === w.staffId)
      for (const [slot, purpose] of [
        ['timesheet', 'timesheet'],
        ['register', 'register'],
        ['bank', 'payment'],
      ] as const)
        for (const p of found?.[slot] ?? []) if (ofRun(p)) spots.push({ purpose, spot: p })
    } else
      for (const st of plan.stubs.filter((x) => x.reading.payDate === w.date))
        for (const [p, purpose] of [
          [st.timesheet, 'timesheet'],
          [st.register, 'register'],
          [st.debit, 'payment'],
        ] as const)
          if (p) spots.push({ purpose, spot: p })
    // One link per file (a file is one proof of a line), with every line of it found highlighted.
    const byDoc = new Map<
      string,
      {
        documentId: string
        purpose: string
        mark?: object
        marks: object[]
        byMatch: true
        payRun: boolean
      }
    >()
    for (const { purpose, spot } of spots) {
      const documentId = docIds.get(spot.fileId)
      if (!documentId) continue
      const mark = spot.line ? (cleanMark(spot.line) as object) : undefined
      const had = byDoc.get(documentId)
      if (had) {
        if (mark && had.marks.length < 20) had.marks.push(mark)
        continue
      }
      byDoc.set(documentId, {
        documentId,
        purpose,
        ...(mark ? { mark } : {}),
        marks: mark ? [mark] : [],
        byMatch: true,
        payRun: spot.run === true,
      })
    }
    return [...byDoc.values()]
  }

  /** One proof link a person chose, to a document already on file or just filed: theirs (`byMatch` false). */
  private async upsertLink(
    tx: Prisma.TransactionClient,
    c: {
      target: 'expense' | 'wex'
      purpose: string
      mark: StatementMark | null
      marks: StatementMark[]
      /** Matched as the debit of the pay run that paid the item; a line linked from the reconciliation is not. */
      payRun?: boolean
    },
    itemId: string,
    documentId: string
  ) {
    const purpose = c.purpose
    const mark = (c.mark ?? undefined) as object | undefined
    const marks = c.marks as object[]
    const payRun = c.payRun === true
    if (c.target === 'expense')
      await tx.expenseDocument.upsert({
        where: { expenseId_documentId: { expenseId: itemId, documentId } },
        update: { purpose, mark: mark ?? undefined, marks, byMatch: false, payRun },
        create: { expenseId: itemId, documentId, purpose, mark, marks, payRun },
      })
    else
      await tx.wexPaymentDocument.upsert({
        where: { wexPaymentId_documentId: { wexPaymentId: itemId, documentId } },
        update: { purpose, mark: mark ?? undefined, marks, byMatch: false, payRun },
        create: { wexPaymentId: itemId, documentId, purpose, mark, marks, payRun },
      })
  }

  /** Discard: the run, its rows and its staged objects go. */
  async discard(caller: Caller, runId: string): Promise<void> {
    const run = await this.load(caller, runId)
    if (run.createdById !== caller.userId) throw new NotFoundException()
    this.owner(caller, run.workspaceId!)
    await this.match.remove(caller, run, 'Discarded', 'discarded')
  }

  /**
   * The run as the page shows it: its files, every open proof's match across the engagements, the person-pays, and the
   * plan (what Save will change). Matched from the set as the run leaves it: a file that leaves is not matched.
   */
  private async dto(caller: Caller, run: WorkspaceRun): Promise<WorkspacePayrollRunDto> {
    const workspaceId = run.workspaceId
    const period = run.period
    const found = await workspaceItems(this.prisma, caller, workspaceId, period)
    const months = found.months
    const planned = await this.planOf(run, found.items, months)
    const { plan, highlight, items } = planned
    const files = planned.files
    const matchingIds = new Set(planned.change.matching.map((f) => f.id))
    const slots = items.flatMap((i) =>
      slotsOf(i.proof)
        .filter((slot) => !proved(i.links, slot))
        .map((slot) => matchSlot(i.proof, slot, files, highlight[PAYROLL_SLOT_KIND[slot]]))
    )
    const itemOf = (target: 'expense' | 'wex', id: string | null) =>
      id ? items.find((i) => i.target === target && i.id === id) : undefined
    const several = severalPeopleLines(files, planned.staff, planned.participants)
    const away = awayLines(files, period)
    const pays: PayLineDto[] = []
    const totalsOnly: string[] = []
    for (const f of run.files) {
      if (!isPayKind(f.kind) || !matchingIds.has(f.id)) continue
      const kind = f.kind
      const stub = kind === 'paystub' ? plan.stubs.find((x) => x.fileId === f.id) : undefined
      const fileLines = payLinesOf(proofFile(f))
      if (companyTotals(kind, fileLines, planned.staff, planned.participants)) {
        totalsOnly.push(f.id)
        continue
      }
      const unclear = payUnclearLines(proofFileOf(f))
      fileLines.forEach((line, n) => {
        const person = kind === 'paystub' ? null : staffOn(plan, f.id, line)
        const guess = kind === 'bank-statement' && !person ? staffGuessOn(plan, f.id, line) : null
        const flags: PayLineFlag[] = [...(stub?.flags ?? [])]
        if (line && unclear.has(line)) flags.push('pay-unclear')
        if (line && several.has(line)) flags.push('several-people')
        if (kind !== 'paystub' && (away.files.has(f.id) || (line && away.isDebit(f.id, line))))
          flags.push('other-month')
        if (person && !person.staff.engagementIds.length) flags.push('staff-untagged')
        const base = {
          id: `${f.id}:${n}`,
          documentId: null,
          fileId: f.id,
          fileName: f.fileName,
          kind,
          mark: line,
          notFunded: null,
          flags,
          staff: person
            ? { id: person.staff.id, name: person.staff.name }
            : guess
              ? { id: guess.staff.id, name: guess.staff.name }
              : null,
        }
        // By the lists: a person's line linked to an engagement they are on, or a stub's payment (made or changed). A
        // link two people share marks the first one's line and highlights both, so its highlights count too.
        const link = plan.links.find(
          (l) =>
            l.fileId === f.id &&
            (kind === 'paystub' ? l.slot === 'stub' : !!line && linkCovers(l, kind, line))
        )
        if (link) {
          const item = itemOf(link.target, link.itemId)
          return pays.push({ ...base, state: 'matched', item: item ? itemRef(item) : null })
        }
        // A file on file already: an item's saved proof may cover the line.
        // A file on file already, or the same file (by its contents) on an item: its saved proof may cover the line.
        const onFile = items.find((i) =>
          i.links.some(
            (l) =>
              (l.documentId === f.documentId || (l.sha256 === f.sha256 && l.kind === f.kind)) &&
              (kind !== 'paystub' || l.purpose === 'payment') &&
              linkCovers(l, kind, line)
          )
        )
        if (onFile) return pays.push({ ...base, state: 'matched', item: itemRef(onFile) })
        // A bank line of a person's pay by its amount alone: a guess for their engagement's staff line, to confirm.
        const guessed = guess ? staffItemOf(items, guess.staff) : undefined
        if (guessed) return pays.push({ ...base, state: 'guessed', item: itemRef(guessed) })
        // Auto-Match's pick for an open proof that lands on this line: sure, or a guess to check.
        for (const m of slots) {
          if (m.slot !== PAY_SLOT[kind] || m.pick !== f.id) continue
          const c = m.candidates.find((x) => x.fileId === f.id)
          if (!c || (kind !== 'paystub' && !(c.mark && line && sameLine(c.mark, line)))) continue
          const item = items.find((i) => i.target === m.target && i.id === m.id)!
          return pays.push({ ...base, state: c.sure ? 'matched' : 'guessed', item: itemRef(item) })
        }
        if (
          kind !== 'paystub' &&
          !person &&
          !guess &&
          !flags.includes('other-month') &&
          !namesSomeone(line, planned.staff, planned.participants)
        )
          flags.push('not-on-a-list')
        pays.push({ ...base, state: 'unassigned', item: null })
      })
    }
    return {
      id: run.id,
      workspaceId,
      period,
      mode: modeOf(run),
      expectedFiles: run.expectedFiles,
      replace: modeOf(run) === 'replace',
      expiresAt: new Date(run.createdAt.getTime() + RUN_MS).toISOString(),
      files: run.files.map((f): PayrollMatchFileDto => ({
        id: f.id,
        kind: f.kind as PayrollDocumentKind,
        fileName: f.fileName,
        pages: f.pages,
        scanned: f.scanned,
        status: f.status as PayrollMatchFileDto['status'],
        error: f.error,
        staged: !f.documentId,
        personal: f.sensitivity === 'personal',
        overLineCap: overPayLineCap(f),
      })),
      slots,
      items: items.map((i) => i.dto),
      months,
      pays,
      totalsOnly,
      plan: this.planDto(planned, months),
      runs: suggestedRuns(payRunsOf(planned.files)),
      ai: PayrollAiService.summary(run.files),
    }
  }

  /**
   * The owner reads some files of their match with AI, when they ticked it (owner's decision, 2026-10-19): each file
   * with the names on the staff list and the participant lists; what AI found, checked against the file, is kept with
   * its contents. The run as it now matches.
   */
  async aiRead(caller: Caller, runId: string, input: unknown): Promise<WorkspacePayrollRunDto> {
    const run = await this.open(caller, runId)
    const ids = (input as { fileIds?: unknown } | null)?.fileIds
    const want = new Set(
      Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : []
    )
    const files = run.files.filter((f) => want.has(f.id) && f.status === 'read')
    const { staff, participants } = await this.lists(run.workspaceId)
    const names = [
      ...new Set([...staff.map((s) => s.name), ...participants.map((p) => p.displayName)]),
    ]
    await this.ai.read(
      caller,
      run.workspaceId,
      files.map((f) => ({ ...f, bytes: () => this.storage.read(f.storageKey) })),
      names,
      'Month End Payroll Processing'
    )
    return this.dto(caller, await this.open(caller, runId))
  }

  /** Whether the engagement is one of the workspace's (and the caller's to see). */
  async isEngagementOf(caller: Caller, workspaceId: string, engagementId: string) {
    if (!engagementId || !caller.workspaceIds.includes(workspaceId)) return false
    const e = await this.prisma.engagement.findFirst({
      where: { id: engagementId, workspaceId },
      select: { id: true },
    })
    return !!e
  }

  /**
   * Someone the files name, added from the match screen (Resolve: to the staff list, or to an engagement's participants;
   * owner's decision, 2026-10-19): `add` writes it, with its own log line, in the run's workspace; the run is answered
   * as it now matches, worked out again from the files already read. No read line: the screen was already open.
   */
  async afterAdding(
    caller: Caller,
    runId: string,
    add: (workspaceId: string) => Promise<void>
  ): Promise<WorkspacePayrollRunDto> {
    const run = await this.open(caller, runId)
    await add(run.workspaceId)
    return this.dto(caller, await this.open(caller, runId))
  }

  // ── The reconciliation ───────────────────────────────────────────────────

  /**
   * Every person-pay kept from the month's workspace payroll files and where it landed, and the reverse: each
   * engagement's payroll item still missing a proof. Owners and auditors; one read line when it is opened, naming
   * counts only (never a name or an amount).
   */
  async reconciliation(
    caller: Caller,
    workspaceId: string,
    period: unknown
  ): Promise<PayrollReconciliationDto> {
    this.reader(caller, workspaceId)
    const p = this.period(period)
    const out = await this.reconciliationOf(caller, workspaceId, p)
    await this.log.log(caller, {
      workspaceId,
      resource: 'workspace',
      subjectId: workspaceId,
      action: 'read',
      description: `Opened the payroll reconciliation for ${monthName(p)}: ${howMany(out.pays.length, 'pay')}, ${howMany(out.counts.unassigned, 'unassigned')}, ${howMany(out.unproved.length, 'payroll item')} missing proof${out.dropped.length ? `, ${howMany(out.dropped.length, 'decision')} dropped` : ''}`,
    })
    return out
  }

  private async reconciliationOf(
    caller: Caller,
    workspaceId: string,
    period: string
  ): Promise<PayrollReconciliationDto> {
    const [saved, { items, months }, staff, proofs, participants, dropped] = await Promise.all([
      this.prisma.payrollPayLine.findMany({
        where: { workspaceId, period },
        include: { document: { select: { fileName: true, sha256: true } } },
      }),
      workspaceItems(this.prisma, caller, workspaceId, period),
      this.prisma.staffMember.findMany({
        where: { workspaceId },
        orderBy: { name: 'asc' },
        include: { assignments: { select: { engagementId: true } } },
      }),
      this.prisma.staffPayProof.findMany({ where: { workspaceId, period } }),
      this.prisma.participant.findMany({
        where: { workspaceId },
        select: { id: true, engagementId: true, displayName: true, participantId: true },
      }),
      this.prisma.payrollDroppedDecision.findMany({
        where: { workspaceId, period },
        orderBy: { droppedAt: 'desc' },
        take: 500,
      }),
    ])
    const staffRows: StaffRow[] = staff.map((s) => ({
      id: s.id,
      name: s.name,
      engagementIds: s.assignments.map((a) => a.engagementId),
    }))
    // A company-totals register's lines saved before this rule are not pays either.
    const kept = new Map<string, typeof saved>()
    for (const l of saved) kept.set(l.documentId, [...(kept.get(l.documentId) ?? []), l])
    const lines = [...kept.values()].flatMap((ls) =>
      companyTotals(
        ls[0]!.kind,
        ls.map((l) => l.mark as StatementLine | null),
        staffRows,
        participants as ParticipantRow[]
      )
        ? []
        : ls
    )
    // The lines more than one person fits, worked out per file from the lines kept of it.
    const byDoc = new Map<string, typeof lines>()
    for (const l of lines) byDoc.set(l.documentId, [...(byDoc.get(l.documentId) ?? []), l])
    const several = new Set<string>()
    for (const [documentId, ls] of byDoc) {
      const kind = ls[0]!.kind as PayrollDocumentKind
      if (kind === 'paystub') continue
      const marks = ls
        .map((l) => l.mark as StatementLine | null)
        .filter((m): m is StatementLine => !!m)
      const hit = severalPeopleLines(
        [{ id: documentId, documentId, kind, fileName: '', lines: marks }],
        staffRows,
        participants as ParticipantRow[]
      )
      for (const l of ls)
        if (l.mark && hit.has(l.mark as unknown as StatementLine)) several.add(l.id)
    }
    const all = lines
      .map((line): PayLineDto => {
        const kind = line.kind as PayLineKind
        const mark = (line.mark ?? null) as StatementLine | null
        // The person on the staff list this line is of, as the last match found them.
        const proof =
          kind === 'paystub' || !mark
            ? undefined
            : proofs.find(
                (p) =>
                  p.documentId === line.documentId &&
                  !!p.mark &&
                  sameLine(p.mark as unknown as StatementMark, mark)
              )
        // A pay run's debit is everyone's in the run: a line found for several people is no one person's.
        const shared =
          !!proof &&
          proofs.some(
            (p) =>
              p.staffMemberId !== proof.staffMemberId &&
              p.documentId === line.documentId &&
              !!p.mark &&
              sameLine(p.mark as unknown as StatementMark, mark!)
          )
        const person =
          proof && !shared ? staffRows.find((s) => s.id === proof.staffMemberId) : undefined
        // Only the flags there are today: a line kept before a flag was retired keeps it, unshown.
        const flags: PayLineFlag[] = ((line.flags ?? []) as string[]).filter(
          (f): f is PayLineFlag => (PAY_LINE_FLAGS as readonly string[]).includes(f)
        )
        if (several.has(line.id)) flags.push('several-people')
        if (person && !person.engagementIds.length) flags.push('staff-untagged')
        const base = {
          id: line.id,
          documentId: line.documentId,
          fileId: null,
          fileName: line.document.fileName,
          kind,
          mark,
          notFunded:
            line.notFundedReason && line.notFundedAt
              ? {
                  reason: line.notFundedReason,
                  by: line.notFundedByEmail ?? '',
                  at: line.notFundedAt.toISOString(),
                }
              : null,
          flags,
          staff: person ? { id: person.id, name: person.name } : null,
        }
        const on =
          coveredBy(items, line.documentId, kind, mark, line.document.sha256) ??
          (person && !proof?.guessed ? staffItemFor(items, person, line.documentId) : undefined)
        if (on) return { ...base, state: 'matched', item: itemRef(on) }
        if (base.notFunded) return { ...base, state: 'not-funded', item: null }
        // A bank line of a person's pay by its amount alone: guessed for their engagement's staff line, to confirm.
        const staffGuess = person && proof?.guessed ? staffItemOf(items, person) : undefined
        if (staffGuess) return { ...base, state: 'guessed', item: itemRef(staffGuess) }
        // Another month's pay is that month's to place: not also "on no list".
        if (
          kind !== 'paystub' &&
          !person &&
          !flags.includes('other-month') &&
          !namesSomeone(mark, staffRows, participants)
        )
          flags.push('not-on-a-list')
        const guess = guessFor(items, kind, mark)
        return guess
          ? { ...base, state: 'guessed', item: itemRef(guess) }
          : { ...base, state: 'unassigned', item: null }
      })
      .sort(
        (a, b) =>
          a.fileName.localeCompare(b.fileName) ||
          (a.documentId ?? '').localeCompare(b.documentId ?? '') ||
          (a.mark?.page ?? 0) - (b.mark?.page ?? 0) ||
          (b.mark?.y ?? 0) - (a.mark?.y ?? 0)
      )
    // The rest of the bank statement (balances, vendor and card payments): it covers the whole account, and a line that
    // names no one and is no pay run's debit is not a pay. Counted, not listed (January test, 2026-10-19).
    const otherBank = (x: PayLineDto) =>
      x.kind === 'bank-statement' &&
      x.state === 'unassigned' &&
      !x.notFunded &&
      x.flags.includes('not-on-a-list')
    const pays = all.filter((x) => !otherBank(x))
    const unproved = items
      .map((i) => ({ item: i.dto, missing: slotsOf(i.proof).filter((s) => !proved(i.links, s)) }))
      .filter((u) => u.missing.length > 0)
    const count = (s: PayLineState) => pays.filter((x) => x.state === s).length
    return {
      workspaceId,
      period,
      pays,
      otherBankLines: all.length - pays.length,
      unproved,
      items: items.map((i) => ({ item: i.dto, needed: slotsOf(i.proof) })),
      books: await this.booksAgainstFiles(months),
      counts: {
        matched: count('matched'),
        guessed: count('guessed'),
        unassigned: count('unassigned'),
        'not-funded': count('not-funded'),
        unproved: unproved.length,
        flagged: pays.filter((x) => x.flags.length).length,
      },
      staffOnNoEngagement: staff
        .filter((s) => !s.assignments.length)
        .map((s) => ({
          id: s.id,
          name: s.name,
          inFiles: proofs.some((p) => p.staffMemberId === s.id),
          // Their pay on the register rows found (gross), as the engagement cards add it up.
          paid: (() => {
            const regs = proofs.filter(
              (p) => p.staffMemberId === s.id && p.kind === 'payroll-register' && p.amount != null
            )
            return regs.length
              ? Math.round(regs.reduce((t, p) => t + Number(p.amount), 0) * 100) / 100
              : null
          })(),
          // Payroll details lists only the pay charged to the program: a charge there is grant pay.
          charged: (() => {
            const own = proofs.filter(
              (p) => p.staffMemberId === s.id && p.kind === 'payroll-details' && p.amount != null
            )
            return own.length
              ? Math.round(own.reduce((t, p) => t + Number(p.amount), 0) * 100) / 100
              : null
          })(),
        })),
      twoProofs: twoProofsOn(
        items,
        staffRows.map((x) => printedName(x.name))
      ),
      // A file whose pay lines reached the cap: Save kept the first MAX_PAY_LINES, and lines after them were not read.
      filesOverLineCap: [...byDoc.values()]
        .filter((ls) => ls.length >= MAX_PAY_LINES)
        .map((ls) => ({ documentId: ls[0]!.documentId, fileName: ls[0]!.document.fileName })),
      dropped: dropped.map((d) => ({
        id: d.id,
        fileName: d.fileName,
        kind: d.kind as PayrollDocumentKind,
        decision: d.decision as DroppedDecisionDto['decision'],
        why: d.why as DroppedDecisionWhy,
        itemTitle: d.itemTitle,
        engagementName: d.engagementName,
        by: d.droppedByEmail,
        at: d.droppedAt.toISOString(),
      })),
      can: { change: workspaceRole(caller, workspaceId, ['owner']) },
    }
  }

  // ── The engagement cards ─────────────────────────────────────────────────

  /**
   * One card per engagement with a month for the period (owners and auditors; anyone else 404): its staff payroll
   * charge this month, its staff budget (approved, charged before, left after this month), the people tagged to it with
   * the pay and proofs the saved files hold for each, and the check: covered when the charge is not more than the pay
   * of everyone tagged to it (each person's full pay counts, so it is an upper bound; pay is never split). Above the
   * cards, the same check across each group of engagements that share staff (`sharedStaffOvercharged`), where a shared
   * person's pay is counted once. One read line, counts only.
   */
  async engagements(
    caller: Caller,
    workspaceId: string,
    period: unknown
  ): Promise<WorkspacePayrollOutputDto> {
    this.reader(caller, workspaceId)
    const p = this.period(period)
    const staffLines = [...STAFF_REPORT_LINES]
    const wexLines = [...WEX_REPORT_LINES]
    const [months, before, staff, proofs, wexBefore] = await Promise.all([
      this.prisma.monthlyReport.findMany({
        where: { workspaceId, period: p },
        orderBy: { engagement: { name: 'asc' } },
        include: {
          engagement: {
            select: {
              id: true,
              name: true,
              code: true,
              budgetLines: {
                orderBy: { sortOrder: 'asc' },
                select: { id: true, name: true, amount: true, reportLine: true, payroll: true },
              },
            },
          },
          expenses: {
            select: {
              allocatedAmount: true,
              reportLine: true,
              budgetLineId: true,
              payrollKey: true,
              payrollKind: true,
              account: true,
              memo: true,
            },
          },
          wexPayments: { select: { grossAmount: true } },
        },
      }),
      this.prisma.expense.findMany({
        where: { workspaceId, monthlyReport: { period: { lt: p } } },
        select: {
          engagementId: true,
          monthlyReportId: true,
          reportLine: true,
          budgetLineId: true,
          allocatedAmount: true,
          payrollKey: true,
          payrollKind: true,
          account: true,
          memo: true,
        },
      }),
      this.prisma.staffMember.findMany({
        where: { workspaceId },
        orderBy: { name: 'asc' },
        include: { assignments: { include: { engagement: { select: { id: true, name: true } } } } },
      }),
      this.prisma.staffPayProof.findMany({
        where: { workspaceId, period: p },
        select: { staffMemberId: true, kind: true, amount: true, guessed: true },
      }),
      this.prisma.wexPayment.findMany({
        where: { workspaceId, monthlyReport: { period: { lt: p } } },
        select: {
          grossAmount: true,
          monthlyReportId: true,
          monthlyReport: { select: { engagementId: true } },
        },
      }),
    ])
    // A books' payroll transaction stops counting once the match covers its kind of payroll on its month.
    const paymentsOf = new Map<string, number>()
    for (const w of wexBefore)
      paymentsOf.set(w.monthlyReportId, (paymentsOf.get(w.monthlyReportId) ?? 0) + 1)
    for (const m of months) paymentsOf.set(m.id, m.wexPayments.length)
    const covers = payrollCovers(
      [
        ...before,
        ...months.flatMap((m) => m.expenses.map((e) => ({ ...e, monthlyReportId: m.id }))),
      ],
      paymentsOf,
      (id) => {
        const e =
          months.find((m) => m.id === id)?.engagementId ??
          wexBefore.find((w) => w.monthlyReportId === id)?.monthlyReport.engagementId
        return months.some(
          (m) => m.engagementId === e && holdsPayroll(m.engagement.budgetLines, 'participant-pay')
        )
      }
    )
    const counted = before.filter((e) => countsOnBudget(e, covers.get(e.monthlyReportId)))
    const countedNow = (m: (typeof months)[number]) =>
      m.expenses.filter((e) => countsOnBudget(e, covers.get(m.id)))
    const cents = (n: number) => Math.round(n * 100) / 100
    const sum = (xs: { toString(): string }[]) =>
      cents(xs.reduce<number>((t, x) => t + Number(x), 0))
    const isStaffLine = (l: string | null) => !!l && (staffLines as string[]).includes(l)
    const beforeOf = new Map<string, number>()
    for (const b of counted)
      if (isStaffLine(b.reportLine))
        beforeOf.set(
          b.engagementId,
          (beforeOf.get(b.engagementId) ?? 0) + Number(b.allocatedAmount)
        )
    const payOf = new Map<string, number | null>()
    const chargedOf = new Map<string, number | null>()
    for (const s of staff) {
      const regs = proofs.filter(
        (x) => x.staffMemberId === s.id && x.kind === 'payroll-register' && x.amount !== null
      )
      const details = proofs.filter(
        (x) => x.staffMemberId === s.id && x.kind === 'payroll-details' && x.amount !== null
      )
      chargedOf.set(s.id, details.length ? sum(details.map((x) => x.amount!)) : null)
      payOf.set(s.id, regs.length ? sum(regs.map((x) => x.amount!)) : (chargedOf.get(s.id) ?? null))
    }
    const cards = months.map((m): EngagementPayrollCardDto => {
      const charged = sum(
        countedNow(m)
          .filter((e) => isStaffLine(e.reportLine))
          .map((e) => e.allocatedAmount)
      )
      const approved = sum(
        m.engagement.budgetLines.filter((b) => isStaffLine(b.reportLine)).map((b) => b.amount)
      )
      const wexApproved = sum(
        m.engagement.budgetLines
          .filter((b) => (wexLines as string[]).includes(b.reportLine))
          .map((b) => b.amount)
      )
      const chargedBefore = cents(beforeOf.get(m.engagementId) ?? 0)
      const tagged = staff.filter((s) =>
        s.assignments.some((a) => a.engagementId === m.engagementId)
      )
      const people = tagged.map((s) => {
        const mine = proofs.filter((x) => x.staffMemberId === s.id)
        return {
          staffId: s.id,
          name: s.name,
          role: s.role,
          pay: payOf.get(s.id) ?? null,
          charged: chargedOf.get(s.id) ?? null,
          proof: {
            timesheet: mine.some((x) => x.kind === 'timesheet'),
            // Payroll details is their register proof too (#22, section 8).
            register: mine.some(
              (x) => x.kind === 'payroll-register' || x.kind === 'payroll-details'
            ),
            // A bank line found by its amount alone is a guess until the owner confirms it: not proof here.
            bank: mine.some((x) => x.kind === 'bank-statement' && !x.guessed),
          },
          alsoOn: s.assignments
            .filter((a) => a.engagementId !== m.engagementId)
            .map((a) => ({ id: a.engagement.id, name: a.engagement.name }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        }
      })
      const payFound = cents(people.reduce((t, x) => t + (x.pay ?? 0), 0))
      return {
        engagementId: m.engagementId,
        engagementName: m.engagement.name,
        engagementCode: m.engagement.code,
        reportId: m.id,
        monthStatus: m.status as ReportStatus,
        charged,
        chargedByDetails: cents(people.reduce((t, x) => t + (x.charged ?? 0), 0)),
        lines: computeBudgetLines(
          m.engagement.budgetLines,
          [
            ...counted.filter((b) => b.engagementId === m.engagementId),
            // The participants' pay counts on the line that holds it.
            ...participantPaySpend(
              m.engagement.budgetLines,
              sum(
                wexBefore
                  .filter((w) => w.monthlyReport.engagementId === m.engagementId)
                  .map((w) => w.grossAmount)
              )
            ),
          ],
          [
            ...countedNow(m),
            ...participantPaySpend(
              m.engagement.budgetLines,
              sum(m.wexPayments.map((w) => w.grossAmount))
            ),
          ]
        ),
        wex: {
          thisMonth: sum(m.wexPayments.map((w) => w.grossAmount)),
          payments: m.wexPayments.length,
          before: sum(
            wexBefore
              .filter((w) => w.monthlyReport.engagementId === m.engagementId)
              .map((w) => w.grossAmount)
          ),
          approved: wexApproved,
        },
        staffBudget: { approved, chargedBefore, left: cents(approved - chargedBefore - charged) },
        staff: people,
        payFound,
        covered: charged <= payFound + 0.005,
      }
    })
    const sharedStaffOvercharged = sharedOvercharged(
      cards,
      staff.map((s) => ({ id: s.id, engagementIds: s.assignments.map((a) => a.engagementId) })),
      payOf
    )
    await this.log.log(caller, {
      workspaceId,
      resource: 'workspace',
      subjectId: workspaceId,
      action: 'read',
      description: `Opened the staff payroll by engagement for ${monthName(p)}: ${howMany(cards.length, 'engagement')}, ${howMany(cards.filter((c) => !c.covered).length, 'charged more than the pay in the files', 'charged more than the pay in the files')}${sharedStaffOvercharged.length ? `, ${howMany(sharedStaffOvercharged.length, 'group of engagements sharing staff', 'groups of engagements sharing staff')} charged more than their pay` : ''}`,
    })
    return { workspaceId, period: p, engagements: cards, sharedStaffOvercharged }
  }

  // ── Suggestions for the staff list ───────────────────────────────────────

  /**
   * People the month's payroll registers name who are not on the staff list (nor on a participant list), for the
   * paste import: from the caller's open run of the month when `runId` is given, else from the registers already saved.
   * Owners only (anyone else 404). One read line, counts only.
   */
  async staffSuggestions(
    caller: Caller,
    workspaceId: string,
    period: unknown,
    runId?: unknown
  ): Promise<StaffSuggestionDto[]> {
    if (!workspaceRole(caller, workspaceId, ['owner'])) throw new NotFoundException()
    const p = this.period(period)
    let rows: { text: string; fileName: string }[]
    /** The people the run's pay stubs name: participants (on a list or not), never staff to suggest. */
    let stubNames: string[] = []
    if (typeof runId === 'string' && runId) {
      const run = await this.open(caller, runId)
      if (run.workspaceId !== workspaceId || run.period !== p) throw new NotFoundException()
      stubNames = run.files
        .filter((f) => f.kind === 'paystub')
        .map((f) => stubName(proofFile(f).lines))
        .filter((n): n is string => !!n)
      rows = run.files
        .filter((f) => f.kind === 'payroll-register')
        .flatMap((f) =>
          payLinesOf(proofFile(f))
            .filter((l): l is StatementLine => !!l)
            .map((l) => ({ text: l.text, fileName: f.fileName }))
        )
    } else {
      const kept = await this.prisma.payrollPayLine.findMany({
        where: { workspaceId, period: p, kind: 'payroll-register' },
        include: { document: { select: { fileName: true } } },
      })
      rows = kept
        .map((l) => ({
          text: ((l.mark ?? null) as StatementLine | null)?.text ?? '',
          fileName: l.document.fileName,
        }))
        .filter((r) => r.text)
    }
    const { staff, participants } = await this.lists(workspaceId)
    const out = new Map<string, StaffSuggestionDto>()
    for (const r of rows) {
      if (namesSomeone({ text: r.text } as StatementLine, staff, participants)) continue
      if (stubNames.some((n) => personIn(r.text, n))) continue
      const person = registerPerson(r.text)
      if (!person) continue
      const key = person.name.toLowerCase()
      if (!out.has(key)) out.set(key, { ...person, fileName: r.fileName })
    }
    const list = [...out.values()].sort((a, b) => a.name.localeCompare(b.name))
    await this.log.log(caller, {
      workspaceId,
      resource: 'document',
      action: 'read',
      description: `Looked for staff on the payroll registers for ${monthName(p)}: ${howMany(list.length, 'suggestion')}`,
    })
    return list
  }

  /** A kept pay line, in the caller's sight and this workspace. */
  private async payLine(caller: Caller, workspaceId: string, lineId: string) {
    const line = await this.prisma.payrollPayLine.findFirst({
      where: { id: lineId, workspaceId },
      include: { document: true },
    })
    if (!line || !keyInWorkspace(line.document)) throw new NotFoundException()
    return line
  }

  /**
   * Fix by hand, or confirm a guess: links the pay's file to an engagement's payroll item as the proof it is (a register
   * its register, a pay stub a participant's pay, a bank line a staff line's payment), with the pay's line marked and the
   * item's highlights cut from the file. The owner's decision: matching again never changes it while the file stays as it
   * is. The item's month must be a draft (reopen it on its page first). A pay marked not grant-funded loses that mark in
   * the same transaction. Answers the reconciliation, unlogged.
   */
  async linkLine(
    caller: Caller,
    workspaceId: string,
    lineId: string,
    input: PayLineLinkInput
  ): Promise<PayrollReconciliationDto> {
    this.owner(caller, workspaceId)
    const line = await this.payLine(caller, workspaceId, lineId)
    const { items } = await workspaceItems(this.prisma, caller, workspaceId, line.period)
    const item = items.find((i) => i.target === input?.target && i.id === input?.id)
    if (!item)
      throw new BadRequestException(
        `Choose a payroll item of an engagement's ${monthName(line.period)}`
      )
    const kind = line.kind as PayLineKind
    const slot = PAY_SLOT[kind]
    if (!slotsOf(item.proof).includes(slot))
      throw new BadRequestException(
        kind === 'paystub'
          ? "A pay stub proves a participant's work-experience pay"
          : "A bank line proves a staff payroll line; a participant's pay is proved by a pay stub"
      )
    refuseLocked({ status: item.month.status, period: line.period })
    const doc = line.document
    const mark = line.mark ? cleanMark(line.mark) : null
    let marks: StatementMark[] = []
    if (doc.contentType === 'application/pdf')
      try {
        const text = await readStatement(await this.storage.read(doc.storageKey))
        const fields = (await this.highlights.current())[doc.kind as PayrollDocumentKind] ?? []
        marks = highlightsFor(
          item.proof,
          fields,
          text.items as PageItem[],
          mark as StatementLine | null
        )
      } catch (e) {
        this.logger.warn(`Could not read ${doc.id} for its highlights: ${(e as Error).message}`)
      }
    if (!marks.length && mark) marks = [mark]
    const clean = marks.slice(0, 20).map(cleanMark)
    const purpose = PURPOSE[slot]
    const documentId = doc.id
    await this.log.change(
      caller,
      async (tx) => {
        // The pay as it stands, locked: an owner marking it not grant-funded in another tab waits for this link, then
        // finds it covered; one who marked it first is taken back here.
        const now = await lockLine(tx, line.id)
        if (!now) throw new NotFoundException()
        await this.upsertLink(
          tx,
          { target: item.target, purpose, mark, marks: clean },
          item.id,
          documentId
        )
        if (now.notFundedReason)
          await tx.payrollPayLine.update({
            where: { id: line.id },
            data: {
              notFundedReason: null,
              notFundedById: null,
              notFundedByEmail: null,
              notFundedAt: null,
            },
          })
      },
      {
        workspaceId,
        resource: item.target === 'expense' ? 'expense' : 'report',
        subjectId: item.id,
        action: 'update',
        description: `Linked ${describe(doc)} to ${item.subject} of ${item.month.engagementName} as its ${SLOT_WORDS[slot]} from the payroll reconciliation${mark ? ' and marked the line' : ''}`,
      }
    )
    await this.checks.refresh(item.month.reportId)
    return this.reconciliationOf(caller, workspaceId, line.period)
  }

  /**
   * Marks a pay that is on no engagement's item as not grant-funded, with the reason (at most 500 characters). The
   * reason is on the reconciliation; the line names the field alone. The same reason again changes nothing.
   */
  async markNotFunded(
    caller: Caller,
    workspaceId: string,
    lineId: string,
    reason: unknown
  ): Promise<PayrollReconciliationDto> {
    this.owner(caller, workspaceId)
    const line = await this.payLine(caller, workspaceId, lineId)
    const why = typeof reason === 'string' ? reason.trim() : ''
    if (!why) throw new BadRequestException('Say why this pay is not grant-funded')
    if (why.length > 500) throw new BadRequestException('The reason must be at most 500 characters')
    const kind = line.kind as PayLineKind
    const mark = line.mark as StatementLine | null
    const covered = () =>
      new ConflictException(
        "This pay is on an engagement's payroll item: remove that proof first to mark it not grant-funded"
      )
    const { items } = await workspaceItems(this.prisma, caller, workspaceId, line.period)
    if (coveredBy(items, line.documentId, kind, mark, line.document.sha256)) throw covered()
    if (line.notFundedReason !== why)
      await this.log.change(
        caller,
        async (tx) => {
          // Checked again on the pay as it stands, locked: a link made meanwhile (another tab) was made first and
          // refuses this; one made after waits for this, and takes the mark back.
          if (!(await lockLine(tx, line.id))) throw new NotFoundException()
          if (await coveredNow(tx, line.document, kind, mark)) throw covered()
          return tx.payrollPayLine.update({
            where: { id: line.id },
            data: {
              notFundedReason: why,
              notFundedById: caller.userId,
              notFundedByEmail: staffName(caller),
              notFundedAt: new Date(),
            },
          })
        },
        {
          workspaceId,
          resource: 'document',
          subjectId: line.documentId,
          action: 'update',
          description: `Marked a pay on ${describe(line.document)} as not grant-funded`,
          changes: [{ field: 'Why it is not grant-funded' }],
        }
      )
    return this.reconciliationOf(caller, workspaceId, line.period)
  }

  /** Takes back "not grant-funded": the pay is unassigned again. Nothing to take back changes nothing. */
  async clearNotFunded(
    caller: Caller,
    workspaceId: string,
    lineId: string
  ): Promise<PayrollReconciliationDto> {
    this.owner(caller, workspaceId)
    const line = await this.payLine(caller, workspaceId, lineId)
    if (line.notFundedReason)
      await this.log.change(
        caller,
        (tx) =>
          tx.payrollPayLine.update({
            where: { id: line.id },
            data: {
              notFundedReason: null,
              notFundedById: null,
              notFundedByEmail: null,
              notFundedAt: null,
            },
          }),
        {
          workspaceId,
          resource: 'document',
          subjectId: line.documentId,
          action: 'update',
          description: `Took back "not grant-funded" for a pay on ${describe(line.document)}`,
          changes: [{ field: 'Why it is not grant-funded' }],
        }
      )
    return this.reconciliationOf(caller, workspaceId, line.period)
  }

  // ── The owners' setting ──────────────────────────────────────────────────

  /**
   * "Bookkeepers see staff payroll" (owner's decisions, 2026-10-17 and 2026-10-18): on by default; off, a bookkeeper's
   * month page shows the payroll proofs as labels, not links. The screen only: what the API answers is unchanged. Its
   * owners only; the platform admin never sets it (trigger Workspace_4_admin_lists too).
   */
  async setBookkeepersSeeStaffPayroll(
    caller: Caller,
    workspaceId: string,
    given: unknown
  ): Promise<{ bookkeepersSeeStaffPayroll: boolean }> {
    if (!caller.workspaceIds.includes(workspaceId)) throw new NotFoundException()
    allow(
      !caller.admin && workspaceRole(caller, workspaceId, ['owner']),
      'Only an owner decides whether bookkeepers see staff payroll'
    )
    if (typeof given !== 'boolean') throw new BadRequestException('Say true or false')
    const w = await this.prisma.workspace.findFirst({
      where: { id: workspaceId },
      select: { bookkeepersSeeStaffPayroll: true },
    })
    if (!w) throw new NotFoundException()
    if (w.bookkeepersSeeStaffPayroll === given) return { bookkeepersSeeStaffPayroll: given }
    const data = { bookkeepersSeeStaffPayroll: given }
    await this.log.change(
      caller,
      (tx) => tx.workspace.update({ where: { id: workspaceId }, data }),
      {
        workspaceId,
        resource: 'workspace',
        subjectId: workspaceId,
        action: 'update',
        description: given
          ? 'Turned on "Bookkeepers see staff payroll"'
          : 'Turned off "Bookkeepers see staff payroll"',
        changes: changesOf(w, data, SEE_PAYROLL_FIELDS),
      }
    )
    return data
  }
}

/** Said when another unsaved change of the month holds a file this one removes. */
const HELD =
  "Another unsaved change of this month's payroll files holds a file this one removes: save or discard it first (an unsaved one goes by itself after a day)"

/** A run file as the matcher reads it. */
const proofFileOf = (f: RunFile): MatchFile => ({ ...proofFile(f), documentId: f.documentId })

/**
 * What was found of each person on the staff list in the set, as StaffPayProof rows: their timesheets, register rows
 * (with this period's pay) and bank lines. A bank line found by its amount alone is kept as `guessed`, unless a person
 * already linked that line to one of their engagement's staff lines (then it is confirmed proof).
 */
function staffProofRows(
  plan: Plan,
  docIds: Map<string, string | null>,
  period: string,
  items: WorkspaceItem[],
  /** Each file's kind: a register proof from payroll details is kept as that kind. */
  kindOf: Map<string, string>
): Prisma.StaffPayProofCreateManyInput[] {
  const confirmed = (f: StaffFound, documentId: string, line: StatementLine | null) =>
    !!line &&
    items.some(
      (i) =>
        i.target === 'expense' &&
        isStaffLine(i.reportLine) &&
        f.staff.engagementIds.includes(i.month.engagementId) &&
        i.links.some((l) => l.documentId === documentId && linkCovers(l, 'bank-statement', line))
    )
  return plan.staff.flatMap((f) =>
    (
      [
        ['timesheet', f.timesheet, false],
        [
          'payroll-register',
          f.register.filter((x) => kindOf.get(x.fileId) !== 'payroll-details'),
          false,
        ],
        [
          'payroll-details',
          f.register.filter((x) => kindOf.get(x.fileId) === 'payroll-details'),
          false,
        ],
        ['bank-statement', f.bank, false],
        ['bank-statement', f.bankGuess, true],
      ] as const
    ).flatMap(([kind, lines, guess]) =>
      lines.map((p) => {
        const documentId = docIds.get(p.fileId)!
        return {
          staffMemberId: f.staff.id,
          documentId,
          period,
          kind,
          amount: p.amount === null ? null : p.amount.toFixed(2),
          ...(p.line ? { mark: cleanMark(p.line) as object } : {}),
          guessed: guess && !confirmed(f, documentId, p.line),
        }
      })
    )
  )
}

/**
 * The workspace-level check above the cards (owner's review, 2026-10-18): engagements linked by the people tagged to
 * several of them form groups; a group is flagged when what its engagements are charged adds up to more than the pay
 * found for everyone tagged to any of them, each person counted once. Names the engagements only.
 */
export function sharedOvercharged(
  cards: { engagementId: string; engagementName: string; charged: number }[],
  staff: { id: string; engagementIds: string[] }[],
  payOf: Map<string, number | null>
): WorkspacePayrollOutputDto['sharedStaffOvercharged'] {
  const onCards = new Set(cards.map((c) => c.engagementId))
  const parent = new Map(cards.map((c) => [c.engagementId, c.engagementId]))
  const root = (id: string): string => {
    let r = id
    while (parent.get(r) !== r) r = parent.get(r)!
    return r
  }
  for (const s of staff) {
    const mine = s.engagementIds.filter((id) => onCards.has(id))
    for (const id of mine.slice(1)) parent.set(root(id), root(mine[0]!))
  }
  const groups = new Map<string, typeof cards>()
  for (const c of cards)
    groups.set(root(c.engagementId), [...(groups.get(root(c.engagementId)) ?? []), c])
  const out: WorkspacePayrollOutputDto['sharedStaffOvercharged'] = []
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const ids = new Set(group.map((c) => c.engagementId))
    const charged = group.reduce((t, c) => t + c.charged, 0)
    const pay = staff
      .filter((s) => s.engagementIds.some((id) => ids.has(id)))
      .reduce((t, s) => t + (payOf.get(s.id) ?? 0), 0)
    if (charged > pay + 0.005)
      out.push({
        engagements: group
          .map((c) => ({ id: c.engagementId, name: c.engagementName }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      })
  }
  return out
}

/**
 * The pay line, locked for the rest of the transaction (`FOR UPDATE`, parameterized), as it stands: a link to it and a
 * "not grant-funded" for it wait for each other. Null when it is gone or out of the caller's sight.
 */
async function lockLine(
  tx: Prisma.TransactionClient,
  id: string
): Promise<{ notFundedReason: string | null } | null> {
  const [row] = await tx.$queryRaw<{ notFundedReason: string | null }[]>`
    SELECT "notFundedReason" FROM "PayrollPayLine" WHERE "id" = ${id} FOR UPDATE`
  return row ?? null
}

/** Whether a saved proof link to the document covers this pay, read on the transaction (as `coveredBy`). */
async function coveredNow(
  tx: Prisma.TransactionClient,
  doc: { id: string; sha256: string; kind: string },
  kind: PayLineKind,
  mark: StatementMark | null
): Promise<boolean> {
  // A link to the document, or to the same file (its contents) already on file for an item.
  const where = {
    OR: [{ documentId: doc.id }, { document: { sha256: doc.sha256, kind: doc.kind } }],
    ...(kind === 'paystub' ? { purpose: 'payment' } : {}),
  }
  const select = { mark: true, marks: true } as const
  const links = [
    ...(await tx.expenseDocument.findMany({ where, select })),
    ...(await tx.wexPaymentDocument.findMany({ where, select })),
  ]
  return links.some((l) => linkCovers(l, kind, mark))
}

/** The person on the staff list whose register row or bank line this is, by the plan. */
/** A value as JSON with every object's keys sorted: the database keeps a JSON column's keys in its own order. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object')
    return `{${Object.entries(v)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`)
      .join(',')}}`
  return JSON.stringify(v)
}

function staffOn(plan: Plan, fileId: string, line: StatementLine | null) {
  if (!line) return undefined
  // A pay run's debit is everyone's in the run, so it is no one person's line.
  return plan.staff.find((f) =>
    [...f.register, ...f.bank].some(
      (p) => !p.run && p.fileId === fileId && p.line && sameLine(p.line, line)
    )
  )
}

/** The person whose pay this bank line's amount alone may be, by the plan: a guess. */
function staffGuessOn(plan: Plan, fileId: string, line: StatementLine | null) {
  if (!line) return null
  return (
    plan.staff.find((f) =>
      f.bankGuess.some((p) => p.fileId === fileId && p.line && sameLine(p.line, line))
    ) ?? null
  )
}

/** The first staff payroll line of an engagement the person is on, for a guess to be checked against. */
function staffItemOf(items: WorkspaceItem[], person: { engagementIds: string[] }) {
  return items.find(
    (i) =>
      i.target === 'expense' &&
      isStaffLine(i.reportLine) &&
      person.engagementIds.includes(i.month.engagementId)
  )
}

/**
 * A register that names nobody on the staff or participant lists is the run's company totals (taxes, deductions,
 * totals), not people's rows: none of its lines is a person's pay (January test, 2026-10-19). It still proves the run.
 */
function companyTotals(
  kind: string,
  lines: (StatementLine | null)[],
  staff: StaffRow[],
  participants: ParticipantRow[]
): boolean {
  return (
    kind === 'payroll-register' && !lines.some((l) => !!l && namesSomeone(l, staff, participants))
  )
}

/** Whether a register row or bank line names anyone on the staff list or a participant list by full name (`personIn`). */
function namesSomeone(
  line: StatementLine | null,
  staff: StaffRow[],
  participants: ParticipantRow[]
): boolean {
  if (!line?.text) return true
  return (
    staff.some((s) => personIn(line.text, printedName(s.name))) ||
    participants.some((p) => personIn(line.text, p.displayName))
  )
}

/** The staff payroll line, of an engagement the person is on, that a saved link to this document proves. */
function staffItemFor(
  items: WorkspaceItem[],
  person: StaffRow,
  documentId: string
): WorkspaceItem | undefined {
  return items.find(
    (i) =>
      i.target === 'expense' &&
      isStaffLine(i.reportLine) &&
      person.engagementIds.includes(i.month.engagementId) &&
      i.links.some((l) => l.documentId === documentId)
  )
}

/** A box as a comparable string, whatever order its stored keys come back in. */
const boxKey = (m: unknown): string => {
  if (!m || typeof m !== 'object') return ''
  const b = m as StatementMark
  return [b.page, b.x, b.y, b.width, b.height, b.text ?? ''].join('|')
}
const boxesKey = (ms: unknown): string => (Array.isArray(ms) ? ms.map(boxKey).join(';') : '')

/** An item as a pay line names it. */
const itemRef = (i: WorkspaceItem): NonNullable<PayLineDto['item']> => ({
  target: i.target,
  id: i.id,
  engagementId: i.dto.engagementId,
  engagementName: i.dto.engagementName,
  reportId: i.dto.reportId,
  period: i.dto.period,
  title: i.dto.title,
})

/**
 * The item whose saved proof covers this pay: a link to its document (or to the same file, by its contents, already on
 * file for the item) on its line (a pay stub: any link to it as the payment).
 */
export function coveredBy(
  items: WorkspaceItem[],
  documentId: string,
  kind: PayLineKind,
  mark: StatementMark | null,
  sha256?: string
): WorkspaceItem | undefined {
  return items.find((i) =>
    i.links.some(
      (l) =>
        (l.documentId === documentId || (!!sha256 && l.sha256 === sha256 && l.kind === kind)) &&
        (kind !== 'paystub' || l.purpose === 'payment') &&
        linkCovers(l, kind, mark)
    )
  )
}

/**
 * The item a pay on no item's proof is most likely for, waiting for a person to check: an item still missing that kind
 * of proof whose amount (and name, or dates) the line shows, as the matcher scores it (4 or more). Null when none.
 */
export function guessFor(
  items: WorkspaceItem[],
  kind: PayLineKind,
  mark: StatementLine | null
): WorkspaceItem | null {
  if (!mark?.text) return null
  const slot = PAY_SLOT[kind]
  let best: { item: WorkspaceItem; score: number } | null = null
  for (const item of items) {
    if (!slotsOf(item.proof).includes(slot) || proved(item.links, slot)) continue
    const c = candidateFor(item.proof, slot, {
      id: 'line',
      kind: PAYROLL_SLOT_KIND[slot],
      fileName: '',
      lines: [mark],
    })
    if (c.score >= 4 && (!best || c.score > best.score)) best = { item, score: c.score }
  }
  return best?.item ?? null
}

/** A proof as the page shows where it was found. */
const spot = (p: PersonLine): ProofSpotDto => ({
  fileId: p.fileId,
  mark: p.line,
  ...(p.run ? { run: true } : {}),
  ...(p.source ? { source: p.source, amount: p.amount } : {}),
})

const PROOF_PLURAL: Record<PayrollSlot, string> = {
  timesheet: 'timesheets',
  register: 'payroll registers',
  stub: 'pay stubs',
  bank: 'bank lines',
}

/** "Casey Demo's pay has two different pay stubs: check which is right". */
function twoProofsOf(i: WorkspaceItem, slot: PayrollSlot): TwoProofsDto {
  const who = i.target === 'wex' && i.proof.name ? `${i.proof.name}'s pay` : i.dto.title
  return {
    target: i.target,
    id: i.id,
    title: i.dto.title,
    engagementName: i.month.engagementName,
    reportId: i.month.reportId,
    slot,
    message: `${who} has two different ${PROOF_PLURAL[slot]}: check which is right`,
  }
}

/**
 * The saved items with two different files as one proof (owner's decision, 2026-10-19): a person's (the bookkeeper's)
 * and the match's, of different contents. Both stay; the owner checks which is right.
 */
export function twoProofsOn(items: WorkspaceItem[], staffNames: string[] = []): TwoProofsDto[] {
  return items.flatMap((i) =>
    slotsOf(i.proof)
      .filter((slot) => {
        const links = i.links.filter((l) => slotOfLink(l) === slot)
        const side = (byMatch: boolean) =>
          links.filter((l) => l.byMatch === byMatch).map((l) => ({ sha: l.sha256, marks: l.marks }))
        return twoDiffer(i, slot, side(false), side(true), staffNames)
      })
      .map((slot) => twoProofsOf(i, slot))
  )
}

type Side = { sha: string; marks: unknown }[]

/**
 * Whether an item's proof of one kind is two different files that need the owner (owner's decision, 2026-10-19): a
 * person's (the bookkeeper's) and the match's, of different contents, only when the two contradict each other: two pay
 * stubs by their pay, hours or dates (pay period, pay date; owner's decision, 2026-10-20), and one whose highlighted words
 * could not be read is flagged, since it can't be compared; a timesheet or a register by a different amount or
 * different hours for the same person. A participant's pay is one person's; a staff line's are the staff named on both.
 */
export function twoDiffer(
  i: Pick<WorkspaceItem, 'target' | 'proof'>,
  slot: PayrollSlot,
  theirs: Side,
  ours: Side,
  staffNames: string[] = []
): boolean {
  const shas = new Set(theirs.map((t) => t.sha))
  const other = ours.filter((o) => !shas.has(o.sha))
  if (!theirs.length || !other.length) return false
  if (slot === 'stub') {
    const a = theirs.flatMap((t) => textsOf(t.marks))
    const b = other.flatMap((o) => textsOf(o.marks))
    if (!a.length || !b.length) return true
    const x = figures(a)
    const y = figures(b)
    return (
      disjoint(x.amounts, y.amounts) ||
      disjoint(x.hours, y.hours) ||
      disjoint(datesOf(a), datesOf(b))
    )
  }
  const names = i.target === 'wex' && i.proof.name ? [i.proof.name] : staffNames
  return theirs.some((t) =>
    other.some((o) => contradicts(textsOf(t.marks), textsOf(o.marks), names, i.target === 'wex'))
  )
}

const textsOf = (marks: unknown): string[] =>
  (Array.isArray(marks) ? (marks as { text?: unknown }[]) : [])
    .map((m) => (typeof m?.text === 'string' ? m.text : ''))
    .filter(Boolean)
/** Hours as payroll files print them: 20.0, never part of an amount or a date. */
const HOURS = /(?<![\d.,$/])\d{1,3}\.\d(?![\d/])/g
const figures = (texts: string[]) => {
  const t = texts.join(' ')
  return { amounts: new Set(amountsOn(t)), hours: new Set([...t.matchAll(HOURS)].map((m) => m[0])) }
}
/** The dates a pay stub's words print (m/d/yyyy), as yyyy-mm-dd. */
const DATE = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g
const datesOf = (texts: string[]) =>
  new Set(
    [...texts.join(' ').matchAll(DATE)].map(
      ([, m, d, y]) => `${y}-${m!.padStart(2, '0')}-${d!.padStart(2, '0')}`
    )
  )
const disjoint = (a: Set<number | string>, b: Set<number | string>) =>
  a.size > 0 && b.size > 0 && ![...a].some((x) => b.has(x))

/**
 * Two files' highlighted words for the same person disagree: for each name both name, their lines for that person show
 * different amounts or different hours. `whole`: the words are one person's even where no line names them (a
 * participant's register highlights its amount and dates alone).
 */
export function contradicts(
  theirs: string[],
  ours: string[],
  names: string[],
  whole = false
): boolean {
  const differ = (a: string[], b: string[]) => {
    const x = figures(a)
    const y = figures(b)
    return disjoint(x.amounts, y.amounts) || disjoint(x.hours, y.hours)
  }
  let named = false
  for (const n of names) {
    const a = theirs.filter((t) => personIn(t, n))
    const b = ours.filter((t) => personIn(t, n))
    if (!a.length || !b.length) continue
    named = true
    if (differ(a, b)) return true
  }
  return whole && !named && differ(theirs, ours)
}

/**
 * The people a register pays who are on no list (owner's decision, 2026-10-19): a row naming nobody on the staff list
 * or a participant list, and nobody a pay stub of the files names (that is a participant on no list, shown with the
 * pay stubs), whose name a timesheet prints too. Each with the timesheet lines that name them. Their pay reaches no
 * engagement; the owner adds them with Resolve.
 */
export function unlistedPeople(
  plan: Plan,
  files: MatchFile[],
  staff: StaffRow[],
  participants: ParticipantRow[]
): UnlistedPersonDto[] {
  const runs = payRunsOf(files)
  const dateOf = (r: { payDate: string | null; end: string | null } | null | undefined) =>
    r ? (r.payDate ?? r.end) : null
  const stubNames = plan.stubs.map((x) => x.named).filter((n): n is string => !!n)
  const out = new Map<string, UnlistedPersonDto>()
  for (const f of files.filter((x) => x.kind === 'payroll-register'))
    for (const line of payLinesOf(f)) {
      if (!line || namesSomeone(line, staff, participants)) continue
      const person = registerPerson(line.text)
      if (!person || stubNames.some((n) => personIn(line.text, n))) continue
      const key = person.name.toLowerCase()
      const had = out.get(key) ?? { name: person.name, register: [], timesheet: [] }
      had.register.push({
        fileId: f.id,
        mark: line,
        payDate: dateOf(runs.find((r) => r.fileId === f.id)),
      })
      out.set(key, had)
    }
  for (const p of out.values())
    for (const t of files.filter((x) => x.kind === 'timesheet')) {
      const line = t.lines.find((l) => personIn(l.text, p.name))
      if (line)
        p.timesheet.push({
          fileId: t.id,
          mark: line,
          payDate: dateOf(runOfLine(runs, t, line)),
        })
    }
  // Only a name a timesheet names too is a person (owner's review, 2026-10-19): a register's tax and deduction lines
  // ("Social Security 1,234.56") print words and an amount as a person's row does, but no timesheet names them.
  return [...out.values()]
    .filter((p) => p.timesheet.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * The registers of the files paid in another month than `period` (by their pay date, else their period's end; owner's
 * decision, 2026-10-19), and their runs' debits: none of it is this month's pay.
 */
function awayLines(files: MatchFile[], period: string) {
  const runs = payRunsOf(files).filter((r) => payMonthOf(r) && payMonthOf(r) !== period)
  return {
    files: new Set(runs.map((r) => r.fileId)),
    isDebit: (fileId: string, line: StatementLine) =>
      runs.some((r) => r.debit?.fileId === fileId && sameLine(r.debit.line, line)),
  }
}
