import { NotFoundException } from '@nestjs/common'
import { strFromU8, unzipSync } from 'fflate'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import type { Role } from '@ad/types'
import type { Caller } from '../core/caller'
import { encryptedPdf } from '../payroll/testing'
import { AuditPackageService, csv } from './audit-package.service'

/**
 * The zip is laid out the way the funder's own package is (see the README it writes). These cases pin that
 * layout: folder names, file names, the CSVs, what a statement shared by several lines does, and what a
 * bookkeeper's copy leaves out.
 */
const W = 'ws-1'
const doc = (id: string, fileName: string, kind: string, extra: Partial<Doc> = {}): Doc => ({
  id,
  workspaceId: W,
  engagementId: 'e-1',
  storageKey: `${W}/e-1/general/${id}`,
  fileName,
  kind,
  sensitivity: 'financial',
  period: null,
  uploadedAt: new Date('2026-10-01T00:00:00Z'),
  ...extra,
})
type Doc = {
  id: string
  workspaceId: string
  engagementId: string | null
  storageKey: string
  fileName: string
  kind: string
  sensitivity: string
  period: string | null
  uploadedAt: Date
}

const statement = doc('d-stmt', '2026-09 Bank Statement.pdf', 'bank-statement')
const register = doc('d-reg', 'RYS-13 payroll register.pdf', 'payroll-register')
const timesheet = doc('d-ts', 'RYS-13 timesheets.pdf', 'timesheet')
const stub = doc('d-stub', 'Jordan pay stub.pdf', 'pay-stub', { sensitivity: 'personal' })

const engagement = () => ({
  id: 'e-1',
  workspaceId: W,
  name: 'Coding Pathway',
  number: 'DEMO-1',
  funder: 'Demo Workforce Board',
  periodStart: new Date('2026-07-01T00:00:00Z'),
  periodEnd: new Date('2027-06-30T00:00:00Z'),
  awardAmount: 125000,
  preparerName: 'Dana Okafor',
  preparerOrganization: null,
  authorizerName: 'Sam Whitfield',
  authorizerOrganization: 'Riverbend Youth Services',
  tracks: ['proposal', 'award-letter', 'contract'],
  waivers: { 'budget-narrative': 'this funder does not use one' },
  eligibilityItems: [
    { key: 'enrollment-form', label: 'Enrollment form', required: true },
    { key: 'proof-of-age', label: 'Proof of age', required: true },
  ],
  workspace: { name: 'Riverbend Youth Services' },
  documents: [
    doc('d-prop', 'proposal.pdf', 'proposal'),
    doc('d-award', 'award.pdf', 'award-letter'),
    doc('d-contract', 'contract.pdf', 'contract'),
    doc('d-letter', 'to the auditors.pdf', 'audit-letter'),
    doc('d-memo', 'memo.pdf', 'other'),
    doc('d-signed', 'signed Sep.pdf', 'signed-report', { period: '2026-09' }),
  ],
  budgetLines: [],
  monthlyReports: [
    {
      period: '2026-09',
      reopenings: [] as object[],
      expenses: [
        {
          itemNumber: 'RYS-11',
          date: new Date('2026-09-02T00:00:00Z'),
          vendor: 'Ledger & Co.',
          memo: 'Monthly accounting',
          account: '60701',
          totalCost: 3000,
          allocatedAmount: 555,
          allocationType: 'payroll',
          allocationNote: '18.5% of payroll hours',
          reportLine: 'program-costs',
          documents: [
            { purpose: 'invoice', document: doc('d-inv11', 'inv 11.pdf', 'invoice') },
            { purpose: 'payment', document: statement },
            {
              purpose: 'allocation',
              document: doc('d-alloc11', 'alloc 11.xlsx', 'allocation-calculation'),
            },
          ],
        },
        {
          itemNumber: 'RYS-16',
          date: new Date('2026-09-09T00:00:00Z'),
          vendor: 'Northline Computers',
          memo: null,
          account: null,
          totalCost: 5200,
          allocatedAmount: 5200,
          allocationType: 'direct',
          allocationNote: null,
          reportLine: 'program-costs',
          documents: [
            { purpose: 'invoice', document: doc('d-inv16', 'inv 16.pdf', 'invoice') },
            { purpose: 'payment', document: statement },
          ],
        },
        {
          itemNumber: 'RYS-13',
          date: new Date('2026-09-25T00:00:00Z'),
          vendor: 'PayPeople Payroll',
          memo: 'Work experience wages',
          account: '63103',
          totalCost: 280,
          allocatedAmount: 280,
          allocationType: 'direct',
          allocationNote: null,
          reportLine: 'wex',
          documents: [
            { purpose: 'timesheet', document: timesheet },
            { purpose: 'register', document: register },
          ],
        },
      ],
      wexPayments: [
        {
          payPeriodStart: new Date('2026-09-07T00:00:00Z'),
          payPeriodEnd: new Date('2026-09-20T00:00:00Z'),
          hours: 20,
          grossAmount: 280,
          participant: { displayName: 'Jordan Sample', participantId: '900001' },
          documents: [
            { purpose: 'timesheet', document: timesheet },
            { purpose: 'register', document: register },
            { purpose: 'payment', document: stub },
          ],
        },
      ],
    },
  ],
  participants: [
    {
      participantId: '900001',
      displayName: 'Jordan Sample',
      enrollmentStatus: 'new',
      currentStatus: 'active',
      documents: [
        {
          purpose: 'enrollment-form',
          document: doc('d-enr', 'Jordan enrollment.pdf', 'enrollment-form', {
            sensitivity: 'personal',
          }),
        },
        {
          purpose: 'proof-of-age',
          document: doc('d-age', 'Jordan birth certificate.pdf', 'eligibility-record', {
            sensitivity: 'personal',
          }),
        },
      ],
    },
    {
      participantId: '900002',
      displayName: 'Riley Example',
      enrollmentStatus: 'carryover',
      currentStatus: 'offboarded',
      documents: [
        {
          purpose: 'enrollment-form',
          document: doc('d-enr2', 'Riley enrollment.pdf', 'enrollment-form', {
            sensitivity: 'personal',
          }),
        },
      ],
    },
  ],
})

const caller = (role: Role): Caller => ({
  userId: `u-${role}`,
  displayName: `The ${role}`,
  memberships: [{ workspaceId: W, workspaceName: 'Riverbend Youth Services', role }],
  workspaceIds: [W],
})

const build = async (role: Role) => {
  const prisma = { engagement: { findFirst: jest.fn().mockResolvedValue(engagement()) } }
  const log = { log: jest.fn().mockResolvedValue(undefined) }
  const storage = {
    read: jest.fn(async (key: string) => Buffer.from(`bytes of ${key}`)),
    upload: jest.fn(),
    getSignedUrl: jest.fn(),
    delete: jest.fn(),
    deleteByPrefix: jest.fn(),
    putFile: jest.fn(),
  }
  // The service only touches engagement.findFirst, log.log and storage.read.
  const service = new AuditPackageService(prisma as never, log as never, storage)
  const out = await service.build(caller(role), 'e-1')
  const entries = unzipSync(new Uint8Array(out.bytes))
  const root = 'Coding Pathway (DEMO-1)'
  const paths = Object.keys(entries).map((p) => p.slice(root.length + 1))
  const text = (path: string) => strFromU8(entries[`${root}/${path}`]!)
  return { out, paths, text, log }
}

const MONTH = 'Months/September 2026 - $6,035.00'

describe('AuditPackageService', () => {
  it('lays the owner copy out like the funder package', async () => {
    const { out, paths, text, log } = await build('owner')
    expect(out.name).toBe('Coding Pathway (DEMO-1) - audit package.zip')
    expect(out.personal).toBe(true)

    // Root: the letter, the lists, the README and the index.
    expect(paths).toEqual(
      expect.arrayContaining([
        'Letter to the auditors - to the auditors.pdf',
        'Engagement records/01 Proposal - proposal.pdf',
        'Engagement records/02 Award letter - award.pdf',
        'Engagement records/04 Contract - contract.pdf',
        'Other records/memo.pdf',
        'Participants.csv',
        'README.txt',
        'Index.csv',
      ])
    )

    // The month: named with the amount billed; signed report, ledger, flat program-cost files.
    expect(paths).toEqual(
      expect.arrayContaining([
        `${MONTH}/Signed report - signed Sep.pdf`,
        `${MONTH}/Ledger.csv`,
        `${MONTH}/Payroll.csv`,
        `${MONTH}/Program Costs/RYS-11 - Ledger & Co. - $555.00 - 09.02.26 - Invoice.pdf`,
        `${MONTH}/Program Costs/RYS-11 - Ledger & Co. - $555.00 - 09.02.26 - Allocation worksheet.xlsx`,
        `${MONTH}/Program Costs/RYS-16 - Northline Computers - $5,200.00 - 09.09.26 - Invoice.pdf`,
        `${MONTH}/Proof of Purchase - Bank Statements/2026-09 Bank Statement.pdf`,
        `${MONTH}/Payroll and Timesheet Reports/RYS-13 payroll register.pdf`,
        `${MONTH}/Payroll and Timesheet Reports/RYS-13 timesheets.pdf`,
        `${MONTH}/WEX Documentation/Jordan Sample (900001)/Payroll Verification/Evidence of payment - Jordan pay stub.pdf`,
      ])
    )
    // A statement shared by two lines is filed once, not once per line.
    expect(paths.filter((p) => p.includes('Bank Statement'))).toHaveLength(1)
    expect(paths.filter((p) => p.includes('payroll register'))).toHaveLength(1)
    expect(paths.some((p) => p.includes('Program Costs/RYS-13'))).toBe(false)

    // The ledger names every file behind a line, the shared statement included.
    const ledger = text(`${MONTH}/Ledger.csv`).split('\r\n')
    expect(ledger[0]).toBe(
      '"Item #","Date","Vendor","Memo","Account","Total cost","Allocated","Allocation type","Allocation note","Budget line","Report line","Files"'
    )
    expect(ledger[1]).toContain(
      '"RYS-11","2026-09-02","Ledger & Co.","Monthly accounting","60701","3000.00","555.00","payroll","18.5% of payroll hours","Needs a budget line","program-costs"'
    )
    expect(ledger[1]).toContain('Proof of Purchase - Bank Statements/2026-09 Bank Statement.pdf')
    expect(ledger[3]).toContain('Payroll and Timesheet Reports/RYS-13 payroll register.pdf')

    const payroll = text(`${MONTH}/Payroll.csv`).split('\r\n')
    expect(payroll[1]).toContain(
      '"Jordan Sample","900001","2026-09-07","2026-09-20","20.00","280.00"'
    )
    expect(payroll[1]).toContain('Payroll Verification/Evidence of payment - Jordan pay stub.pdf')

    // Every participant on the list; the eligibility folder for the roles that may open it.
    const list = text('Participants.csv').split('\r\n')
    expect(list[0]).toBe(
      '"Participant id","Name","Beginning enrollment status","Current status","Eligibility file"'
    )
    expect(list[1]).toBe('"900001","Jordan Sample","new","active","complete"')
    expect(list[2]).toBe(
      '"900002","Riley Example","carryover","offboarded","missing: Proof of age"'
    )
    expect(paths).toEqual(
      expect.arrayContaining([
        'Participant Eligibility and Enrollment Forms/Jordan Sample - 900001/Enrollment form - Jordan enrollment.pdf',
        'Participant Eligibility and Enrollment Forms/Jordan Sample - 900001/Proof of age - Jordan birth certificate.pdf',
        'Participant Eligibility and Enrollment Forms/Riley Example - 900002 - offboarded/Enrollment form - Riley enrollment.pdf',
      ])
    )

    // README: the layout and the records never issued; no list of the team's open checks.
    const readme = text('README.txt')
    expect(readme).toContain('Authorized by: Sam Whitfield, Riverbend Youth Services')
    expect(readme).toContain('budget-narrative: this funder does not use one')
    expect(readme).toContain('Participant Eligibility and Enrollment Forms/')
    expect(readme).not.toContain('CHECKS STILL OPEN')

    // The index carries the amount of each line.
    const index = text('Index.csv').split('\r\n')
    expect(index[0]).toBe(
      '"Step","Month","Item","Vendor or participant","Purpose","Amount","Document type","File","Uploaded"'
    )
    expect(index.find((l) => l.includes('"RYS-16"'))).toContain(
      '"06 Monthly ledger and proof","September 2026","RYS-16","Northline Computers","Invoice","5200.00"'
    )

    // Every download is logged as an export.
    expect(log.log).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u-owner' }),
      expect.objectContaining({ workspaceId: W, resource: 'export', action: 'export' })
    )
    // README, Index, Participants, Budget vs actual, Ledger and Payroll are generated
    expect(out.files).toBe(paths.length - 6)
  })

  it('leaves personal records out of a bookkeeper copy and says so', async () => {
    const { out, paths, text } = await build('bookkeeper')
    expect(out.personal).toBe(false)
    expect(paths.some((p) => p.startsWith('Participant Eligibility'))).toBe(false)
    expect(paths.some((p) => p.includes('pay stub'))).toBe(false)
    // The list, the ledger and the month-level registers stay: they are not personal records.
    expect(paths).toEqual(
      expect.arrayContaining([
        'Participants.csv',
        `${MONTH}/Payroll.csv`,
        `${MONTH}/Payroll and Timesheet Reports/RYS-13 payroll register.pdf`,
      ])
    )
    expect(text('README.txt')).toContain('are personal records and are not in this copy')
  })

  it('says "personal records included" only when the copy holds one', async () => {
    const description = async (role: Role, e = engagement()) => {
      const prisma = { engagement: { findFirst: jest.fn().mockResolvedValue(e) } }
      const log = { log: jest.fn().mockResolvedValue(undefined) }
      const service = new AuditPackageService(prisma as never, log as never, {} as never)
      const plan = await service.plan(caller(role), 'e-1')
      await service.logExport(caller(role), plan)
      expect(log.log).toHaveBeenCalledTimes(1)
      return {
        plan,
        text: (log.log.mock.calls[0] as [unknown, { description: string }])[1].description,
      }
    }
    const owner = await description('owner')
    expect(owner.text).toBe(
      `Downloaded the audit package of Coding Pathway: ${owner.plan.objects.length} files, personal records included`
    )
    expect((await description('bookkeeper')).text).not.toContain('personal')
    // An owner's copy of an engagement with no personal record says nothing of them.
    const none = engagement()
    const noPersonal = {
      ...none,
      participants: none.participants.map((p) => ({ ...p, documents: [] })),
      monthlyReports: none.monthlyReports.map((r) => ({
        ...r,
        wexPayments: r.wexPayments.map((w) => ({ ...w, documents: [] })),
      })),
    }
    const plain = await description('owner', noPersonal as never)
    expect(plain.plan.personal).toBe(true)
    expect(plain.text).not.toContain('personal')
  })

  it("words a part's line from that part's own files", async () => {
    const prisma = { engagement: { findFirst: jest.fn().mockResolvedValue(engagement()) } }
    const log = { log: jest.fn().mockResolvedValue(undefined) }
    const service = new AuditPackageService(prisma as never, log as never, {} as never)
    const plan = await service.plan(caller('owner'), 'e-1')
    const personal = [...plan.personalPaths]
    const financial = plan.objects.map(([p]) => p).filter((p) => !plan.personalPaths.has(p))
    expect(personal.length).toBeGreaterThan(0)
    const layout = (n: number, paths: string[]) => ({ n, fileName: 'x', sourceBytes: 0, paths })
    await service.logExport(caller('owner'), plan, { layout: layout(1, financial), total: 2 })
    await service.logExport(caller('owner'), plan, { layout: layout(2, personal), total: 2 })
    expect(
      log.log.mock.calls.map((c) => (c as [unknown, { description: string }])[1].description)
    ).toEqual([
      `Downloaded the audit package of Coding Pathway (part 1 of 2): ${financial.length} files`,
      `Downloaded the audit package of Coding Pathway (part 2 of 2): ${personal.length} file${personal.length === 1 ? '' : 's'}, personal records included`,
    ])
  })

  it('gives an auditor the personal records', async () => {
    const { out, paths } = await build('auditor')
    expect(out.personal).toBe(true)
    expect(paths.some((p) => p.startsWith('Participant Eligibility'))).toBe(true)
  })

  it('asks only for the caller workspaces, and answers 404 for an engagement of another one', async () => {
    const prisma = { engagement: { findFirst: jest.fn().mockResolvedValue(null) } }
    const log = { log: jest.fn() }
    const storage = {
      read: jest.fn(),
      upload: jest.fn(),
      getSignedUrl: jest.fn(),
      delete: jest.fn(),
      deleteByPrefix: jest.fn(),
      putFile: jest.fn(),
    }
    const service = new AuditPackageService(prisma as never, log as never, storage)
    await expect(service.build(caller('owner'), 'e-other')).rejects.toThrow(NotFoundException)
    expect(prisma.engagement.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'e-other', workspaceId: { in: [W] } } })
    )
    expect(storage.read).not.toHaveBeenCalled()
    expect(log.log).not.toHaveBeenCalled()
  })
})

describe('AuditPackageService: payroll lines marked on a bank statement', () => {
  const pdf = readFileSync(
    join(__dirname, '../../test/fixtures/statements/riverbend-2026-09-statement.pdf')
  )
  const mark = { page: 2, x: 48, y: 677, width: 520, height: 14.4 }
  it("highlights the line on the item's own copy, files the statement once as stored, and leaves it unchanged", async () => {
    const e = engagement()
    const month = e.monthlyReports[0]!
    const marked = {
      ...e,
      monthlyReports: [
        {
          ...month,
          expenses: month.expenses.map((x) =>
            x.itemNumber === 'RYS-13'
              ? {
                  ...x,
                  documents: [...x.documents, { purpose: 'payment', document: statement, mark }],
                }
              : x
          ),
        },
      ],
    }
    const prisma = { engagement: { findFirst: jest.fn().mockResolvedValue(marked) } }
    const storage = {
      read: jest.fn(async (key: string) =>
        key === statement.storageKey ? Buffer.from(pdf) : Buffer.from(`bytes of ${key}`)
      ),
    }
    const service = new AuditPackageService(
      prisma as never,
      { log: jest.fn() } as never,
      storage as never
    )
    const plan = await service.plan(caller('owner'), 'e-1')
    const [[copyPath, copyMarks]] = [...(plan.marks ?? new Map()).entries()]
    expect(copyPath).toMatch(
      /\/Payroll\/RYS-13 - .+\/Evidence of payment - 2026-09 Bank Statement\.pdf$/
    )
    expect(copyMarks).toEqual([mark])
    const out = await service.build(caller('owner'), 'e-1')
    const entries = unzipSync(new Uint8Array(out.bytes))
    const shared =
      entries[
        `Coding Pathway (DEMO-1)/${MONTH}/Proof of Purchase - Bank Statements/2026-09 Bank Statement.pdf`
      ]!
    expect(Buffer.from(shared).equals(pdf)).toBe(true)
    const copy = entries[copyPath]!
    expect(Buffer.from(copy).equals(pdf)).toBe(false)
    expect((await PDFDocument.load(copy)).getPageCount()).toBe(2)
    const copied = Object.entries(entries).find(([p]) => p.endsWith('Jordan pay stub.pdf'))!
    expect(strFromU8(copied[1])).toBe(`bytes of ${stub.storageKey}`)
    const readme = strFromU8(entries['Coding Pathway (DEMO-1)/README.txt']!)
    expect(readme).toContain('highlighted (the stored files are unchanged)')
    expect(readme).not.toContain('NOT DRAWN')
  })

  it('puts an encrypted statement in as stored and says in the README which marks are not drawn', async () => {
    const encrypted = Buffer.from(await encryptedPdf())
    const e = engagement()
    const month = e.monthlyReports[0]!
    const marked = {
      ...e,
      monthlyReports: [
        {
          ...month,
          expenses: month.expenses.map((x) =>
            x.itemNumber === 'RYS-13'
              ? {
                  ...x,
                  documents: [...x.documents, { purpose: 'payment', document: statement, mark }],
                }
              : x
          ),
        },
      ],
    }
    const prisma = { engagement: { findFirst: jest.fn().mockResolvedValue(marked) } }
    const storage = {
      read: jest.fn(async (key: string) =>
        key === statement.storageKey ? encrypted : Buffer.from(`bytes of ${key}`)
      ),
    }
    const service = new AuditPackageService(
      prisma as never,
      { log: jest.fn() } as never,
      storage as never
    )
    const out = await service.build(caller('owner'), 'e-1')
    const entries = unzipSync(new Uint8Array(out.bytes))
    const path = Object.keys(entries)
      .find((p) => p.includes('/Payroll/RYS-13 - '))!
      .slice('Coding Pathway (DEMO-1)/'.length)
    expect(Buffer.from(entries[`Coding Pathway (DEMO-1)/${path}`]!).equals(encrypted)).toBe(true)
    const readme = strFromU8(entries['Coding Pathway (DEMO-1)/README.txt']!)
    expect(readme).toContain('highlighted where it could be drawn (see MARKED LINES NOT DRAWN')
    expect(readme).toContain(
      `MARKED LINES NOT DRAWN\n  ${path}\n    The marked lines could not be drawn on this copy (encrypted or damaged):\n      page 2, at 48, 677\n`
    )
  })
})

describe('AuditPackageService: a month reopened after it was submitted', () => {
  it('files the corrected signed copy, each copy submitted before, and Reopenings.csv; the README says so', async () => {
    const e = engagement()
    const corrected = doc('d-signed-2', 'signed Sep corrected.pdf', 'signed-report', {
      period: '2026-09',
      uploadedAt: new Date('2026-10-10T00:00:00Z'),
    })
    const reopened = {
      ...e,
      documents: [...e.documents, corrected],
      monthlyReports: e.monthlyReports.map((r) => ({
        ...r,
        reopenings: [
          {
            reopenedAt: new Date('2026-10-09T00:00:00Z'),
            reopenedByEmail: 'owner@example.test',
            reason: 'Rent line typo',
            submittedAt: new Date('2026-10-08T00:00:00Z'),
            approvedByName: 'Sam Whitfield',
            approvedAt: new Date('2026-10-05T00:00:00Z'),
            signedDocumentId: 'd-signed',
          },
        ],
      })),
    }
    const prisma = { engagement: { findFirst: jest.fn().mockResolvedValue(reopened) } }
    const storage = { read: jest.fn(async (key: string) => Buffer.from(`bytes of ${key}`)) }
    const service = new AuditPackageService(
      prisma as never,
      { log: jest.fn() } as never,
      storage as never
    )
    const out = await service.build(caller('bookkeeper'), 'e-1')
    const entries = unzipSync(new Uint8Array(out.bytes))
    const root = 'Coding Pathway (DEMO-1)'
    const text = (p: string) => strFromU8(entries[`${root}/${p}`]!)
    expect(text(`${MONTH}/Signed report - signed Sep corrected.pdf`)).toBe(
      `bytes of ${corrected.storageKey}`
    )
    expect(text(`${MONTH}/Earlier submissions/Signed report as submitted 2026-10-08.pdf`)).toBe(
      `bytes of ${W}/e-1/general/d-signed`
    )
    expect(text(`${MONTH}/Reopenings.csv`).split('\r\n')[1]).toBe(
      `"2026-10-08","Sam Whitfield","2026-10-05","2026-10-09","owner@example.test","Rent line typo","${MONTH}/Earlier submissions/Signed report as submitted 2026-10-08.pdf"`
    )
    expect(text('README.txt')).toContain('MONTHS REOPENED AFTER THEY WERE SUBMITTED')
    expect(text('README.txt')).toContain('September 2026: Reopened once after it was submitted')
  })
})

describe('AuditPackageService: the full copy taken before a deletion', () => {
  const orphan = doc('d-orphan', 'loose invoice.pdf', 'invoice', { period: '2026-09' })
  const personalOrphan = doc('d-pers', 'loose id.pdf', 'eligibility-record', {
    sensitivity: 'personal',
  })
  const fixture = () => {
    const e = engagement()
    return {
      ...e,
      documents: [...e.documents, orphan, personalOrphan],
      budgetLines: [
        {
          id: 'bl-wex',
          name: 'Work experience',
          category: 'wex',
          reportLine: 'wex',
          amount: 9000,
          narrative: 'Wages',
        },
      ],
      monthlyReports: e.monthlyReports.map((r) => ({
        ...r,
        status: 'submitted',
        dueDate: new Date('2026-10-12T00:00:00Z'),
        submittedAt: new Date('2026-10-10T00:00:00Z'),
        preparedByName: 'Dana Okafor',
        authorizedByName: 'Sam Whitfield',
        authorizedAt: new Date('2026-10-10T00:00:00Z'),
        closingNote: 'Approved by phone',
        sentBackReason: null,
        comments: null,
        isFinal: false,
        checks: [
          {
            code: 'missing-proof',
            severity: 'attention',
            source: 'rule',
            message: 'No invoice',
            status: 'waived',
            resolution: 'Vendor closed',
            resolvedAt: new Date('2026-10-02T00:00:00Z'),
          },
        ],
      })),
    }
  }
  const run = async (role: Role, complete: boolean) => {
    const prisma = { engagement: { findFirst: jest.fn().mockResolvedValue(fixture()) } }
    const storage = {
      read: jest.fn(async (key: string) => Buffer.from(`bytes of ${key}`)),
    }
    const service = new AuditPackageService(
      prisma as never,
      { log: jest.fn() } as never,
      storage as never
    )
    const plan = await service.plan(caller(role), 'e-1', { complete })
    const chunks: Uint8Array[] = []
    for await (const c of service.stream(plan)) chunks.push(c)
    const zip = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
    let at = 0
    for (const c of chunks) {
      zip.set(c, at)
      at += c.length
    }
    return { plan, storage, entries: unzipSync(zip) }
  }
  const root = 'Coding Pathway (DEMO-1)'

  it('files what the layout does not reach, and adds the budget, months and checks', async () => {
    const { entries, plan } = await run('owner', true)
    const paths = Object.keys(entries).map((p) => p.slice(root.length + 1))
    expect(paths).toEqual(
      expect.arrayContaining([
        'Unfiled records/loose invoice.pdf',
        'Unfiled records/loose id.pdf',
        'Budget.csv',
        'Months.csv',
        'Checks.csv',
      ])
    )
    expect(strFromU8(entries[`${root}/Checks.csv`]!)).toContain('Vendor closed')
    expect(strFromU8(entries[`${root}/Months.csv`]!)).toContain('Approved by phone')
    expect(strFromU8(entries[`${root}/Index.csv`]!)).toContain('Unfiled records')
    expect(strFromU8(entries[`${root}/README.txt`]!)).toContain('before the engagement was deleted')
    expect(plan.subject).toBe('Coding Pathway')
  })

  it('every stored file of the engagement is in the owner copy, and the plain package is unchanged', async () => {
    const full = await run('owner', true)
    const stored = new Set(Object.values(full.entries).map((b) => strFromU8(b)))
    for (const d of fixture().documents) expect(stored).toContain(`bytes of ${d.storageKey}`)
    const plain = await run('owner', false)
    expect(Object.keys(plain.entries).some((p) => p.includes('Unfiled'))).toBe(false)
  })

  it('reads every stored object once while streaming', async () => {
    const { storage, plan } = await run('owner', true)
    expect(storage.read).toHaveBeenCalledTimes(plan.objects.length)
  })
})

describe('csv', () => {
  it('keeps a negative amount a number and quotes anything a spreadsheet would run', () => {
    expect(
      csv([[-224, '-224.00', '-2240', '-2+3', '=1+1', '@x', '+5', '\tx', 'Ledger & Co.']])
    ).toBe(`"-224","-224.00","-2240","'-2+3","'=1+1","'@x","'+5","'\tx","Ledger & Co."`)
  })
})
