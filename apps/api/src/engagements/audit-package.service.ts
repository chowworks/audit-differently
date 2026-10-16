import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { strToU8, zipSync, type Zippable } from 'fflate'
import {
  DOCUMENT_PURPOSE_LABELS,
  ENGAGEMENT_TRACK_LABELS,
  ENGAGEMENT_TRACKS,
  PERSONAL_DOCUMENT_ROLES,
  type DocumentPurpose,
  type Role,
  type StatementMark,
} from '@ad/types'
import { AccessLogService } from '../core/access-log.service'
import { keyInWorkspace } from '../documents/documents.service'
import { eligibilityItemsOf } from './eligibility'
import { zipEntries, type ZipSource } from './zip-stream'
import { splitParts, streamPart, type ExportObject, type PartLayout } from './export-parts'
import { staffName, tenantWhere, workspaceRole, type Caller } from '../core/caller'
import { howMany } from '../core/changes'
import { budgetItemsOf } from '../workspaces/budget-items'
import { markPdf, markPlace, NOT_DRAWN } from '../payroll/mark-pdf'
import { PrismaService } from '../prisma/prisma.service'
import {
  currentSignedCopy,
  earlierSignedName,
  reopenedWords,
  reopeningRows,
  type Reopening,
} from '../reports/reopenings'
import { DOCUMENT_STORAGE, type DocumentStorage } from '../storage/document-storage.interface'

/** Where each engagement-level record kind files, in the order the auditor reads them. */
const STEP_FOLDER: Record<string, string> = {
  proposal: '01 Proposal',
  'award-letter': '02 Award letter',
  'budget-narrative': '03 Budget narrative',
  contract: '04 Contract',
  mou: '04 Contract',
}

/**
 * Records one statement or register covers for the whole month. The funder's own package files them once,
 * in these two folders, instead of a copy behind every expense they back.
 */
const MONTH_SHARED: Record<string, string> = {
  'bank-statement': 'Proof of Purchase - Bank Statements',
  'card-statement': 'Proof of Purchase - Bank Statements',
  'payroll-register': 'Payroll and Timesheet Reports',
  timesheet: 'Payroll and Timesheet Reports',
}

const purposeLabel = (p: string) => DOCUMENT_PURPOSE_LABELS[p as DocumentPurpose] ?? p
export const safe = (s: string) =>
  s
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
export const ext = (fileName: string) => {
  const i = fileName.lastIndexOf('.')
  return i > 0 ? fileName.slice(i).toLowerCase() : ''
}
export const money = (n: number) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
export const day = (d: Date) => d.toISOString().slice(0, 10)
/** MM.DD.YY, the way the funder's package names files. */
const stamp = (d: Date) => {
  const [y, m, dd] = day(d).split('-')
  return `${m}.${dd}.${y!.slice(2)}`
}
const monthName = (period: string) => {
  const [y, m] = period.split('-').map(Number)
  return new Date(Date.UTC(y!, m! - 1, 1)).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
}
/**
 * A CSV cell a spreadsheet will not run: text that starts with =, +, -, @, a tab or a carriage return is read as a
 * formula, so it gets a leading apostrophe (vendor and memo text can come from an imported file). A plain signed
 * number (-224.00) is left as it is, so a negative amount stays a number.
 */
const cell = (v: string | number) => {
  const s = String(v ?? '')
  return /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s
}
export const csv = (rows: (string | number)[][]) =>
  rows.map((r) => r.map((v) => `"${cell(v).replace(/"/g, '""')}"`).join(',')).join('\r\n')

type Doc = {
  id: string
  storageKey: string
  fileName: string
  kind: string
  uploadedAt: Date
  size: number
  workspaceId: string
  engagementId: string | null
  sensitivity?: string
}

/**
 * The audit package: every record the engagement holds, as one zip laid out the way the funder's own
 * package is: the engagement's records by step, then each month with its ledger, its program costs and the
 * payroll verification of each participant paid, then each participant's eligibility file. A participant
 * list, a README and an index of every file sit at the root. Personal records go in only for the roles
 * that may open them; the README says so either way.
 */
@Injectable()
export class AuditPackageService {
  private readonly logger = new Logger(AuditPackageService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly log: AccessLogService,
    @Inject(DOCUMENT_STORAGE) private readonly storage: DocumentStorage
  ) {}

  /**
   * Works out every file of the package: the text files are made here, each stored object is a key to fetch when it
   * is written. The only objects read here are the bank statements with marked lines, to know which marks can be
   * drawn. `complete` is the copy taken before an engagement is
   * deleted: it also files whatever the layout does not reach (a document attached to nothing) under Unfiled
   * records, and adds the budget, the months' status and the checks as CSVs, so nothing the owner may see is lost.
   */
  async plan(
    caller: Caller,
    engagementId: string,
    options: { complete?: boolean } = {}
  ): Promise<PackagePlan> {
    const c = await this.prisma.engagement.findFirst({
      where: { id: engagementId, ...tenantWhere(caller) },
      include: {
        workspace: true,
        documents: { orderBy: { uploadedAt: 'asc' } },
        budgetLines: { orderBy: { sortOrder: 'asc' } },
        monthlyReports: {
          orderBy: { period: 'asc' },
          include: {
            checks: true,
            reopenings: { orderBy: { reopenedAt: 'asc' } },
            expenses: {
              orderBy: [{ date: 'asc' }, { itemNumber: 'asc' }],
              include: { documents: { include: { document: true } } },
            },
            wexPayments: {
              orderBy: { payPeriodStart: 'asc' },
              include: { participant: true, documents: { include: { document: true } } },
            },
          },
        },
        participants: {
          orderBy: { displayName: 'asc' },
          include: { documents: { include: { document: true } } },
        },
      },
    })
    if (!c) throw new NotFoundException()
    const personal = workspaceRole(caller, c.workspaceId, [...PERSONAL_DOCUMENT_ROLES] as Role[])
    const root = safe(`${c.name}${c.number ? ` (${c.number})` : ''}`)
    const files: Record<string, Uint8Array> = {}
    const objects: ExportObject[] = []
    const placedDocs = new Set<string>()
    const personalPaths = new Set<string>()
    const index: (string | number)[][] = [
      [
        'Step',
        'Month',
        'Item',
        'Vendor or participant',
        'Purpose',
        'Amount',
        'Document type',
        'File',
        'Uploaded',
      ],
    ]
    const seen = new Set<string>()
    const marks = new Map<string, StatementMark[]>()
    const reopened: string[] = []
    /** A payroll item's marked line on its bank statement, drawn on the statement's copy in the package. */
    const markOf = (d: Doc, mark: unknown) => {
      if (!mark || d.kind !== 'bank-statement' || d.sensitivity !== 'financial') return
      marks.set(d.storageKey, [...(marks.get(d.storageKey) ?? []), mark as StatementMark])
    }
    let count = 0
    /** Writes the file once and returns its path inside the package. */
    const add = async (
      relPath: string,
      doc: Doc,
      meta: {
        step: string
        month?: string
        item?: string
        who?: string
        purpose?: string
        amount?: number
      }
    ) => {
      let path = `${root}/${relPath}`
      let n = 2
      while (seen.has(path)) path = `${root}/${relPath.replace(/(\.[^.]+)?$/, ` (${n++})$1`)}`
      seen.add(path)
      if (!keyInWorkspace(doc)) throw new NotFoundException()
      objects.push([path, doc.storageKey, doc.size ?? 0])
      placedDocs.add(doc.id)
      if (doc.sensitivity === 'personal') personalPaths.add(path)
      count++
      index.push([
        meta.step,
        meta.month ?? '',
        meta.item ?? '',
        meta.who ?? '',
        meta.purpose ?? '',
        meta.amount == null ? '' : meta.amount.toFixed(2),
        doc.kind,
        path.slice(root.length + 1),
        day(doc.uploadedAt),
      ])
      return path.slice(root.length + 1)
    }

    // The engagement's own records, by step; anything else the team kept goes under Other records.
    const waivers = (c.waivers ?? {}) as Record<string, string>
    const items = eligibilityItemsOf(c)
    const labels = new Map(items.map((i) => [i.key, i.label]))
    for (const d of c.documents) {
      if (d.period) continue
      if (d.sensitivity === 'personal') continue
      if (d.kind === 'audit-letter') {
        await add(`Letter to the auditors - ${safe(d.fileName)}`, d, {
          step: '08 Letter to the auditors',
        })
        continue
      }
      const folder = STEP_FOLDER[d.kind]
      if (folder)
        await add(`Engagement records/${folder} - ${safe(d.fileName)}`, d, { step: folder })
      else await add(`Other records/${safe(d.fileName)}`, d, { step: 'Other records' })
    }

    // Each month: the signed report, the ledger, each program cost's proof, and the payroll verification of
    // each participant paid. A statement or register is filed once per month and named from every line it backs.
    for (const r of c.monthlyReports) {
      const billed = r.expenses.reduce((t, e) => t + Number(e.allocatedAmount), 0)
      const month = monthName(r.period)
      const folder = `Months/${month} - ${money(billed)}`
      const placed = new Map<string, string>()
      const file = async (
        d: Doc,
        own: string,
        meta: Parameters<typeof add>[2]
      ): Promise<string> => {
        const shared = MONTH_SHARED[d.kind]
        if (!shared) return add(own, d, meta)
        const had = placed.get(d.id)
        if (had) return had
        const path = await add(`${folder}/${shared}/${safe(d.fileName)}`, d, meta)
        placed.set(d.id, path)
        return path
      }
      const signed = currentSignedCopy(
        c.documents,
        r.period,
        r.reopenings[r.reopenings.length - 1]?.reopenedAt
      )
      if (signed)
        await add(`${folder}/Signed report - ${safe(signed.fileName)}`, signed, {
          step: '07 Signed report',
          month,
        })
      // Each signed copy submitted before the month was reopened, and the reopenings themselves.
      if (r.reopenings.length) {
        const paths = new Map<Reopening, string>()
        for (const o of r.reopenings) {
          const d = c.documents.find((x) => x.id === o.signedDocumentId)
          if (!d) continue
          paths.set(
            o,
            await add(
              `${folder}/Earlier submissions/${earlierSignedName(o.submittedAt, ext(d.fileName))}`,
              d,
              { step: '07 Signed report (earlier submission)', month }
            )
          )
        }
        files[`${root}/${folder}/Reopenings.csv`] = strToU8(
          csv(reopeningRows(r.reopenings, (o) => paths.get(o) ?? 'not on file'))
        )
        reopened.push(`  ${month}: ${reopenedWords(r.reopenings.length)}`)
      }
      const ledger: (string | number)[][] = [
        [
          'Item #',
          'Date',
          'Vendor',
          'Memo',
          'Account',
          'Total cost',
          'Allocated',
          'Allocation type',
          'Allocation note',
          'Report line',
          'Files',
        ],
      ]
      for (const e of r.expenses) {
        const allocated = Number(e.allocatedAmount)
        const paths: string[] = []
        for (const ed of e.documents) {
          const d = ed.document
          markOf(d, ed.mark)
          const own = `${folder}/Program Costs/${safe(`${e.itemNumber} - ${e.vendor} - ${money(allocated)} - ${stamp(e.date)} - ${purposeLabel(ed.purpose)}`)}${ext(d.fileName)}`
          paths.push(
            await file(d, own, {
              step: '06 Monthly ledger and proof',
              month,
              item: e.itemNumber,
              who: e.vendor,
              purpose: purposeLabel(ed.purpose),
              amount: allocated,
            })
          )
        }
        ledger.push([
          e.itemNumber,
          day(e.date),
          e.vendor,
          e.memo ?? '',
          e.account ?? '',
          Number(e.totalCost).toFixed(2),
          allocated.toFixed(2),
          e.allocationType,
          e.allocationNote ?? '',
          e.reportLine,
          paths.join('; '),
        ])
      }
      files[`${root}/${folder}/Ledger.csv`] = strToU8(csv(ledger))

      if (r.wexPayments.length > 0) {
        const payroll: (string | number)[][] = [
          [
            'Participant',
            'Participant id',
            'Pay period start',
            'Pay period end',
            'Hours',
            'Gross',
            'Files',
          ],
        ]
        for (const w of r.wexPayments) {
          const who = `${w.participant.displayName} (${w.participant.participantId})`
          const paths: string[] = []
          for (const wd of w.documents) {
            const d = wd.document
            if (d.sensitivity === 'personal' && !personal) continue
            markOf(d, wd.mark)
            paths.push(
              await file(
                d,
                `${folder}/WEX Documentation/${safe(who)}/Payroll Verification/${purposeLabel(wd.purpose)} - ${safe(d.fileName)}`,
                {
                  step: '06 Payroll verification',
                  month,
                  who,
                  purpose: purposeLabel(wd.purpose),
                  amount: Number(w.grossAmount),
                }
              )
            )
          }
          payroll.push([
            w.participant.displayName,
            w.participant.participantId,
            day(w.payPeriodStart),
            day(w.payPeriodEnd),
            w.hours == null ? '' : Number(w.hours).toFixed(2),
            Number(w.grossAmount).toFixed(2),
            paths.join('; '),
          ])
        }
        files[`${root}/${folder}/Payroll.csv`] = strToU8(csv(payroll))
      }
    }

    // Every participant, as the funder's master list; each one's eligibility file for the roles that may open it.
    const required = items.filter((i) => i.required)
    const list: (string | number)[][] = [
      [
        'Participant id',
        'Name',
        'Beginning enrollment status',
        'Current status',
        'Eligibility file',
      ],
    ]
    for (const p of c.participants) {
      const have = new Set(p.documents.map((d) => d.purpose))
      const missing = required.filter((i) => !have.has(i.key))
      list.push([
        p.participantId,
        p.displayName,
        p.enrollmentStatus,
        p.currentStatus,
        missing.length === 0 ? 'complete' : `missing: ${missing.map((i) => i.label).join('; ')}`,
      ])
      if (!personal) continue
      const folder = `Participant Eligibility and Enrollment Forms/${safe(`${p.displayName} - ${p.participantId}${p.currentStatus === 'offboarded' ? ' - offboarded' : ''}`)}`
      for (const pd of p.documents)
        await add(
          `${folder}/${labels.get(pd.purpose) ?? pd.purpose} - ${safe(pd.document.fileName)}`,
          pd.document,
          {
            step: '05 Participant eligibility',
            who: `${p.displayName} (${p.participantId})`,
            purpose: labels.get(pd.purpose) ?? pd.purpose,
          }
        )
    }
    files[`${root}/Participants.csv`] = strToU8(csv(list))

    if (options.complete) {
      // Anything the layout above did not reach, so a deletion loses no stored file the owner may see.
      for (const d of c.documents) {
        if (placedDocs.has(d.id) || (d.sensitivity === 'personal' && !personal)) continue
        await add(`Unfiled records/${safe(d.fileName)}`, d, {
          step: 'Unfiled records',
          month: d.period ? monthName(d.period) : '',
        })
      }
      files[`${root}/Budget.csv`] = strToU8(
        csv([
          ['Category', 'Report line', 'Amount', 'Narrative'],
          ...c.budgetLines.map((b) => [
            budgetItemsOf(c.workspace).find((i) => i.key === b.category)?.label ?? b.category,
            b.reportLine,
            Number(b.amount).toFixed(2),
            b.narrative ?? '',
          ]),
        ])
      )
      files[`${root}/Months.csv`] = strToU8(
        csv([
          [
            'Month',
            'Status',
            'Due',
            'Submitted',
            'Prepared by',
            'Month-end closing approved by',
            'Month-end closing approved',
            'Closing note',
            'Last sent back because',
            'Comments',
            'Final',
          ],
          ...c.monthlyReports.map((r) => [
            r.period,
            r.status,
            day(r.dueDate),
            r.submittedAt ? day(r.submittedAt) : '',
            r.preparedByName ?? '',
            r.authorizedByName ?? '',
            r.authorizedAt ? day(r.authorizedAt) : '',
            r.closingNote ?? '',
            r.sentBackReason ?? '',
            r.comments ?? '',
            r.isFinal ? 'yes' : 'no',
          ]),
        ])
      )
      files[`${root}/Checks.csv`] = strToU8(
        csv([
          ['Month', 'Code', 'Severity', 'Source', 'Message', 'Status', 'Resolution', 'Resolved'],
          ...c.monthlyReports.flatMap((r) =>
            r.checks.map((k) => [
              r.period,
              k.code,
              k.severity,
              k.source,
              k.message,
              k.status,
              k.resolution ?? '',
              k.resolvedAt ? day(k.resolvedAt) : '',
            ])
          ),
        ])
      )
    }

    // Which marks the package's copies will carry, worked out now so the README says only what is drawn: a statement
    // with marks is read once here and again when it is written (a month has one or two). The deletion export keeps
    // the originals, so it reads none here.
    const notDrawn = new Map<string, StatementMark[]>()
    if (!options.complete)
      for (const [key, ms] of marks) {
        const marked = await markPdf(new Uint8Array(await this.storage.read(key)), ms)
        if (marked.notDrawn.length) notDrawn.set(key, marked.notDrawn)
      }

    const readme = [
      `AUDIT PACKAGE: ${c.name}${c.number ? ` (${c.number})` : ''}`,
      `Workspace: ${c.workspace.name}`,
      `Funder: ${c.funder ?? 'not named'}`,
      `Period: ${c.periodStart ? day(c.periodStart) : '?'} to ${c.periodEnd ? day(c.periodEnd) : '?'}`,
      `Award: ${c.awardAmount == null ? 'not received' : money(Number(c.awardAmount))}`,
      `Prepared by: ${c.preparerName ?? '?'}${c.preparerOrganization ? `, ${c.preparerOrganization}` : ''}`,
      `Authorized by: ${c.authorizerName ?? '?'}${c.authorizerOrganization ? `, ${c.authorizerOrganization}` : ''}`,
      `Generated ${new Date().toISOString()} by ${staffName(caller)} from Audit Differently.`,
      '',
      'WHAT IS INSIDE',
      '  Letter to the auditors   the cover letter for this audit, if one was added',
      '  Engagement records/      the proposal, award letter, budget narrative and contract, numbered by step',
      '  Months/                  one folder per month of the contract, named with the amount billed:',
      '                             Signed report: the monthly financial report as submitted;',
      '                             Earlier submissions and Reopenings.csv, for a month reopened to correct it:',
      '                             each signed copy submitted before, and when, by whom and why it was reopened;',
      '                             Ledger.csv: every line billed that month, with the files behind it;',
      '                             Program Costs: one file per line and proof, named item, vendor, amount, date;',
      '                             Proof of Purchase - Bank Statements: each statement once, for the lines it backs,',
      notDrawn.size
        ? '                             with each payroll payment it proves highlighted where it could be drawn (see MARKED LINES NOT DRAWN);'
        : '                             with each payroll payment it proves highlighted (the stored statement is unchanged);',
      '                             Payroll and Timesheet Reports: each register and timesheet once;',
      '                             WEX Documentation: per participant paid that month, Payroll Verification',
      '                             (the pay stub or other evidence of payment) and Payroll.csv with the figures',
      '  Participants.csv         every participant: id, name, enrollment status, current status, file status',
      personal
        ? '  Participant Eligibility and Enrollment Forms/  one folder per participant with each item of this'
        : '  Participant eligibility files are personal records and are not in this copy; an owner or auditor',
      personal
        ? "                           program's checklist, read beside the payroll verification above"
        : '                           of the workspace can produce a package that holds them.',
      '  Other records/           anything else the team kept with this engagement',
      '  Index.csv                every file in this package with its step, month, item, purpose and amount',
      ...(options.complete
        ? [
            '  Unfiled records/         records kept with this engagement that no step above reaches',
            "  Budget.csv, Months.csv, Checks.csv  the approved budget, each month's status and month-end closing,",
            '                           and every check finding with how it was resolved',
            '',
            'This is the full copy taken before the engagement was deleted.',
          ]
        : []),
      '',
      ...(ENGAGEMENT_TRACKS.some((t) => !c.tracks.includes(t))
        ? [
            'NOT KEPT IN AUDIT DIFFERENTLY FOR THIS ENGAGEMENT',
            ...ENGAGEMENT_TRACKS.filter((t) => !c.tracks.includes(t)).map(
              (t) => `  ${ENGAGEMENT_TRACK_LABELS[t]}`
            ),
            '',
          ]
        : []),
      ...(notDrawn.size
        ? [
            'MARKED LINES NOT DRAWN',
            ...[...notDrawn].flatMap(([key, ms]) => [
              ...objects.filter((o) => o[1] === key).map((o) => `  ${o[0].slice(root.length + 1)}`),
              `    ${NOT_DRAWN}`,
              ...ms.map((m) => `      ${markPlace(m)}`),
            ]),
            '',
          ]
        : []),
      ...(reopened.length ? ['MONTHS REOPENED AFTER THEY WERE SUBMITTED', ...reopened, ''] : []),
      'RECORDS THAT DO NOT EXIST FOR THIS ENGAGEMENT',
      ...(Object.keys(waivers).length
        ? Object.entries(waivers).map(([k, v]) => `  ${k}: ${v}`)
        : ['  none declared']),
      '',
    ].join('\n')
    files[`${root}/README.txt`] = strToU8(readme)
    files[`${root}/Index.csv`] = strToU8(csv(index))

    return {
      name: `${root} - audit package.zip`,
      subject: c.name,
      workspaceId: c.workspaceId,
      engagementId: c.id,
      text: files,
      objects,
      files: count,
      personal,
      personalPaths,
      marks,
      notDrawn,
    }
  }

  /**
   * A stored object for the package: a bank statement with marked lines as a highlighted copy, else as stored. A
   * statement the plan found it cannot mark (encrypted, damaged) goes in as stored, and the README says so. Should a
   * copy carry fewer marks than the README was written for, the download fails rather than claim them.
   */
  private async object(plan: PackagePlan, key: string): Promise<Uint8Array> {
    const bytes = new Uint8Array(await this.storage.read(key))
    const marks = plan.marks?.get(key)
    if (!marks?.length || plan.notDrawn?.has(key)) return bytes
    const marked = await markPdf(bytes, marks)
    if (marked.notDrawn.length) {
      this.logger.error('A statement could not be marked as its plan said it would be')
      throw new Error('A marked statement changed while the package was made')
    }
    return marked.bytes
  }

  /** The package as bytes in memory (the download button): fine for a small engagement. */
  async build(
    caller: Caller,
    engagementId: string
  ): Promise<{ name: string; bytes: Buffer; files: number; personal: boolean }> {
    const p = await this.plan(caller, engagementId)
    const files: Zippable = { ...p.text }
    for (const [path, key] of p.objects) files[path] = await this.object(p, key)
    const bytes = zipSync(files, { level: 6 })
    await this.log.log(caller, {
      workspaceId: p.workspaceId,
      resource: 'export',
      subjectId: p.engagementId,
      action: 'export',
      description: exportWords(p.subject, p.files, p.personalPaths.size > 0),
    })
    return { name: p.name, bytes: Buffer.from(bytes), files: p.files, personal: p.personal }
  }

  /** The planned package as zip chunks, one stored object in memory at a time. */
  stream(plan: PackagePlan): AsyncGenerator<Uint8Array> {
    const entries: [string, ZipSource][] = [
      ...Object.entries(plan.text),
      ...plan.objects.map(([path, key]): [string, ZipSource] => [
        path,
        () => this.object(plan, key),
      ]),
    ]
    return zipEntries(entries)
  }

  /** How the plan splits into parts (one part unless it holds more than about 1.5 GB of files). */
  parts(plan: PackagePlan): PartLayout[] {
    return splitParts(plan)
  }

  /** Part `n` of the layout as zip chunks, one stored object in memory at a time. */
  streamPart(plan: PackagePlan, layouts: PartLayout[], n: number): AsyncGenerator<Uint8Array> {
    return streamPart(plan, layouts, n, (key) => this.object(plan, key))
  }

  /**
   * The audit package download is logged as an export, once per part. A part's line counts that part's own files,
   * and says "personal records included" only when that part holds one.
   */
  async logExport(
    caller: Caller,
    plan: PackagePlan,
    part?: { layout: PartLayout; total: number }
  ): Promise<void> {
    const paths = part ? part.layout.paths : plan.objects.map(([path]) => path)
    await this.log.log(caller, {
      workspaceId: plan.workspaceId,
      resource: 'export',
      subjectId: plan.engagementId,
      action: 'export',
      description: exportWords(
        plan.subject,
        paths.length,
        paths.some((p) => plan.personalPaths.has(p)),
        part && `part ${part.layout.n} of ${part.total}`
      ),
    })
  }
}

/** The export's line: whose package, which part, how many files, and whether a personal record is among them. */
const exportWords = (subject: string, files: number, personal: boolean, part?: string) =>
  `Downloaded the audit package of ${subject}${part ? ` (${part})` : ''}: ${howMany(files, 'file')}${personal ? ', personal records included' : ''}`

/** What `plan` works out: the text files made, and the stored objects to fetch, each at its path in the zip. */
export interface PackagePlan {
  name: string
  subject: string
  workspaceId: string
  engagementId: string
  text: Record<string, Uint8Array>
  objects: ExportObject[]
  files: number
  /** Whether the caller's role may see personal records (the README says which copy this is). */
  personal: boolean
  /** The paths of the personal records the package actually holds. */
  personalPaths: Set<string>
  /**
   * The marked payroll lines of each bank statement, by storage key: the audit package draws them on its copy. The
   * deletion export reads the stored objects itself, so it keeps the originals.
   */
  marks?: Map<string, StatementMark[]>
  /** The marks that cannot be drawn on a statement's copy (encrypted or damaged), by storage key; that copy is as stored. */
  notDrawn?: Map<string, StatementMark[]>
}
