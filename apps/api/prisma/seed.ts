import '../scripts/lib/owner-env'
import { Prisma, PrismaClient } from '@prisma/client'
import { createHash } from 'node:crypto'
import 'reflect-metadata'
import {
  DOCUMENT_SENSITIVITY,
  type DocumentKind,
  type EligibilityItem,
  DEFAULT_FUNDING_SOURCES,
} from '@ad/types'
import { refreshChecks } from '../src/checks/checks.service'
import { LocalDiskStorage } from '../src/storage/local-disk-storage'
import { R2DocumentStorage } from '../src/storage/r2-storage'
import { dueDate } from '../src/checks/rules'
import { simplePdf } from './pdf'

/**
 * Two fictional workspaces, three months of one workspace's ledger (approved, submitted, and a
 * draft with real problems to fix), participants with eligibility files, and the demo personas. Nothing here
 * comes from a real document (CLAUDE.md, "Data rules"). Idempotent: re-running updates the same rows.
 * Runs as the owner (SCHEMA_DATABASE_URL via scripts/lib/owner-env.ts).
 */
const prisma = new PrismaClient()
// The fixture files go where the API will read them from: the private bucket when one is configured
// (the dev environment), else apps/api/storage on this disk.
const store = process.env.R2_DOCUMENTS_BUCKET ? new R2DocumentStorage() : new LocalDiskStorage()
const d = (s: string) => new Date(`${s}T00:00:00Z`)

async function main() {
  const workspace = async (name: string) =>
    (await prisma.workspace.findFirst({ where: { name } })) ??
    prisma.workspace.create({ data: { name, fundingSources: DEFAULT_FUNDING_SOURCES } })
  const riverbend = await workspace('Riverbend Youth Services')
  const harbor = await workspace('Harbor Tech Collective')
  const FUNDER = 'Demo Workforce Board'

  // ── People ──
  // Placeholder rows, the way an invitation makes them: the first Clerk sign-in with the same email takes
  // over the memberships (me.controller.ts). Sam's seat is the project's test account in the dev Clerk instance,
  // so signing in as it opens Riverbend as its owner; create the other three in the dev Clerk instance to walk
  // the rest of the demo.
  const ownerEmail = 'test@chowworks.com'
  const people: { id: string; name: string; email: string; role: string; workspaceId: string }[] = [
    {
      id: 'pending-demo-dana',
      name: 'Dana Okafor',
      email: 'dana.okafor@riverbend.example',
      role: 'bookkeeper',
      workspaceId: riverbend.id,
    },
    {
      id: 'pending-demo-sam',
      name: 'Sam Whitfield',
      email: ownerEmail,
      role: 'owner',
      workspaceId: riverbend.id,
    },
    {
      id: 'pending-demo-jules',
      name: 'Jules Park',
      email: 'jules.park@riverbend.example',
      role: 'auditor',
      workspaceId: riverbend.id,
    },
    {
      id: 'pending-demo-lee',
      name: 'Lee Tanaka',
      email: 'lee.tanaka@harbortech.example',
      role: 'bookkeeper',
      workspaceId: harbor.id,
    },
  ]
  for (const p of people) {
    // Already claimed by a real account, by email or by the seat itself: leave that account alone and plant
    // no placeholder beside it (a re-run of the seed leaves a claimed seat alone).
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
    if (claimedByEmail || seatTaken) continue
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
  // Who prepares and who authorizes the monthly report; the authorizer also signs the letter to the auditors.
  const SIGNERS: Record<string, Record<string, string>> = {
    [riverbend.id]: {
      preparerName: 'Dana Okafor',
      preparerOrganization: 'Riverbend Youth Services',
      authorizerName: 'Sam Whitfield',
      authorizerOrganization: 'Riverbend Youth Services',
    },
    [harbor.id]: {
      preparerName: 'Lee Tanaka',
      preparerOrganization: 'Harbor Tech Collective',
      authorizerName: 'Lee Tanaka',
      authorizerOrganization: 'Harbor Tech Collective',
    },
  }
  const engagement = async (
    workspaceId: string,
    number: string,
    kind: 'grant' | 'contract',
    name: string,
    fundingSources: string[],
    award: number,
    budget: [string, string, number, string][]
  ) => {
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
      fundingSources,
      periodStart: d('2026-07-01'),
      periodEnd: d('2027-06-30'),
      reportDueDay: 12,
      indirectTerms:
        'No indirect cost rate approved. All costs direct, or allocated by a documented driver.',
      reportTo: 'Contract specialist, Demo Workforce Board (contracts@demo-board.example)',
      submissionMethod: 'Email, one PDF with both signatures',
      ...SIGNERS[workspaceId],
      status: 'active',
    }
    const c = await prisma.engagement.upsert({
      where: { workspaceId_number: { workspaceId, number } },
      update: data,
      create: { workspaceId, number, ...data },
    })
    for (const [i, [category, reportLine, amount, narrative]] of budget.entries())
      await prisma.budgetLine.upsert({
        where: { engagementId_category: { engagementId: c.id, category } },
        update: { reportLine, amount, narrative, sortOrder: i },
        create: { engagementId: c.id, category, reportLine, amount, narrative, sortOrder: i },
      })
    return c
  }
  const rys = await engagement(
    riverbend.id,
    'DEMO-26IS-RYS',
    'grant',
    'In-School Youth Coding Pathway',
    ['Youth Workforce Fund'],
    125000,
    [
      ['personnel', 'staff-salaries', 0, 'N/A'],
      ['fringe', 'staff-fringe', 0, 'N/A'],
      ['travel', 'program-costs', 1500, 'Mileage for school site visits.'],
      ['equipment', 'program-costs', 0, 'N/A'],
      ['supplies', 'program-costs', 6000, 'Laptops and lab supplies.'],
      ['contractual', 'program-costs', 24000, 'Bookkeeping and payroll services.'],
      [
        'participant-training',
        'program-costs',
        78500,
        'Instruction, classroom rent share, certification vouchers.',
      ],
      ['other', 'program-costs', 0, 'N/A'],
      ['indirect', 'indirect', 0, 'Not claimed.'],
      ['wex', 'wex', 15000, 'Paid work experience, 8 youth, 10 hours a week.'],
    ]
  )
  const htc = await engagement(
    harbor.id,
    'DEMO-26IS-HTC',
    'contract',
    'Out-of-School Youth IT Support',
    ['Adult Training Fund'],
    90000,
    [
      ['supplies', 'program-costs', 3000, 'Lab supplies.'],
      ['contractual', 'program-costs', 12000, 'Bookkeeping.'],
      ['participant-training', 'program-costs', 60000, 'Instruction and certification.'],
      ['indirect', 'indirect', 0, 'Not claimed.'],
      ['wex', 'wex', 15000, 'Paid work experience.'],
    ]
  )

  // ── Participants ──
  const participant = async (
    engagementId: string,
    pid: string,
    name: string,
    enrollmentStatus: string
  ) =>
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
  const jordan = await participant(rys.id, '900001', 'Jordan Sample', 'new')
  const riley = await participant(rys.id, '900002', 'Riley Example', 'carryover')
  const casey = await participant(rys.id, '900003', 'Casey Demo', 'new')
  await participant(htc.id, '900101', 'Taylor Placeholder', 'new')

  // ── Documents (small fictional PDFs) ──
  const doc = async (
    workspaceId: string,
    engagementId: string,
    period: string | null,
    kind: DocumentKind,
    slug: string,
    fileName: string,
    lines: string[]
  ) => {
    const storageKey = `${workspaceId}/${engagementId}/${period ?? 'general'}/seed-${slug}.pdf`
    const bytes = simplePdf([
      ...lines,
      '',
      'Fictional document generated for the Audit Differently demo.',
    ])
    await store.upload(storageKey, bytes, 'application/pdf')
    return prisma.document.upsert({
      where: { storageKey },
      update: {
        fileName,
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
      create: {
        workspaceId,
        engagementId,
        kind,
        sensitivity: DOCUMENT_SENSITIVITY[kind],
        fileName,
        contentType: 'application/pdf',
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        storageKey,
        period,
        uploadedById: 'demo-dana',
      },
    })
  }

  // ── The grant's own records: the steps before the first month, and the signed monthly reports ──
  const stage = (
    workspaceId: string,
    engagementId: string,
    number: string,
    kind: DocumentKind,
    fileName: string,
    lines: string[]
  ) => doc(workspaceId, engagementId, null, kind, `${number}-${kind}`, fileName, lines)
  await stage(riverbend.id, rys.id, 'rys', 'proposal', 'Riverbend proposal FY27.pdf', [
    'Proposal: In-School Youth Coding Pathway',
    'Submitted by email, 2026-03-14',
    'Requested budget: $160,000.00',
  ])
  await stage(riverbend.id, rys.id, 'rys', 'award-letter', 'Award letter DEMO-26IS-RYS.pdf', [
    'Award letter, 2026-05-02',
    'Program: In-School Youth Coding Pathway',
    'Award: $125,000.00 (requested $160,000.00)',
  ])
  await stage(
    riverbend.id,
    rys.id,
    'rys',
    'budget-narrative',
    'Budget narrative DEMO-26IS-RYS.pdf',
    [
      'Budget narrative, completed 2026-05-20',
      'One line per approved budget category, as the funder form asks.',
    ]
  )
  await stage(riverbend.id, rys.id, 'rys', 'contract', 'Contract DEMO-26IS-RYS signed.pdf', [
    'Sub-recipient agreement DEMO-26IS-RYS, signed 2026-06-18',
    'Period: 2026-07-01 to 2027-06-30',
    'Approved budget: $125,000.00',
  ])
  for (const period of ['2026-07', '2026-08']) {
    await doc(
      riverbend.id,
      rys.id,
      period,
      'signed-report',
      `rys-signed-${period}`,
      `Monthly financial report ${period} signed.pdf`,
      [
        `Monthly financial report for ${period}`,
        'Signed by Sam Whitfield, authorized representative',
      ]
    )
  }
  // Harbor Tech has the award and the contract on file, but not the proposal or the narrative.
  await stage(harbor.id, htc.id, 'htc', 'award-letter', 'Award letter DEMO-26IS-HTC.pdf', [
    'Award letter, 2026-05-02',
    'Program: Out-of-School Youth IT Support',
  ])
  await stage(harbor.id, htc.id, 'htc', 'contract', 'Contract DEMO-26IS-HTC signed.pdf', [
    'Sub-recipient agreement DEMO-26IS-HTC, signed 2026-06-18',
  ])

  // ── Months ──
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
    docs: ('invoice' | 'payment' | 'allocation' | 'timesheet' | 'register')[]
  }
  type Extra = {
    submittedAt?: Date
    preparedByName?: string
    authorizedByName?: string
    authorizedAt?: Date
    reviewedById?: string
    reviewedAt?: Date
    review?: Prisma.InputJsonValue
  }
  const month = async (
    engagementId: string,
    workspaceId: string,
    period: string,
    status: string,
    lines: Line[],
    extra: Extra = {}
  ) => {
    const report = await prisma.monthlyReport.upsert({
      where: { engagementId_period: { engagementId, period } },
      update: { status, ...extra },
      create: { engagementId, period, status, dueDate: dueDate(period, 12), ...extra },
    })
    const statement = await doc(
      workspaceId,
      engagementId,
      period,
      'bank-statement',
      `stmt-${period}`,
      `${period} Bank Statement.pdf`,
      [
        `Bank statement, ${period}`,
        'Riverbend Youth Services, operating account ending 4471',
        ...lines
          .filter((l) => l.docs.includes('payment'))
          .map((l) => `${l.date}  ${l.vendor}  -$${l.total.toFixed(2)}`),
      ]
    )
    for (const l of lines) {
      const e = await prisma.expense.upsert({
        where: {
          engagementId_itemNumber_reportLine: {
            engagementId,
            itemNumber: l.item,
            reportLine: l.line,
          },
        },
        update: {},
        create: {
          engagementId,
          monthlyReportId: report.id,
          itemNumber: l.item,
          date: d(l.date),
          vendor: l.vendor,
          memo: l.memo,
          account: l.account,
          totalCost: l.total,
          allocatedAmount: l.allocated,
          allocationType: l.type,
          allocationNote: l.note,
          reportLine: l.line,
          createdById: 'demo-dana',
        },
      })
      const attach = async (documentId: string, purpose: string) =>
        prisma.expenseDocument.upsert({
          where: { expenseId_documentId: { expenseId: e.id, documentId } },
          update: { purpose },
          create: { expenseId: e.id, documentId, purpose },
        })
      if (l.docs.includes('invoice')) {
        const inv = await doc(
          workspaceId,
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
            'Bill to: Riverbend Youth Services',
          ]
        )
        await attach(inv.id, 'invoice')
      }
      if (l.docs.includes('payment')) await attach(statement.id, 'payment')
      if (l.docs.includes('allocation')) {
        const alloc = await doc(
          workspaceId,
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
      if (l.docs.includes('timesheet')) {
        const ts = await doc(
          workspaceId,
          engagementId,
          period,
          'timesheet',
          `${l.item}-timesheet`,
          `${l.item} timesheets.pdf`,
          [
            `Work experience timesheets, ${period}`,
            'Jordan Sample: 20.0 hours, approved by site supervisor',
            'Riley Example: 16.0 hours, approved by site supervisor',
            'Casey Demo: 20.0 hours, approved by site supervisor',
          ]
        )
        await attach(ts.id, 'timesheet')
      }
      if (l.docs.includes('register')) {
        const reg = await doc(
          workspaceId,
          engagementId,
          period,
          'payroll-register',
          `${l.item}-register`,
          `${l.item} payroll register.pdf`,
          [
            `Payroll register, ${period}, work experience`,
            `Gross wages this period: $${l.total.toFixed(2)}`,
            'Jordan Sample, Riley Example, Casey Demo',
          ]
        )
        await attach(reg.id, 'register')
      }
    }
    return { report, statement }
  }

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
  })
  const wex = (item: string, date: string, total: number, docs: Line['docs']): Line => ({
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
  })

  // July: approved, complete.
  const july = await month(
    rys.id,
    riverbend.id,
    '2026-07',
    'approved',
    [
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
      },
    ],
    {
      submittedAt: d('2026-08-10'),
      preparedByName: 'Dana Okafor',
      authorizedByName: 'Sam Whitfield',
      authorizedAt: d('2026-08-10'),
      reviewedById: 'demo-sam',
      reviewedAt: d('2026-08-14'),
      review: {
        receivedOn: '2026-08-10',
        newServicesEntered: true,
        newEnrollmentsEntered: true,
        servicesInProgress: true,
        caseNotesChecked: true,
        fileReviewCompleted: true,
        siteVisitConducted: false,
        invoiceNumber: 'IV-26-0412',
      },
    }
  )
  // August: submitted, the funder's decision not recorded yet.
  await month(
    rys.id,
    riverbend.id,
    '2026-08',
    'submitted',
    [
      accounting('RYS-6', '2026-08-03', 570, '19.0%'),
      rent('RYS-7', '2026-08-14', 612),
      wex('RYS-8', '2026-08-28', 1680, ['timesheet', 'register', 'payment']),
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
      },
    ],
    {
      submittedAt: d('2026-09-11'),
      preparedByName: 'Dana Okafor',
      authorizedByName: 'Sam Whitfield',
      authorizedAt: d('2026-09-11'),
    }
  )
  // September: the draft with problems, due tomorrow.
  const sept = await month(rys.id, riverbend.id, '2026-09', 'draft', [
    { ...accounting('RYS-11', '2026-09-02', 555, '18.5%'), docs: ['invoice', 'payment'] },
    rent('RYS-12', '2026-09-15', 630),
    wex('RYS-13', '2026-09-25', 2240, ['timesheet', 'register']),
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
    },
  ])
  // Unattached September documents the preparer will attach in the demo.
  await doc(
    riverbend.id,
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

  // Work experience detail for September.
  const payroll = await prisma.document.findFirst({
    where: { storageKey: `${riverbend.id}/2026-09/seed-RYS-13-register.pdf` },
  })
  const timesheets = await prisma.document.findFirst({
    where: { storageKey: `${riverbend.id}/2026-09/seed-RYS-13-timesheet.pdf` },
  })
  for (const [p, hours, gross] of [
    [jordan, 20, 280],
    [riley, 16, 224],
    [casey, 20, 280],
  ] as const) {
    const existing = await prisma.wexPayment.findFirst({
      where: { monthlyReportId: sept.report.id, participantId: p.id },
    })
    const w =
      existing ??
      (await prisma.wexPayment.create({
        data: {
          monthlyReportId: sept.report.id,
          participantId: p.id,
          payPeriodStart: d('2026-09-07'),
          payPeriodEnd: d('2026-09-20'),
          hours,
          grossAmount: gross,
        },
      }))
    const stub = await doc(
      riverbend.id,
      rys.id,
      '2026-09',
      'paystub',
      `stub-${p.participantId}`,
      `${p.displayName} pay stub 2026-09.pdf`,
      [
        `Pay stub: ${p.displayName}`,
        'Pay period 2026-09-07 to 2026-09-20',
        `Hours: ${hours}`,
        `Gross: $${gross.toFixed(2)}`,
        'Deposited to account ending 2210',
      ]
    )
    for (const [documentId, purpose] of [
      [stub.id, 'payment'],
      [payroll?.id, 'register'],
      [timesheets?.id, 'timesheet'],
    ] as const) {
      if (!documentId) continue
      await prisma.wexPaymentDocument.upsert({
        where: { wexPaymentId_documentId: { wexPaymentId: w.id, documentId } },
        update: { purpose },
        create: { wexPaymentId: w.id, documentId, purpose },
      })
    }
  }

  // Eligibility files: Jordan and Casey complete, Riley short.
  const eligibility = async (
    p: { id: string; participantId: string; displayName: string },
    items: EligibilityItem[]
  ) => {
    for (const item of items) {
      const file = await doc(
        riverbend.id,
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

  // Harbor Tech: one draft month, so the second workspace has something of its own.
  await month(htc.id, harbor.id, '2026-09', 'draft', [
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
  ])

  // Checks for every report, and a little access history.
  for (const r of await prisma.monthlyReport.findMany({ select: { id: true } }))
    await refreshChecks(prisma, r.id)
  if ((await prisma.dataAccessLog.count()) === 0) {
    await prisma.dataAccessLog.createMany({
      data: [
        {
          workspaceId: riverbend.id,
          actorId: 'demo-dana',
          actorName: 'Dana Okafor',
          resource: 'report',
          subjectId: july.report.id,
          action: 'submit',
          detail: '2026-07',
          createdAt: d('2026-08-10'),
        },
        {
          workspaceId: riverbend.id,
          actorId: 'demo-sam',
          actorName: 'Morgan Reyes',
          resource: 'document',
          subjectId: july.statement.id,
          action: 'read',
          detail: 'bank-statement 2026-07 Bank Statement.pdf',
          createdAt: d('2026-08-13'),
        },
        {
          workspaceId: riverbend.id,
          actorId: 'demo-sam',
          actorName: 'Morgan Reyes',
          resource: 'report',
          subjectId: july.report.id,
          action: 'review',
          detail: 'approve 2026-07',
          createdAt: d('2026-08-14'),
        },
      ],
    })
  }

  console.log(
    `Seeded Riverbend (3 months, 3 participants) and Harbor Tech (1 month). Personas: ${people.map((p) => p.id).join(', ')}`
  )
}

export const seed = main

if (require.main === module) {
  main()
    .catch((e) => {
      console.error(e)
      process.exit(1)
    })
    .finally(() => prisma.$disconnect())
}
