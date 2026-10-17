import '../scripts/lib/owner-env'
import { Prisma, PrismaClient } from '@prisma/client'
import { createHash } from 'node:crypto'
import 'reflect-metadata'
import {
  DOCUMENT_SENSITIVITY,
  type DocumentKind,
  type EligibilityItem,
  DEFAULT_TAG_TYPES,
  type StatementMark,
} from '@ad/types'
import { refreshChecks } from '../src/checks/checks.service'
import { LocalDiskStorage } from '../src/storage/local-disk-storage'
import { R2DocumentStorage } from '../src/storage/r2-storage'
import { dueDate } from '../src/checks/rules'
import type { ProofItem } from '../src/payroll/match-proof'
import { simplePdf } from './pdf'
import {
  bankStatementPdf,
  highlightFields,
  ProofReader,
  registerPdf,
  stubPdf,
  timesheetPdf,
  type BankRow,
  type PayRun,
} from './demo-payroll'

/**
 * The fictional demo. `seedDemoWorkspace` makes one workspace, Riverbend Youth Services, with its engagement
 * DEMO-26IS-RYS: three months (July and August submitted, August reopened once and corrected; September a draft with
 * real problems to fix), payroll proof highlighted the way "Match payroll & timecards" saves it, receipts matched,
 * a saved import mapping, tags, participants with eligibility files, and the demo personas. It is the only part
 * that may run in production (`scripts/demo-seed.ts`), and it refuses a workspace that is not the demo.
 * `main` (the dev seed, `db:seed` and `demo:reset`) adds a second workspace, Harbor Tech, and the emailed-receipts
 * queue, and never runs in production. Nothing here comes from a real document (CLAUDE.md, "Data rules").
 * Idempotent: re-running puts the same rows back in their starting shape. Runs as the owner (SCHEMA_DATABASE_URL
 * via scripts/lib/owner-env.ts).
 */
const prisma = new PrismaClient()
// The fixture files go where the API will read them from: the private bucket when one is configured
// (the dev and production environments), else apps/api/storage on this disk.
const store = process.env.R2_DOCUMENTS_BUCKET ? new R2DocumentStorage() : new LocalDiskStorage()
const d = (s: string) => new Date(`${s}T00:00:00Z`)

export const DEMO_WORKSPACE_NAME = 'Riverbend Youth Services'
export const DEMO_RECEIPTS_ADDRESS = 'riverbend-youth'
export const DEMO_ENGAGEMENT_PREFIX = 'DEMO-'
const FUNDER = 'Demo Workforce Board'
const FOOTER = 'Fictional document generated for the Audit Differently demo.'

export const isProduction = () =>
  process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT_NAME === 'production'

type Ws = { id: string; name: string }
type Person = { id: string; name: string; email: string; role: string; workspaceId: string }

// ── People ──
// Placeholder rows, the way an invitation makes them: the first Clerk sign-in with the same verified email takes
// over the memberships (me.controller.ts). A seat already claimed by a real account is left alone.
async function seat(p: Person) {
  const claimedByEmail = await prisma.user.findFirst({
    where: {
      email: { equals: p.email, mode: 'insensitive' },
      NOT: { id: { startsWith: 'pending-' } },
    },
  })
  const seatTaken = await prisma.membership.findFirst({
    where: {
      workspaceId: p.workspaceId,
      role: p.role,
      NOT: { userId: { startsWith: 'pending-' } },
    },
  })
  if (claimedByEmail || seatTaken) return
  await prisma.user.upsert({
    where: { id: p.id },
    update: { displayName: p.name, email: p.email },
    create: { id: p.id, displayName: p.name, email: p.email },
  })
  await prisma.membership.upsert({
    where: { userId_workspaceId: { userId: p.id, workspaceId: p.workspaceId } },
    update: { role: p.role },
    create: { userId: p.id, workspaceId: p.workspaceId, role: p.role },
  })
}

// ── Engagements and budgets ──
async function engagement(
  ws: Ws,
  number: string,
  kind: 'grant' | 'contract',
  name: string,
  tags: string[],
  award: number,
  signers: Record<string, string>,
  budget: [string, string, number, string][]
) {
  const data = {
    kind,
    name,
    funder: FUNDER,
    funderContact: 'grants@demo-board.example',
    solicitation: 'FY27 Youth Programs RFP (demo)',
    requestedAmount: Math.round(award * 1.28),
    proposalSubmittedOn: d('2026-03-14'),
    awardedOn: d('2026-05-02'),
    awardAmount: award,
    tags,
    periodStart: d('2026-07-01'),
    periodEnd: d('2027-06-30'),
    reportDueDay: 12,
    indirectTerms:
      'No indirect cost rate approved. All costs direct, or allocated by a documented driver.',
    reportTo: 'Contract specialist, Demo Workforce Board (contracts@demo-board.example)',
    submissionMethod: 'Email, one PDF with both signatures',
    ...signers,
    status: 'active',
  }
  const c = await prisma.engagement.upsert({
    where: { workspaceId_number: { workspaceId: ws.id, number } },
    update: data,
    create: { workspaceId: ws.id, number, ...data },
  })
  for (const [i, [category, reportLine, amount, narrative]] of budget.entries())
    await prisma.budgetLine.upsert({
      where: { engagementId_category: { engagementId: c.id, category } },
      update: { reportLine, amount, narrative, sortOrder: i },
      create: { engagementId: c.id, category, reportLine, amount, narrative, sortOrder: i },
    })
  return c
}

const participant = (engagementId: string, pid: string, name: string, enrollmentStatus: string) =>
  prisma.participant.upsert({
    where: { engagementId_participantId: { engagementId, participantId: pid } },
    update: { displayName: name, enrollmentStatus },
    create: {
      engagementId,
      participantId: pid,
      displayName: name,
      enrollmentStatus,
      enrolledAt: d('2026-07-06'),
    },
  })

// ── Documents ──
// Small fictional PDFs: plain lines (simplePdf), or the bytes a demo generator drew (demo-payroll.ts).
async function doc(
  ws: Ws,
  engagementId: string,
  period: string | null,
  kind: DocumentKind,
  slug: string,
  fileName: string,
  content: string[] | Buffer,
  more: { uploadedAt?: Date; receipt?: { amount: number; date: string; vendor: string } } = {}
) {
  const storageKey = `${ws.id}/${engagementId}/${period ?? 'general'}/seed-${slug}.pdf`
  const bytes = Buffer.isBuffer(content) ? content : simplePdf([...content, '', FOOTER])
  await store.upload(storageKey, bytes, 'application/pdf')
  const receipt = more.receipt
    ? {
        receiptAmount: more.receipt.amount,
        receiptDate: d(more.receipt.date),
        receiptVendor: more.receipt.vendor,
        receiptReadBy: 'text',
      }
    : {}
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const row = await prisma.document.upsert({
    where: { storageKey },
    update: { fileName, size: bytes.length, sha256, ...receipt, ...when(more.uploadedAt) },
    create: {
      workspaceId: ws.id,
      engagementId,
      kind,
      sensitivity: DOCUMENT_SENSITIVITY[kind],
      fileName,
      contentType: 'application/pdf',
      size: bytes.length,
      sha256,
      storageKey,
      period,
      uploadedById: 'demo-dana',
      ...receipt,
      ...when(more.uploadedAt),
    },
  })
  return { ...row, bytes }
}
const when = (at?: Date) => (at ? { uploadedAt: at } : {})

type Marks = { mark: StatementMark | null; marks: StatementMark[] }
const json = (m: Marks | undefined) => ({
  marks: (m?.marks ?? []) as object[],
})

const linkExpense = (expenseId: string, documentId: string, purpose: string, m?: Marks) =>
  prisma.expenseDocument.upsert({
    where: { expenseId_documentId: { expenseId, documentId } },
    update: { purpose, mark: (m?.mark as object | undefined) ?? Prisma.DbNull, ...json(m) },
    create: {
      expenseId,
      documentId,
      purpose,
      ...(m?.mark ? { mark: m.mark as object } : {}),
      ...json(m),
    },
  })

const linkWex = (wexPaymentId: string, documentId: string, purpose: string, m?: Marks) =>
  prisma.wexPaymentDocument.upsert({
    where: { wexPaymentId_documentId: { wexPaymentId, documentId } },
    update: { purpose, mark: (m?.mark as object | undefined) ?? Prisma.DbNull, ...json(m) },
    create: {
      wexPaymentId,
      documentId,
      purpose,
      ...(m?.mark ? { mark: m.mark as object } : {}),
      ...json(m),
    },
  })

// ── Months ──
type Proof = 'invoice' | 'payment' | 'allocation' | 'timesheet' | 'register'
type Line = {
  item: string
  date: string
  vendor: string
  memo: string
  account: string
  total: number
  allocated: number
  type: 'direct' | 'payroll' | 'usage'
  note?: string
  line: string
  docs: Proof[]
  /** How the bank statement words it, when the line is on it but not (yet) linked to it, or worded its own way. */
  bank?: string
  tags?: string[]
}
type Extra = {
  submittedAt?: Date
  preparedByName?: string
  authorizedByName?: string
  authorizedAt?: Date
  closingNote?: string
}
type ParticipantRow = { id: string; participantId: string; displayName: string; tags: string[] }
/** A participant's pay in the ledger, and which of its proofs are linked (the pay stub is filed either way). */
type Wex = {
  p: ParticipantRow
  hours: number
  gross: number
  proofs: ('timesheet' | 'register' | 'payment')[]
}
type MonthPlan = {
  status: string
  lines: Line[]
  extra?: Extra
  /** The month's pay run: its timesheet, register and pay stubs are drawn by demo-payroll.ts and highlighted. */
  run?: PayRun
  wex?: Wex[]
  /** Statement rows that are no expense of this engagement (a deposit, taxes, fees). */
  bankExtra?: BankRow[]
}
const PAYROLL_LINES = new Set(['staff-salaries', 'staff-fringe', 'wex'])

async function month(
  ws: Ws,
  engagementId: string,
  period: string,
  plan: MonthPlan,
  reader: ProofReader
) {
  // A draft while its lines go in: the database refuses a line in a closed or submitted month (migration
  // 20261015001100_month_lock). The month takes its status at the end.
  let report = await prisma.monthlyReport.upsert({
    where: { engagementId_period: { engagementId, period } },
    update: { status: 'draft' },
    create: { engagementId, period, status: 'draft', dueDate: dueDate(period, 12) },
  })
  const { run, lines } = plan
  const paidOn = (l: Line) => (run && PAYROLL_LINES.has(l.line) ? run.debitDate : l.date)
  const statement = await doc(
    ws,
    engagementId,
    period,
    'bank-statement',
    `stmt-${period}`,
    `${period} Bank Statement.pdf`,
    await bankStatementPdf(ws.name, period, [
      ...lines
        .filter((l) => l.docs.includes('payment') || l.bank)
        .map((l) => ({
          date: paidOn(l),
          description: l.bank ?? `ACH DEBIT ${l.vendor.toUpperCase()}`,
          out: l.total,
        })),
      ...(plan.bankExtra ?? []),
    ])
  )
  // The pay run's own files, shared by every payroll item of the month.
  const runDocs = run
    ? {
        timesheet: await doc(
          ws,
          engagementId,
          period,
          'timesheet',
          `payroll-${period}-timesheet`,
          `Time and jobs report ${run.start} to ${run.end}.pdf`,
          await timesheetPdf(run)
        ),
        register: await doc(
          ws,
          engagementId,
          period,
          'payroll-register',
          `payroll-${period}-register`,
          `${run.runId} payroll register.pdf`,
          await registerPdf(run)
        ),
      }
    : null

  for (const l of lines) {
    const data = {
      monthlyReportId: report.id,
      date: d(l.date),
      vendor: l.vendor,
      memo: l.memo,
      account: l.account,
      totalCost: l.total,
      allocatedAmount: l.allocated,
      allocationType: l.type,
      allocationNote: l.note ?? null,
      tags: l.tags ?? [],
    }
    const e = await prisma.expense.upsert({
      where: {
        engagementId_itemNumber_reportLine: {
          engagementId,
          itemNumber: l.item,
          reportLine: l.line,
        },
      },
      update: data,
      create: {
        engagementId,
        itemNumber: l.item,
        reportLine: l.line,
        createdById: 'demo-dana',
        ...data,
      },
    })
    // A staff payroll line as the matcher sees it: its amount near its date (match-proof.ts).
    const proofItem: ProofItem = {
      target: 'expense',
      id: e.id,
      kind: 'staff',
      name: null,
      amount: l.total,
      start: l.date,
      end: l.date,
    }
    const kept: string[] = []
    const attach = async (documentId: string, purpose: string, m?: Marks) => {
      kept.push(documentId)
      await linkExpense(e.id, documentId, purpose, m)
    }
    if (l.docs.includes('invoice')) {
      const inv = await doc(
        ws,
        engagementId,
        period,
        'invoice',
        `${l.item}-invoice`,
        `${l.item} ${l.vendor} invoice.pdf`,
        [
          `Invoice from ${l.vendor}`,
          `Date: ${l.date}`,
          `Description: ${l.memo}`,
          `Amount due: $${l.total.toFixed(2)}`,
          `Bill to: ${ws.name}`,
        ],
        // Read from the receipt's own text when it was uploaded, then matched to this line (Match receipts).
        { receipt: { amount: l.total, date: l.date, vendor: l.vendor } }
      )
      await attach(inv.id, 'invoice')
    }
    if (l.docs.includes('payment'))
      await attach(
        statement.id,
        'payment',
        await reader.marks(proofItem, 'bank', {
          fileName: statement.fileName,
          bytes: statement.bytes,
        })
      )
    if (l.docs.includes('allocation')) {
      const alloc = await doc(
        ws,
        engagementId,
        period,
        'allocation-calculation',
        `${l.item}-allocation`,
        `${l.item} allocation worksheet.pdf`,
        [
          `Allocation worksheet: ${l.vendor}, ${l.date}`,
          `Method: ${l.type === 'payroll' ? 'share of payroll hours' : 'share of room-hours'} for ${period}`,
          `Total expense: $${l.total.toFixed(2)}`,
          `${l.note ?? ''}`,
          `Program share: $${l.allocated.toFixed(2)}`,
        ]
      )
      await attach(alloc.id, 'allocation')
    }
    for (const slot of ['timesheet', 'register'] as const) {
      if (!l.docs.includes(slot)) continue
      if (runDocs)
        await attach(
          runDocs[slot].id,
          slot,
          await reader.marks(proofItem, slot, {
            fileName: runDocs[slot].fileName,
            bytes: runDocs[slot].bytes,
          })
        )
      else {
        // A month without a drawn pay run (July): the plain one-page files of the first seed.
        const file = await doc(
          ws,
          engagementId,
          period,
          slot === 'timesheet' ? 'timesheet' : 'payroll-register',
          `${l.item}-${slot}`,
          `${l.item} ${slot === 'timesheet' ? 'timesheets' : 'payroll register'}.pdf`,
          slot === 'timesheet'
            ? [
                `Work experience timesheets, ${period}`,
                'Jordan Sample: 20.0 hours, approved by site supervisor',
                'Riley Example: 16.0 hours, approved by site supervisor',
                'Casey Demo: 20.0 hours, approved by site supervisor',
              ]
            : [
                `Payroll register, ${period}, work experience`,
                `Gross wages this period: $${l.total.toFixed(2)}`,
                'Jordan Sample, Riley Example, Casey Demo',
              ]
        )
        await attach(file.id, slot)
      }
    }
    // The seed decides a payroll line's proof: a link a demo visitor made is put back to the starting shape.
    if (PAYROLL_LINES.has(l.line))
      await prisma.expenseDocument.deleteMany({
        where: {
          expenseId: e.id,
          purpose: { in: ['timesheet', 'register', 'payment'] },
          documentId: { notIn: kept },
        },
      })
  }

  // Each participant's pay: the ledger's amount, the run's timesheet and register, and their own pay stub.
  for (const w of plan.wex ?? []) {
    if (!run || !runDocs)
      throw new Error(`${period}: work-experience pay needs the month's pay run`)
    const line = run.lines.find((x) => x.name === w.p.displayName)
    if (!line) throw new Error(`${period}: ${w.p.displayName} is not on the pay run`)
    const data = {
      payPeriodStart: d(run.start),
      payPeriodEnd: d(run.end),
      hours: w.hours,
      grossAmount: w.gross,
      tags: w.p.tags.filter((t) => t.startsWith('age-group:')),
    }
    const existing = await prisma.wexPayment.findFirst({
      where: { monthlyReportId: report.id, participantId: w.p.id },
    })
    const pay = existing
      ? await prisma.wexPayment.update({ where: { id: existing.id }, data })
      : await prisma.wexPayment.create({
          data: { monthlyReportId: report.id, participantId: w.p.id, ...data },
        })
    const stub = await doc(
      ws,
      engagementId,
      period,
      'paystub',
      `stub-${w.p.participantId}`,
      `${w.p.displayName} pay stub ${period}.pdf`,
      await stubPdf(run, line)
    )
    const item: ProofItem = {
      target: 'wex',
      id: pay.id,
      kind: 'participant',
      name: w.p.displayName,
      amount: w.gross,
      start: run.start,
      end: run.end,
    }
    const files = {
      timesheet: { slot: 'timesheet' as const, file: runDocs.timesheet },
      register: { slot: 'register' as const, file: runDocs.register },
      payment: { slot: 'stub' as const, file: stub },
    }
    const kept: string[] = []
    for (const purpose of w.proofs) {
      const { slot, file } = files[purpose]
      kept.push(file.id)
      await linkWex(
        pay.id,
        file.id,
        purpose,
        await reader.marks(item, slot, { fileName: file.fileName, bytes: file.bytes })
      )
    }
    await prisma.wexPaymentDocument.deleteMany({
      where: { wexPaymentId: pay.id, documentId: { notIn: kept } },
    })
  }

  report = await prisma.monthlyReport.update({
    where: { id: report.id },
    data: { status: plan.status, ...plan.extra },
  })
  return { report, statement }
}

/**
 * The demo workspace: found by its name and receipts address, or made (marked `featuredDemo` from its first row).
 * Refuses (throws) when either finds a workspace that is not plainly the demo: two of them, one not marked
 * `featuredDemo` (a workspace an admin made for a real customer of that name), a different name or receipts address,
 * or an engagement whose number does not start with DEMO-. So in production this can only ever touch the demo.
 */
async function demoWorkspace(): Promise<Ws & { receiptsAddress: string | null }> {
  const found = await prisma.workspace.findMany({
    where: { OR: [{ name: DEMO_WORKSPACE_NAME }, { receiptsAddress: DEMO_RECEIPTS_ADDRESS }] },
    include: { engagements: { select: { number: true } } },
  })
  if (found.length > 1)
    throw new Error(
      `${found.length} workspaces are named "${DEMO_WORKSPACE_NAME}" or use the receipts address "${DEMO_RECEIPTS_ADDRESS}"; the demo seed changes none of them`
    )
  const w = found[0]
  if (!w)
    return prisma.workspace.create({
      data: {
        name: DEMO_WORKSPACE_NAME,
        tagTypes: DEFAULT_TAG_TYPES as object[],
        featuredDemo: true,
      },
    })
  const foreign = w.engagements.filter((e) => !(e.number ?? '').startsWith(DEMO_ENGAGEMENT_PREFIX))
  if (!w.featuredDemo)
    throw new Error(
      `Workspace ${w.id} ("${w.name}") is not marked as the demo (featuredDemo); the demo seed leaves it alone. If it is the demo, the database owner sets its featuredDemo by hand first.`
    )
  if (
    w.name !== DEMO_WORKSPACE_NAME ||
    (w.receiptsAddress && w.receiptsAddress !== DEMO_RECEIPTS_ADDRESS) ||
    foreign.length
  )
    throw new Error(
      `Workspace ${w.id} ("${w.name}") is not the demo workspace${foreign.length ? ` (it has engagement ${foreign[0]!.number})` : ''}; the demo seed leaves it alone`
    )
  return w
}

export interface DemoOptions {
  /** Sam Whitfield's seat, the demo's owner. The dev seed: the project's test account. demo:seed: an unclaimable .example address unless DEMO_OWNER_EMAIL names one. */
  ownerEmail: string
  /** Writes one access-log line saying the fictional demo data was loaded (every demo:seed run). */
  logRun?: boolean
}

/** Riverbend Youth Services and its engagement DEMO-26IS-RYS: the one workspace the demo seed creates or updates. */
export async function seedDemoWorkspace(opts: DemoOptions): Promise<{ workspaceId: string }> {
  const riverbend = await demoWorkspace()
  const reader = new ProofReader(await highlightFields(prisma))
  const ownerEmail = opts.ownerEmail
  const ws = riverbend

  for (const p of [
    {
      id: 'pending-demo-dana',
      name: 'Dana Okafor',
      email: 'dana.okafor@riverbend.example',
      role: 'bookkeeper',
    },
    { id: 'pending-demo-sam', name: 'Sam Whitfield', email: ownerEmail, role: 'owner' },
    {
      id: 'pending-demo-jules',
      name: 'Jules Park',
      email: 'jules.park@riverbend.example',
      role: 'auditor',
    },
  ])
    await seat({ ...p, workspaceId: riverbend.id })

  const rys = await engagement(
    ws,
    'DEMO-26IS-RYS',
    'grant',
    'In-School Youth Coding Pathway',
    ['funding-source:youth-workforce-fund'],
    125000,
    {
      preparerName: 'Dana Okafor',
      preparerOrganization: DEMO_WORKSPACE_NAME,
      authorizerName: 'Sam Whitfield',
      authorizerOrganization: DEMO_WORKSPACE_NAME,
    },
    [
      ['personnel', 'staff-salaries', 18000, 'Program coordinator, half time.'],
      ['fringe', 'staff-fringe', 0, 'N/A'],
      ['travel', 'program-costs', 1500, 'Mileage for school site visits.'],
      ['equipment', 'program-costs', 0, 'N/A'],
      ['supplies', 'program-costs', 6000, 'Laptops and lab supplies.'],
      ['contractual', 'program-costs', 24000, 'Bookkeeping and payroll services.'],
      [
        'participant-training',
        'program-costs',
        60500,
        'Instruction, classroom rent share, certification vouchers.',
      ],
      ['other', 'program-costs', 0, 'N/A'],
      ['indirect', 'indirect', 0, 'Not claimed.'],
      ['wex', 'wex', 15000, 'Paid work experience, 8 youth, 10 hours a week.'],
    ]
  )

  // ── Tags ── The default Funding source type and one of Riverbend's own, and a tag or two per participant.
  await prisma.workspace.update({
    where: { id: riverbend.id },
    data: {
      // The full demo: marked "Full demo" wherever it is named (migration 20261016001600).
      featuredDemo: true,
      tagTypes: [
        ...(DEFAULT_TAG_TYPES as object[]),
        {
          key: 'age-group',
          label: 'Age group',
          appliesTo: ['payroll', 'participant'],
          values: [
            { key: 'under-18', label: 'Under 18' },
            { key: '18-to-24', label: '18 to 24' },
          ],
        },
      ],
    },
  })
  const tag = (id: string, tags: string[]) =>
    prisma.participant.update({ where: { id }, data: { tags } })
  const youth = 'funding-source:youth-workforce-fund'
  const jordan = await tag((await participant(rys.id, '900001', 'Jordan Sample', 'new')).id, [
    youth,
    'age-group:under-18',
  ])
  const riley = await tag((await participant(rys.id, '900002', 'Riley Example', 'carryover')).id, [
    'funding-source:adult-training-fund',
    'age-group:18-to-24',
  ])
  const casey = await tag((await participant(rys.id, '900003', 'Casey Demo', 'new')).id, [
    youth,
    'age-group:under-18',
  ])

  // ── The grant's own records: the steps before the first month, and the signed monthly reports ──
  const stage = (kind: DocumentKind, fileName: string, lines: string[]) =>
    doc(ws, rys.id, null, kind, `rys-${kind}`, fileName, lines)
  await stage('proposal', 'Riverbend proposal FY27.pdf', [
    'Proposal: In-School Youth Coding Pathway',
    'Submitted by email, 2026-03-14',
    'Requested budget: $160,000.00',
  ])
  await stage('award-letter', 'Award letter DEMO-26IS-RYS.pdf', [
    'Award letter, 2026-05-02',
    'Program: In-School Youth Coding Pathway',
    'Award: $125,000.00 (requested $160,000.00)',
  ])
  await stage('budget-narrative', 'Budget narrative DEMO-26IS-RYS.pdf', [
    'Budget narrative, completed 2026-05-20',
    'One line per approved budget category, as the funder form asks.',
  ])
  await stage('contract', 'Contract DEMO-26IS-RYS signed.pdf', [
    'Sub-recipient agreement DEMO-26IS-RYS, signed 2026-06-18',
    'Period: 2026-07-01 to 2027-06-30',
    'Approved budget: $125,000.00',
  ])
  const signed = (period: string, slug: string, fileName: string, at: string, note: string) =>
    doc(
      ws,
      rys.id,
      period,
      'signed-report',
      slug,
      fileName,
      [
        `Monthly financial report for ${period}`,
        'Signed by Sam Whitfield, authorized representative',
        note,
      ],
      { uploadedAt: d(at) }
    )
  await signed(
    '2026-07',
    'rys-signed-2026-07',
    'Monthly financial report 2026-07 signed.pdf',
    '2026-08-10',
    ''
  )
  // August went in on 09/11, was reopened on 09/14 to correct the mileage line, and went in again on 09/15.
  const augFirst = await signed(
    '2026-08',
    'rys-signed-2026-08',
    'Monthly financial report 2026-08 signed.pdf',
    '2026-09-11',
    ''
  )
  await signed(
    '2026-08',
    'rys-signed-2026-08-corrected',
    'Monthly financial report 2026-08 signed (corrected).pdf',
    '2026-09-15',
    'Corrected copy: mileage line RYS-9'
  )

  // ── Months ──
  const accounting = (item: string, date: string, allocated: number, pct: string): Line => ({
    item,
    date,
    vendor: 'Ledger & Co. Bookkeeping',
    memo: 'Monthly accounting services',
    account: '60701 Accounting Fees',
    total: 3000,
    allocated,
    type: 'payroll',
    note: `${pct} of payroll hours`,
    line: 'program-costs',
    docs: ['invoice', 'payment', 'allocation'],
    tags: [youth],
  })
  const rent = (item: string, date: string, allocated: number): Line => ({
    item,
    date,
    vendor: 'Harbor Community Building',
    memo: 'Classroom rent',
    account: '60901 Rent Expense',
    total: 3600,
    allocated,
    type: 'usage',
    note: 'Room-hours share',
    line: 'program-costs',
    docs: ['invoice', 'payment', 'allocation'],
    tags: [youth],
  })
  const wex = (item: string, date: string, total: number, docs: Proof[], run?: PayRun): Line => ({
    item,
    date,
    vendor: 'PayPeople Payroll',
    memo: 'Work experience wages',
    account: '63103 Salaries - WEX',
    total,
    allocated: total,
    type: 'direct',
    line: 'wex',
    docs,
    ...(run ? { bank: `ACH DEBIT PAYPEOPLE WEX WAGES ${run.runId}` } : {}),
    tags: [youth],
  })
  const staff = (item: string, run: PayRun, docs: Proof[]): Line => ({
    item,
    date: run.payDate,
    vendor: 'PayPeople Payroll',
    memo: `Program coordinator wages, pay period ${run.start} to ${run.end}`,
    account: '60100 Salaries - Staff',
    total: 1500,
    allocated: 1500,
    type: 'direct',
    line: 'staff-salaries',
    docs,
    bank: `ACH DEBIT PAYPEOPLE STAFF WAGES ${run.runId}`,
    tags: [youth],
  })
  const payrollRows = (run: PayRun): BankRow[] => [
    {
      date: run.debitDate,
      description: `ACH DEBIT PAYPEOPLE EMPLOYER TAX ${run.runId}`,
      out: run.employerTaxes,
    },
    { date: run.payDate, description: `ACH DEBIT PAYPEOPLE FEES ${run.runId}`, out: run.fees },
  ]
  const coordinator = { name: 'Morgan Reyes', empNo: '801', group: 'Staff' as const, hours: 40 }

  // July: closing approved, submitted, complete.
  const july = await month(
    ws,
    rys.id,
    '2026-07',
    {
      status: 'submitted',
      lines: [
        accounting('RYS-1', '2026-07-02', 540, '18.0%'),
        rent('RYS-2', '2026-07-15', 648),
        {
          item: 'RYS-3',
          date: '2026-07-20',
          vendor: 'CertVouchers Inc.',
          memo: 'Three certification exam vouchers',
          account: '63500 Training Materials',
          total: 285,
          allocated: 285,
          type: 'direct',
          line: 'program-costs',
          docs: ['invoice', 'payment'],
          tags: [youth],
        },
        wex('RYS-4', '2026-07-29', 1120, ['timesheet', 'register', 'payment']),
        {
          item: 'RYS-5',
          date: '2026-07-08',
          vendor: 'Northline Computers',
          memo: 'Four student laptops',
          account: '63400 Program Supplies',
          total: 2400,
          allocated: 2400,
          type: 'direct',
          line: 'program-costs',
          docs: ['invoice', 'payment'],
          tags: [youth],
        },
      ],
      extra: {
        submittedAt: d('2026-08-10'),
        preparedByName: 'Dana Okafor',
        authorizedByName: 'Sam Whitfield',
        authorizedAt: d('2026-08-07'),
        closingNote: 'Approved at the monthly finance meeting',
      },
    },
    reader
  )

  // August: a complete month with its payroll proof highlighted; closing approved, submitted, reopened once, corrected
  // and submitted again.
  const augRun: PayRun = {
    runId: 'RUN-2026-0828',
    start: '2026-08-10',
    end: '2026-08-23',
    payDate: '2026-08-28',
    debitDate: '2026-08-25',
    employerTaxes: 179.01,
    fees: 12,
    lines: [
      { ...coordinator, gross: 1500 },
      { name: 'Jordan Sample', empNo: '901', group: 'Work experience', hours: 20, gross: 280 },
      { name: 'Riley Example', empNo: '902', group: 'Work experience', hours: 18, gross: 252 },
      { name: 'Casey Demo', empNo: '903', group: 'Work experience', hours: 22, gross: 308 },
    ],
  }
  const all = ['timesheet', 'register', 'payment'] as const
  const aug = await month(
    ws,
    rys.id,
    '2026-08',
    {
      status: 'submitted',
      run: augRun,
      lines: [
        accounting('RYS-6', '2026-08-03', 570, '19.0%'),
        rent('RYS-7', '2026-08-14', 612),
        wex('RYS-8', augRun.payDate, 840, ['timesheet', 'register', 'payment'], augRun),
        {
          item: 'RYS-9',
          date: '2026-08-21',
          vendor: 'Dana Okafor (mileage)',
          memo: 'Site visits, 161 miles at $0.70',
          account: '62100 Travel',
          total: 112.7,
          allocated: 112.7,
          type: 'direct',
          line: 'program-costs',
          docs: ['invoice', 'payment'],
          bank: 'ACH DEBIT MILEAGE REIMB D OKAFOR',
          tags: [youth],
        },
        {
          item: 'RYS-10',
          date: '2026-08-05',
          vendor: 'Coursely Business',
          memo: 'Course licenses, 10 seats',
          account: '63500 Training Materials',
          total: 180,
          allocated: 180,
          type: 'direct',
          line: 'program-costs',
          docs: ['invoice', 'payment'],
          tags: ['funding-source:adult-training-fund'],
        },
        staff('RYS-17', augRun, ['timesheet', 'register', 'payment']),
      ],
      wex: [
        { p: jordan, hours: 20, gross: 280, proofs: [...all] },
        { p: riley, hours: 18, gross: 252, proofs: [...all] },
        { p: casey, hours: 22, gross: 308, proofs: [...all] },
      ],
      bankExtra: [
        { date: '2026-08-14', description: 'ACH CREDIT DEMO WORKFORCE BOARD REIMB', in: 4993 },
        ...payrollRows(augRun),
      ],
      extra: {
        submittedAt: d('2026-09-15'),
        preparedByName: 'Dana Okafor',
        authorizedByName: 'Sam Whitfield',
        authorizedAt: d('2026-09-15'),
        closingNote: 'Approved again after the mileage correction',
      },
    },
    reader
  )
  // What the reopening undid (append-only; one row, added once).
  if (!(await prisma.reportReopening.findFirst({ where: { monthlyReportId: aug.report.id } })))
    await prisma.reportReopening.create({
      data: {
        monthlyReportId: aug.report.id,
        reopenedAt: new Date('2026-09-14T15:20:00Z'),
        reopenedById: 'demo-dana',
        reopenedByEmail: 'dana.okafor@riverbend.example',
        reason: 'The mileage line RYS-9 was entered as $116.10; the mileage log says $112.70.',
        submittedAt: d('2026-09-11'),
        approvedByName: 'Sam Whitfield',
        approvedAt: d('2026-09-09'),
        signedDocumentId: augFirst.id,
      },
    })

  // September: the draft with problems, due on the 12th. Its pay run is half matched: Jordan's pay is fully proved;
  // Riley's pay stub is on file but not linked; Casey's pay was entered as $300.00 where the stub says $280.00; the
  // coordinator's wages have no bank line linked yet (Unmatched payments).
  const sepRun: PayRun = {
    runId: 'RUN-2026-0925',
    start: '2026-09-07',
    end: '2026-09-20',
    payDate: '2026-09-25',
    debitDate: '2026-09-22',
    employerTaxes: 174.73,
    fees: 12,
    lines: [
      { ...coordinator, gross: 1500 },
      { name: 'Jordan Sample', empNo: '901', group: 'Work experience', hours: 20, gross: 280 },
      { name: 'Riley Example', empNo: '902', group: 'Work experience', hours: 16, gross: 224 },
      { name: 'Casey Demo', empNo: '903', group: 'Work experience', hours: 20, gross: 280 },
    ],
  }
  const sept = await month(
    ws,
    rys.id,
    '2026-09',
    {
      status: 'draft',
      run: sepRun,
      lines: [
        { ...accounting('RYS-11', '2026-09-02', 555, '18.5%'), docs: ['invoice', 'payment'] },
        rent('RYS-12', '2026-09-15', 630),
        wex('RYS-13', sepRun.payDate, 784, ['timesheet', 'register', 'payment'], sepRun),
        {
          item: 'RYS-14',
          date: '2026-09-30',
          vendor: 'Riverbend Youth Services',
          memo: '10% General & Administrative on program costs',
          account: '69000 G&A',
          total: 118.5,
          allocated: 118.5,
          type: 'direct',
          line: 'program-costs',
          docs: [],
        },
        {
          item: 'RYS-15',
          date: '2026-09-18',
          vendor: 'CertPath Testing',
          memo: 'Certification exam, one participant',
          account: '63500 Training Materials',
          total: 84,
          allocated: 84,
          type: 'direct',
          line: 'program-costs',
          docs: ['invoice'],
          // Paid by card and on the statement, but the statement is not linked yet.
          bank: 'DEBIT CARD CERTPATH TESTING',
          tags: [youth],
        },
        {
          item: 'RYS-16',
          date: '2026-09-09',
          vendor: 'Northline Computers',
          memo: 'Lab furniture, two workbenches',
          account: '63400 Program Supplies',
          total: 5200,
          allocated: 5200,
          type: 'direct',
          line: 'program-costs',
          docs: ['invoice', 'payment'],
          tags: [youth],
        },
        staff('RYS-18', sepRun, ['timesheet', 'register']),
        {
          item: 'RYS-19',
          date: '2026-09-04',
          vendor: 'Bright Path Office Supply',
          memo: 'Lab cables and storage bins',
          account: '63400 Program Supplies',
          total: 212.18,
          allocated: 212.18,
          type: 'direct',
          line: 'program-costs',
          docs: ['payment'],
          bank: 'DEBIT CARD BRIGHT PATH OFFICE SUPPLY',
          tags: [youth],
        },
      ],
      wex: [
        { p: jordan, hours: 20, gross: 280, proofs: [...all] },
        { p: riley, hours: 16, gross: 224, proofs: ['timesheet', 'register'] },
        { p: casey, hours: 20, gross: 300, proofs: [...all] },
      ],
      bankExtra: [
        { date: '2026-09-14', description: 'ACH CREDIT DEMO WORKFORCE BOARD REIMB', in: 3814.7 },
        ...payrollRows(sepRun),
        { date: '2026-09-30', description: 'SERVICE CHARGE', out: 12 },
      ],
    },
    reader
  )
  // Unattached September documents the preparer will attach in the demo: the accounting allocation, and a receipt read
  // from its text that Match receipts offers for RYS-19.
  await doc(
    ws,
    rys.id,
    '2026-09',
    'allocation-calculation',
    'RYS-11-allocation',
    'RYS-11 allocation worksheet.pdf',
    [
      'Allocation worksheet: Ledger & Co. Bookkeeping, 2026-09-02',
      'Method: share of payroll hours for 2026-09',
      'Total expense: $3000.00',
      '18.5% of payroll hours',
      'Program share: $555.00',
    ]
  )
  await doc(
    ws,
    rys.id,
    '2026-09',
    'receipt',
    'bright-path-receipt',
    'Bright Path Office Supply receipt.pdf',
    [
      'Bright Path Office Supply',
      'Receipt 40912, 2026-09-04',
      'Cables and storage bins',
      'Total: $212.18',
      'Paid by debit card ending 0000',
    ],
    { receipt: { amount: 212.18, date: '2026-09-04', vendor: 'Bright Path Office Supply' } }
  )

  // Eligibility files: Jordan and Casey complete, Riley short.
  const eligibility = async (p: ParticipantRow, items: EligibilityItem[]) => {
    for (const item of items) {
      const file = await doc(
        ws,
        rys.id,
        null,
        item === 'enrollment-form' ? 'enrollment-form' : 'eligibility-record',
        `${p.participantId}-${item}`,
        `${p.displayName} ${item}.pdf`,
        [
          `${item.replace(/-/g, ' ')}: ${p.displayName}`,
          `Participant ${p.participantId}`,
          'Fictional eligibility record.',
        ]
      )
      await prisma.participantDocument.upsert({
        where: { participantId_documentId: { participantId: p.id, documentId: file.id } },
        update: { purpose: item },
        create: { participantId: p.id, documentId: file.id, purpose: item },
      })
    }
  }
  await eligibility(jordan, [
    'enrollment-form',
    'proof-of-age',
    'right-to-work',
    'school-status',
    'income-eligibility',
    'iss-plan',
  ])
  await eligibility(casey, [
    'enrollment-form',
    'proof-of-age',
    'right-to-work',
    'school-status',
    'income-eligibility',
  ])
  await eligibility(riley, ['enrollment-form', 'proof-of-age'])

  // ── Import transactions ── A mapping saved from an earlier import of the bookkeeper's general-ledger export.
  const mapping = {
    headers: ['Date', 'Num', 'Name', 'Memo/Description', 'Account', 'Class', 'Amount'],
    columns: {
      date: 'Date',
      reference: 'Num',
      vendor: 'Name',
      memo: 'Memo/Description',
      account: 'Account',
      category: 'Class',
      amount: 'Amount',
    },
    categories: {
      'Program supplies': 'supplies',
      Training: 'participant-training',
      'Contract services': 'contractual',
      Travel: 'travel',
      'Payroll - staff': 'personnel',
      'Payroll - WEX': 'wex',
      'Bank fees': 'skip',
    },
  }
  await prisma.importMapping.upsert({
    where: { workspaceId_name: { workspaceId: riverbend.id, name: 'Ledger & Co. export' } },
    update: mapping,
    create: {
      workspaceId: riverbend.id,
      name: 'Ledger & Co. export',
      createdById: 'demo-dana',
      ...mapping,
    },
  })

  // ── Emailed receipts ── Riverbend's receipts address (set once, then kept) and the engagement's subject-line code.
  if (!riverbend.receiptsAddress || riverbend.receiptsAddress !== DEMO_RECEIPTS_ADDRESS)
    await prisma.workspace.update({
      where: { id: riverbend.id },
      data: { receiptsAddress: DEMO_RECEIPTS_ADDRESS },
    })
  await prisma.engagement.update({ where: { id: rys.id }, data: { code: 'RYS26' } })

  // Checks for the demo's months only, and a little access history (people named by email, as the API writes them).
  for (const r of await prisma.monthlyReport.findMany({
    where: { engagement: { workspaceId: riverbend.id } },
    select: { id: true },
  }))
    await refreshChecks(prisma, r.id)
  const line = (
    actor: 'dana' | 'sam',
    subjectId: string,
    resource: string,
    action: string,
    description: string,
    at: string,
    changes?: object[]
  ) => ({
    workspaceId: riverbend.id,
    actorId: `demo-${actor}`,
    actorName: actor === 'dana' ? 'dana.okafor@riverbend.example' : ownerEmail,
    resource,
    subjectId,
    action,
    description,
    ...(changes ? { changes } : {}),
    createdAt: new Date(at),
  })
  const program = 'In-School Youth Coding Pathway'
  if ((await prisma.dataAccessLog.count({ where: { workspaceId: riverbend.id } })) === 0)
    await prisma.dataAccessLog.createMany({
      data: [
        line(
          'dana',
          july.report.id,
          'report',
          'review',
          `Approved the month-end closing of July 2026 for ${program}`,
          '2026-08-07T16:00:00Z',
          [
            { field: 'Status', before: 'draft', after: 'closed' },
            { field: 'Approved by' },
            { field: 'Approved on', before: null, after: '2026-08-07' },
            { field: 'Note' },
          ]
        ),
        line(
          'dana',
          july.report.id,
          'report',
          'submit',
          `Submitted July 2026 of ${program} to ${FUNDER}`,
          '2026-08-10T15:00:00Z',
          [{ field: 'Status', before: 'closed', after: 'submitted' }]
        ),
        line(
          'sam',
          july.statement.id,
          'document',
          'read',
          'Opened a bank statement for July 2026',
          '2026-08-13T14:00:00Z'
        ),
        line(
          'dana',
          aug.report.id,
          'report',
          'submit',
          `Submitted August 2026 of ${program} to ${FUNDER}`,
          '2026-09-11T15:00:00Z',
          [{ field: 'Status', before: 'closed', after: 'submitted' }]
        ),
        line(
          'dana',
          aug.report.id,
          'report',
          'update',
          `Reopened August 2026 of ${program} to correct it`,
          '2026-09-14T15:20:00Z',
          [{ field: 'Status', before: 'submitted', after: 'draft' }, { field: 'Reason' }]
        ),
        line(
          'dana',
          aug.report.id,
          'report',
          'submit',
          `Submitted August 2026 of ${program} to ${FUNDER}`,
          '2026-09-15T16:00:00Z',
          [{ field: 'Status', before: 'closed', after: 'submitted' }]
        ),
        line(
          'dana',
          sept.report.id,
          'report',
          'update',
          'Saved the payroll match for September 2026: 6 files filed, 13 proofs linked',
          '2026-10-02T13:30:00Z'
        ),
      ],
    })
  if (opts.logRun)
    await prisma.dataAccessLog.create({
      data: {
        workspaceId: riverbend.id,
        actorId: 'demo-seed',
        actorName: 'demo seed script (database owner)',
        resource: 'workspace',
        subjectId: riverbend.id,
        action: 'update',
        description: 'Loaded the fictional demo data for this workspace (demo:seed)',
      },
    })
  return { workspaceId: riverbend.id }
}

/** The dev seed: the demo workspace, plus Harbor Tech and the emailed-receipts queue. Never in production. */
async function main() {
  if (isProduction())
    throw new Error(
      'The dev seed never runs in production. To load the demo workspace there, use scripts/demo-seed.ts (docs/dev-api.md).'
    )
  // Sam's seat is the project's test account in the dev Clerk instance, so signing in as it opens Riverbend as its
  // owner; create the other people in the dev Clerk instance to walk the rest of the demo.
  const { workspaceId: riverbendId } = await seedDemoWorkspace({ ownerEmail: 'test@chowworks.com' })
  const reader = new ProofReader(await highlightFields(prisma))

  // Harbor Tech: one draft month, so the second workspace has something of its own.
  const harbor =
    (await prisma.workspace.findFirst({ where: { name: 'Harbor Tech Collective' } })) ??
    (await prisma.workspace.create({
      data: { name: 'Harbor Tech Collective', tagTypes: DEFAULT_TAG_TYPES as object[] },
    }))
  await seat({
    id: 'pending-demo-lee',
    name: 'Lee Tanaka',
    email: 'lee.tanaka@harbortech.example',
    role: 'bookkeeper',
    workspaceId: harbor.id,
  })
  const htc = await engagement(
    harbor,
    'DEMO-26IS-HTC',
    'contract',
    'Out-of-School Youth IT Support',
    ['funding-source:adult-training-fund'],
    90000,
    {
      preparerName: 'Lee Tanaka',
      preparerOrganization: 'Harbor Tech Collective',
      authorizerName: 'Lee Tanaka',
      authorizerOrganization: 'Harbor Tech Collective',
    },
    [
      ['supplies', 'program-costs', 3000, 'Lab supplies.'],
      ['contractual', 'program-costs', 12000, 'Bookkeeping.'],
      ['participant-training', 'program-costs', 60000, 'Instruction and certification.'],
      ['indirect', 'indirect', 0, 'Not claimed.'],
      ['wex', 'wex', 15000, 'Paid work experience.'],
    ]
  )
  await participant(htc.id, '900101', 'Taylor Placeholder', 'new')
  // Harbor Tech has the award and the contract on file, but not the proposal or the narrative.
  await doc(
    harbor,
    htc.id,
    null,
    'award-letter',
    'htc-award-letter',
    'Award letter DEMO-26IS-HTC.pdf',
    ['Award letter, 2026-05-02', 'Program: Out-of-School Youth IT Support']
  )
  await doc(harbor, htc.id, null, 'contract', 'htc-contract', 'Contract DEMO-26IS-HTC signed.pdf', [
    'Sub-recipient agreement DEMO-26IS-HTC, signed 2026-06-18',
  ])
  const htcSept = await month(
    harbor,
    htc.id,
    '2026-09',
    {
      status: 'draft',
      lines: [
        {
          item: 'HTC-1',
          date: '2026-09-04',
          vendor: 'Ledger & Co. Bookkeeping',
          memo: 'Monthly accounting',
          account: '60701 Accounting Fees',
          total: 1200,
          allocated: 1200,
          type: 'direct',
          line: 'program-costs',
          docs: ['invoice', 'payment'],
        },
        {
          item: 'HTC-2',
          date: '2026-09-22',
          vendor: 'TechCred Council',
          memo: 'A+ exam vouchers',
          account: '63500 Training Materials',
          total: 756,
          allocated: 756,
          type: 'direct',
          line: 'program-costs',
          docs: ['invoice'],
        },
      ],
    },
    reader
  )
  await refreshChecks(prisma, htcSept.report.id)
  await prisma.engagement.update({ where: { id: htc.id }, data: { code: 'HTC26' } })

  // The receipts inbox: one email to file by hand, one refused, one that failed. Fictional senders and subjects only.
  // Dev only: in production these would be rows in the platform admins' Email administration that never happened.
  const rysId = (
    await prisma.engagement.findFirstOrThrow({
      where: { workspaceId: riverbendId, number: 'DEMO-26IS-RYS' },
    })
  ).id
  for (const r of [
    {
      emailId: 'demo-email-1',
      status: 'unmatched',
      fromAddress: 'dana.okafor@riverbend.example',
      subject: 'Receipt RYS26 July bus passes',
      receivedAt: new Date('2026-10-06T14:12:00Z'),
      engagementId: rysId,
      senderUserId: null,
      rejectReason: 'July 2026 of In-School Youth Coding Pathway is submitted',
      error: null,
      attempts: 1,
    },
    {
      emailId: 'demo-email-2',
      status: 'rejected',
      fromAddress: 'someone@unknown-sender.example',
      subject: 'Invoice attached',
      receivedAt: new Date('2026-10-08T09:40:00Z'),
      engagementId: null,
      senderUserId: null,
      rejectReason: 'not a member',
      error: null,
      attempts: 1,
    },
    {
      emailId: 'demo-email-3',
      status: 'failed',
      fromAddress: 'dana.okafor@riverbend.example',
      subject: 'RYS26 lab supplies',
      receivedAt: new Date('2026-10-09T16:05:00Z'),
      engagementId: null,
      senderUserId: null,
      rejectReason: null,
      error: 'The email provider answered 503',
      attempts: 5,
    },
  ])
    await prisma.inboundReceipt.upsert({
      where: { emailId: r.emailId },
      update: {},
      create: {
        ...r,
        workspaceId: riverbendId,
        toAddress: 'riverbend-youth@receipts.example.org',
      },
    })

  console.log(
    'Seeded Riverbend (3 months, 3 participants, payroll proof highlighted) and Harbor Tech (1 month). Personas: pending-demo-dana, pending-demo-sam, pending-demo-jules, pending-demo-lee'
  )
}

export const seed = main
export const disconnect = () => prisma.$disconnect()

if (require.main === module) {
  main()
    .catch((e) => {
      console.error(e)
      process.exit(1)
    })
    .finally(() => prisma.$disconnect())
}
