import { Inject, Injectable, NotFoundException } from '@nestjs/common'
import { strToU8, zipSync, type Zippable } from 'fflate'
import {
  DOCUMENT_PURPOSE_LABELS,
  PERSONAL_DOCUMENT_ROLES,
  type DocumentPurpose,
  type Role,
} from '@ad/types'
import { AccessLogService } from '../core/access-log.service'
import { keyInWorkspace } from '../documents/documents.service'
import { eligibilityItemsOf } from './eligibility'
import { tenantWhere, workspaceRole, type Caller } from '../core/caller'
import { PrismaService } from '../prisma/prisma.service'
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
const safe = (s: string) =>
  s
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
const ext = (fileName: string) => {
  const i = fileName.lastIndexOf('.')
  return i > 0 ? fileName.slice(i).toLowerCase() : ''
}
const money = (n: number) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const day = (d: Date) => d.toISOString().slice(0, 10)
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
const csv = (rows: (string | number)[][]) =>
  rows.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n')

type Doc = {
  id: string
  storageKey: string
  fileName: string
  kind: string
  uploadedAt: Date
  workspaceId: string
  engagementId: string | null
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly log: AccessLogService,
    @Inject(DOCUMENT_STORAGE) private readonly storage: DocumentStorage
  ) {}

  async build(
    caller: Caller,
    engagementId: string
  ): Promise<{ name: string; bytes: Buffer; files: number; personal: boolean }> {
    const c = await this.prisma.engagement.findFirst({
      where: { id: engagementId, ...tenantWhere(caller) },
      include: {
        workspace: true,
        documents: { orderBy: { uploadedAt: 'asc' } },
        monthlyReports: {
          orderBy: { period: 'asc' },
          include: {
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
    const files: Zippable = {}
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
      files[path] = new Uint8Array(await this.storage.read(doc.storageKey))
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
      const signed = c.documents.find((d) => d.kind === 'signed-report' && d.period === r.period)
      if (signed)
        await add(`${folder}/Signed report - ${safe(signed.fileName)}`, signed, {
          step: '07 Signed report',
          month,
        })
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

    const readme = [
      `AUDIT PACKAGE: ${c.name}${c.number ? ` (${c.number})` : ''}`,
      `Workspace: ${c.workspace.name}`,
      `Funder: ${c.funder ?? 'not named'}`,
      `Period: ${c.periodStart ? day(c.periodStart) : '?'} to ${c.periodEnd ? day(c.periodEnd) : '?'}`,
      `Award: ${c.awardAmount == null ? 'not received' : money(Number(c.awardAmount))}`,
      `Prepared by: ${c.preparerName ?? '?'}${c.preparerOrganization ? `, ${c.preparerOrganization}` : ''}`,
      `Authorized by: ${c.authorizerName ?? '?'}${c.authorizerOrganization ? `, ${c.authorizerOrganization}` : ''}`,
      `Generated ${new Date().toISOString()} by ${caller.displayName} from Audit Differently.`,
      '',
      'WHAT IS INSIDE',
      '  Letter to the auditors   the cover letter for this audit, if one was added',
      '  Engagement records/      the proposal, award letter, budget narrative and contract, numbered by step',
      '  Months/                  one folder per month of the contract, named with the amount billed:',
      '                             Signed report: the monthly financial report as submitted;',
      '                             Ledger.csv: every line billed that month, with the files behind it;',
      '                             Program Costs: one file per line and proof, named item, vendor, amount, date;',
      '                             Proof of Purchase - Bank Statements: each statement once, for the lines it backs;',
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
      '',
      'RECORDS THAT DO NOT EXIST FOR THIS ENGAGEMENT',
      ...(Object.keys(waivers).length
        ? Object.entries(waivers).map(([k, v]) => `  ${k}: ${v}`)
        : ['  none declared']),
      '',
    ].join('\n')
    files[`${root}/README.txt`] = strToU8(readme)
    files[`${root}/Index.csv`] = strToU8(csv(index))

    const bytes = zipSync(files, { level: 6 })
    await this.log.log(caller, {
      workspaceId: c.workspaceId,
      resource: 'export',
      subjectId: c.id,
      action: 'export',
      detail: `audit package, ${count} files${personal ? ', personal records included' : ''}`,
    })
    return {
      name: `${root} - audit package.zip`,
      bytes: Buffer.from(bytes),
      files: count,
      personal,
    }
  }
}
