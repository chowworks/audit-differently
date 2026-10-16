import {
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common'
import { strFromU8, unzipSync } from 'fflate'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import type { Role } from '@ad/types'
import type { Caller } from '../core/caller'
import { csv } from '../engagements/audit-package.service'
import * as marking from '../payroll/mark-pdf'
import { readStatement } from '../payroll/statement-lines'
import { encryptedPdf } from '../payroll/testing'
import { ReportsController } from './reports.controller'
import { BuildGate, MonthBundleService } from './month-bundle.service'

/**
 * The month's bundle: one PDF in a fixed order (signed report or cover page, ledger summary, each line's records,
 * payroll proof), the files a PDF cannot hold beside it, an index and a README. Never a personal record.
 */
const W = 'ws-1'
const statementPdf = readFileSync(
  join(__dirname, '../../test/fixtures/statements/riverbend-2026-09-statement.pdf')
)
// A 1 by 1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

/** A PDF of `n` pages, each `size` points, so a source's pages can be told apart in the bundle by their size. */
// Fixed dates: pdf-lib stamps the time it was made, so two "same" PDFs made a second apart differ byte for byte, and
// tests that compare them failed whenever a busy full run crossed a second.
const PDF_DATE = new Date('2026-10-01T00:00:00Z')
const pdfOf = async (n: number, size: [number, number]) => {
  const d = await PDFDocument.create({ updateMetadata: false })
  d.setCreationDate(PDF_DATE)
  d.setModificationDate(PDF_DATE)
  for (let i = 0; i < n; i++) d.addPage(size)
  return Buffer.from(await d.save())
}

type Doc = {
  id: string
  workspaceId: string
  engagementId: string
  storageKey: string
  fileName: string
  kind: string
  contentType: string
  size: number
  sha256: string
  sensitivity: string
  period: string | null
  uploadedAt: Date
}
const doc = (id: string, fileName: string, kind: string, extra: Partial<Doc> = {}): Doc => ({
  id,
  workspaceId: W,
  engagementId: 'e-1',
  storageKey: `${W}/e-1/2026-09/${id}`,
  fileName,
  kind,
  contentType: 'application/pdf',
  size: 1000,
  sha256: `sha-${id}`,
  sensitivity: 'financial',
  period: null,
  uploadedAt: new Date('2026-10-01T00:00:00Z'),
  ...extra,
})

const signed = doc('d-signed', 'signed Sep.pdf', 'signed-report', { period: '2026-09' })
const statement = doc('d-stmt', '2026-09 Bank Statement.pdf', 'bank-statement', {
  period: '2026-09',
})
const register = doc('d-reg', 'payroll register.pdf', 'payroll-register', { period: '2026-09' })
const timesheet = doc('d-ts', 'timesheets.pdf', 'timesheet')
const stub = doc('d-stub', 'Jordan pay stub.pdf', 'paystub', {
  sensitivity: 'personal',
  period: '2026-09',
})
const invoice11 = doc('d-inv11', 'inv 11.pdf', 'invoice')
const invoice16 = doc('d-inv16', 'inv 16.png', 'invoice', { contentType: 'image/png' })
const alloc = doc('d-alloc', 'alloc 11.xlsx', 'allocation-calculation', {
  contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
})
const mark = { page: 2, x: 48, y: 677, width: 520, height: 14.4 }

const report = (vendor = 'Ledger & Co.') => ({
  id: 'r-1',
  workspaceId: W,
  engagementId: 'e-1',
  period: '2026-09',
  status: 'closed',
  authorizedByName: 'Sam Whitfield',
  authorizedAt: new Date('2026-10-03T00:00:00Z'),
  submittedAt: null as Date | null,
  preparedByName: null,
  reopenings: [] as object[],
  engagement: {
    id: 'e-1',
    name: 'Coding Pathway',
    number: 'DEMO-1',
    funder: 'Demo Workforce Board',
    workspace: { name: 'Riverbend Youth Services' },
  },
  expenses: [
    {
      itemNumber: 'RYS-11',
      date: new Date('2026-09-02T00:00:00Z'),
      vendor,
      allocatedAmount: 555,
      reportLine: 'program-costs',
      documents: [
        { purpose: 'allocation', document: alloc, mark: null },
        { purpose: 'payment', document: statement, mark },
        { purpose: 'invoice', document: invoice11, mark: null },
      ],
    },
    {
      itemNumber: 'RYS-16',
      date: new Date('2026-09-09T00:00:00Z'),
      vendor: 'Northline Computers',
      allocatedAmount: 5200,
      reportLine: 'program-costs',
      documents: [
        { purpose: 'invoice', document: invoice16, mark: null },
        { purpose: 'payment', document: statement, mark: null },
      ],
    },
    {
      itemNumber: 'RYS-13',
      date: new Date('2026-09-25T00:00:00Z'),
      vendor: 'PayPeople Payroll',
      allocatedAmount: 280,
      reportLine: 'wex',
      documents: [
        { purpose: 'timesheet', document: timesheet, mark: null },
        { purpose: 'register', document: register, mark: null },
      ],
    },
  ],
  wexPayments: [
    {
      payPeriodStart: new Date('2026-09-07T00:00:00Z'),
      payPeriodEnd: new Date('2026-09-20T00:00:00Z'),
      grossAmount: 280,
      participant: { participantId: '900001' },
      documents: [
        { purpose: 'register', document: register, mark: null },
        { purpose: 'payment', document: stub, mark: null },
      ],
    },
  ],
})

const caller = (role: Role): Caller => ({
  userId: `u-${role}`,
  displayName: `The ${role}`,
  email: `${role}@example.test`,
  memberships: [{ workspaceId: W, workspaceName: 'Riverbend Youth Services', role }],
  workspaceIds: [W],
})

const SIZES = {
  signed: [600, 780] as [number, number],
  invoice: [500, 500] as [number, number],
  timesheet: [400, 600] as [number, number],
  register: [700, 500] as [number, number],
}
const HEADER = '612x792'

const setup = async (
  r: ReturnType<typeof report> | null = report(),
  monthDocs = [signed, statement, register, stub]
) => {
  const bytes: Record<string, Buffer> = {
    [signed.storageKey]: await pdfOf(2, SIZES.signed),
    [invoice11.storageKey]: await pdfOf(1, SIZES.invoice),
    [invoice16.storageKey]: PNG,
    [alloc.storageKey]: Buffer.from('PK spreadsheet bytes'),
    [statement.storageKey]: statementPdf,
    [register.storageKey]: await pdfOf(1, SIZES.register),
    [timesheet.storageKey]: await pdfOf(1, SIZES.timesheet),
    [stub.storageKey]: Buffer.from('a pay stub'),
  }
  const prisma = {
    monthlyReport: { findFirst: jest.fn().mockResolvedValue(r) },
    document: { findMany: jest.fn().mockResolvedValue(monthDocs) },
  }
  const log = { log: jest.fn().mockResolvedValue(undefined) }
  const storage = {
    read: jest.fn(async (key: string) => bytes[key]!),
    upload: jest.fn(),
    getSignedUrl: jest.fn(),
    delete: jest.fn(),
    deleteByPrefix: jest.fn(),
    putFile: jest.fn(),
  }
  const service = new MonthBundleService(prisma as never, log as never, storage as never)
  return { service, prisma, log, storage }
}

const download = async (role: Role, r = report(), monthDocs?: Doc[]) => {
  const s = await setup(r, monthDocs)
  const bundle = await s.service.make(caller(role), 'r-1')
  await s.service.logDownload(caller(role), bundle)
  const chunks: Uint8Array[] = []
  for await (const c of s.service.stream(bundle)) chunks.push(c)
  const entries = unzipSync(Buffer.concat(chunks))
  const root = 'Coding Pathway - September 2026 - bundle'
  const paths = Object.keys(entries).map((p) => p.slice(root.length + 1))
  const text = (p: string) => strFromU8(entries[`${root}/${p}`]!)
  const pdf = await PDFDocument.load(entries[`${root}/Bundle.pdf`]!)
  const sizes = pdf.getPages().map((p) => `${p.getWidth()}x${p.getHeight()}`)
  return { ...s, bundle, entries, paths, text, pdf, sizes }
}

describe('MonthBundleService', () => {
  it('puts the signed report, the ledger summary, the line records and the payroll proof in order', async () => {
    const statementPages = (await PDFDocument.load(statementPdf)).getPages()
    const { bundle, paths, sizes, text } = await download('owner')
    expect(bundle.name).toBe('Coding Pathway - September 2026 - bundle.zip')
    expect(paths.sort()).toEqual(
      [
        'Bundle.pdf',
        'Index.csv',
        'README.txt',
        'Supporting files/RYS-11 - Allocation worksheet - alloc 11.xlsx',
      ].sort()
    )
    const size = (s: [number, number]) => `${s[0]}x${s[1]}`
    expect(sizes).toEqual([
      // The signed report as uploaded, then the ledger summary.
      size(SIZES.signed),
      size(SIZES.signed),
      HEADER,
      // RYS-11: the invoice, then the worksheet's page pointing to Supporting files/ (invoice first by purpose).
      HEADER,
      size(SIZES.invoice),
      HEADER,
      // RYS-16: the PNG invoice on a page of its own.
      HEADER,
      HEADER,
      // RYS-13: the timesheet. The register and the statement are payroll proof, filed once each below.
      HEADER,
      size(SIZES.timesheet),
      // Payroll proof: the statement (backing RYS-11 and RYS-16), then the register.
      HEADER,
      ...statementPages.map((p) => `${p.getWidth()}x${p.getHeight()}`),
      HEADER,
      size(SIZES.register),
    ])
    expect(bundle.files).toBe(7)

    const index = text('Index.csv').split('\r\n')
    expect(index[0]).toBe(
      '"Section","Item","Vendor or participant","Purpose","Amount","Document type","Original file","In this bundle","Uploaded","SHA-256"'
    )
    expect(index).toContain(
      '"Signed report","Monthly report","","Signed report","","signed-report","signed Sep.pdf","Bundle.pdf, pages 1-2","2026-10-01","sha-d-signed"'
    )
    expect(index.find((l) => l.includes('alloc 11.xlsx'))).toContain(
      '"Supporting files/RYS-11 - Allocation worksheet - alloc 11.xlsx"'
    )
    // The statement is one record behind two lines: two index rows, one place in the PDF.
    const stmt = index.filter((l) => l.includes('2026-09 Bank Statement.pdf'))
    expect(stmt).toHaveLength(2)
    expect(stmt[0]).toContain(
      '"Payroll proof","RYS-11","Ledger & Co.","Evidence of payment","555.00"'
    )
    expect(stmt[1]).toContain('"RYS-16"')
    expect(index.find((l) => l.includes('Ledger summary'))).toContain('Bundle.pdf, page 3')
  })

  it('draws the marked payroll line on the statement', async () => {
    const spy = jest.spyOn(marking, 'markPdf')
    const { text, entries } = await download('owner')
    expect(spy).toHaveBeenCalledWith(expect.any(Uint8Array), [mark])
    spy.mockRestore()
    const pdf = Object.entries(entries).find(([p]) => p.endsWith('Bundle.pdf'))![1]
    const lines = (await readStatement(Buffer.from(pdf))).lines.map((l) => l.text)
    expect(lines).toContain('1 marked line highlighted on this statement.')
    expect(text('README.txt')).toContain('highlighted (the stored statement is unchanged).')
    expect(text('README.txt')).not.toContain('NOT DRAWN')
  })

  it('never says a line is highlighted on an encrypted statement, and says where the mark is', async () => {
    const s = await setup()
    const encrypted = Buffer.from(await encryptedPdf())
    const read = s.storage.read.getMockImplementation()!
    s.storage.read.mockImplementation(async (key: string) =>
      key === statement.storageKey ? encrypted : read(key)
    )
    const bundle = await s.service.make(caller('owner'), 'r-1')
    const chunks: Uint8Array[] = []
    for await (const c of s.service.stream(bundle)) chunks.push(c)
    const entries = unzipSync(Buffer.concat(chunks))
    const root = 'Coding Pathway - September 2026 - bundle'
    const lines = (await readStatement(Buffer.from(entries[`${root}/Bundle.pdf`]!))).lines.map(
      (l) => l.text
    )
    expect(lines.join('\n')).not.toContain('highlighted')
    expect(lines).toContain(
      'The marked lines could not be drawn on this copy (encrypted or damaged):'
    )
    expect(lines).toContain('page 2, at 48, 677')
    const readme = strFromU8(entries[`${root}/README.txt`]!)
    expect(readme).toContain(
      'highlighted where it could be drawn (see MARKED LINES NOT DRAWN below)'
    )
    expect(readme).toContain(
      'MARKED LINES NOT DRAWN\n  2026-09 Bank Statement.pdf (Supporting files/'
    )
    expect(readme).toContain('      page 2, at 48, 677')
  })

  it.each(['owner', 'bookkeeper', 'auditor'] as Role[])(
    'leaves every personal record out of a %s copy and says so',
    async (role) => {
      const { paths, text, storage, entries } = await download(role)
      expect(storage.read).not.toHaveBeenCalledWith(stub.storageKey)
      expect(paths.some((p) => p.includes('pay stub'))).toBe(false)
      expect(text('Index.csv')).not.toContain('pay stub')
      expect(text('Index.csv')).not.toContain('d-stub')
      for (const bytes of Object.values(entries))
        expect(strFromU8(bytes, true)).not.toContain('Jordan')
      const readme = text('README.txt')
      expect(readme).toContain(
        'Personal records (pay stubs, eligibility records, enrollment forms) are never in a monthly bundle'
      )
      expect(readme).toContain('1 personal record of this month was left out.')
    }
  )

  it('says in the README the month status, who approved the closing and whether it was submitted', async () => {
    const { text } = await download('auditor')
    const readme = text('README.txt')
    expect(readme).toContain('Month status: closing approved')
    expect(readme).toContain('Month-end closing: approved 2026-10-03 by Sam Whitfield')
    expect(readme).toContain('Submitted to the funder: not submitted yet')
    expect(readme).toContain('by auditor@example.test')

    const draft = { ...report(), status: 'draft', authorizedAt: null, authorizedByName: null }
    const d = (await download('bookkeeper', draft as never)).text('README.txt')
    expect(d).toContain('Month status: draft (the ledger can still change)')
    expect(d).toContain('Month-end closing: not approved yet')
  })

  it('opens with a cover page when the signed report is not on file yet', async () => {
    const { sizes, text } = await download('owner', report(), [statement, register])
    // Cover page and ledger summary, then the same records as before.
    expect(sizes.slice(0, 3)).toEqual([HEADER, HEADER, HEADER])
    expect(sizes).not.toContain(`${SIZES.signed[0]}x${SIZES.signed[1]}`)
    expect(text('Index.csv')).toContain(
      '"Cover page","","","","","generated","","Bundle.pdf, page 1"'
    )
    expect(text('README.txt')).toContain(
      'a cover page (the signed monthly report is not on file yet)'
    )
  })

  it('guards every index cell against spreadsheet formulas', async () => {
    const { text } = await download('owner', report('=HYPERLINK("http://example.test")'))
    expect(text('Index.csv')).toContain('"\'=HYPERLINK(""http://example.test"")"')
    expect(csv([['=1+1', '+1', '-1', '@SUM(A1)', '\tx', '\rx', 'plain', 5, -224.5, '-2+3']])).toBe(
      `"'=1+1","'+1","-1","'@SUM(A1)","'\tx","'\rx","plain","5","-224.5","'-2+3"`
    )
  })

  it('logs one line per download, naming the month, the engagement and the files', async () => {
    const { log } = await download('bookkeeper')
    expect(log.log).toHaveBeenCalledTimes(1)
    expect(log.log).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u-bookkeeper' }), {
      workspaceId: W,
      resource: 'export',
      subjectId: 'r-1',
      action: 'export',
      description: 'Downloaded the September 2026 bundle of Coding Pathway: 7 files',
    })
  })

  it('keeps each signed copy submitted before a reopening beside the bundle, with Reopenings.csv', async () => {
    const corrected = doc('d-signed-2', 'signed Sep corrected.pdf', 'signed-report', {
      period: '2026-09',
      uploadedAt: new Date('2026-10-10T00:00:00Z'),
    })
    const r = {
      ...report(),
      status: 'submitted',
      submittedAt: new Date('2026-10-11T00:00:00Z'),
      reopenings: [
        {
          reopenedAt: new Date('2026-10-09T00:00:00Z'),
          reopenedByEmail: 'owner@example.test',
          reason: '=Rent line typo',
          submittedAt: new Date('2026-10-08T00:00:00Z'),
          approvedByName: 'Sam Whitfield',
          approvedAt: new Date('2026-10-03T00:00:00Z'),
          signedDocumentId: 'd-signed',
        },
      ],
    }
    const s = await setup(r, [signed, corrected, statement, register, stub])
    const correctedPdf = await pdfOf(1, [300, 300])
    const read = s.storage.read.getMockImplementation()!
    s.storage.read.mockImplementation(async (key: string) =>
      key === corrected.storageKey ? correctedPdf : read(key)
    )
    const bundle = await s.service.make(caller('auditor'), 'r-1')
    const chunks: Uint8Array[] = []
    for await (const c of s.service.stream(bundle)) chunks.push(c)
    const entries = unzipSync(Buffer.concat(chunks))
    const root = 'Coding Pathway - September 2026 - bundle'
    const text = (p: string) => strFromU8(entries[`${root}/${p}`]!)
    // Bundle.pdf opens with the corrected copy, the one that counts now.
    const pdf = await PDFDocument.load(entries[`${root}/Bundle.pdf`]!)
    expect(`${pdf.getPage(0).getWidth()}x${pdf.getPage(0).getHeight()}`).toBe('300x300')
    // The copy that was submitted on October 8 is kept as it was uploaded.
    const earlier = entries[`${root}/Earlier submissions/Signed report as submitted 2026-10-08.pdf`]
    expect(Buffer.from(earlier!).equals(await pdfOf(2, SIZES.signed))).toBe(true)
    expect(bundle.files).toBe(8)
    const rows = text('Reopenings.csv').split('\r\n')
    expect(rows[0]).toBe(
      '"Submitted on","Month-end closing approved by","Month-end closing approved on","Reopened on","Reopened by","Why it was reopened","Signed copy as submitted"'
    )
    expect(rows[1]).toBe(
      `"2026-10-08","Sam Whitfield","2026-10-03","2026-10-09","owner@example.test","'=Rent line typo","Earlier submissions/Signed report as submitted 2026-10-08.pdf"`
    )
    expect(text('README.txt')).toContain('Reopened once after it was submitted')
    expect(text('Index.csv')).toContain(
      '"Earlier submission","Monthly report","","Signed report as submitted 2026-10-08","","signed-report","signed Sep.pdf","Earlier submissions/Signed report as submitted 2026-10-08.pdf"'
    )
  })

  it('answers 404 for a month of another workspace and writes no line', async () => {
    const { service, prisma, storage, log } = await setup(null)
    const bundles = { make: service.make.bind(service), logDownload: jest.fn(), stream: jest.fn() }
    const callers = { load: jest.fn().mockResolvedValue(caller('owner')) }
    const controller = new ReportsController({} as never, bundles as never, callers as never)
    await expect(controller.bundle('u-owner', 'r-other', {} as never)).rejects.toThrow(
      NotFoundException
    )
    expect(prisma.monthlyReport.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'r-other', workspaceId: { in: [W] } } })
    )
    expect(storage.read).not.toHaveBeenCalled()
    expect(bundles.logDownload).not.toHaveBeenCalled()
    expect(log.log).not.toHaveBeenCalled()
  })

  it('answers 404 to a caller who is not a member of the month workspace', async () => {
    const { service } = await setup()
    const stranger: Caller = { ...caller('owner'), memberships: [], workspaceIds: [W] }
    await expect(service.make(stranger, 'r-1')).rejects.toThrow(NotFoundException)
  })

  it('counts a PNG at its decoded size, not its file size', async () => {
    const s = await setup()
    // The same small file, its header claiming 6000 by 6000 pixels: 144 MB once decoded.
    const huge = Buffer.from(PNG)
    huge.writeUInt32BE(6000, 16)
    huge.writeUInt32BE(6000, 20)
    const read = s.storage.read.getMockImplementation()!
    s.storage.read.mockImplementation(async (key: string) =>
      key === invoice16.storageKey ? huge : read(key)
    )
    await expect(s.service.make(caller('owner'), 'r-1')).rejects.toThrow(
      "This month's records come to 138 MB"
    )
  })

  it('frees its turn when a bundle fails, so later downloads are not kept waiting', async () => {
    const { service } = await setup(null)
    for (let i = 0; i < 5; i++)
      await expect(service.make(caller('owner'), 'r-1')).rejects.toThrow(NotFoundException)
    const ok = await setup()
    await expect(ok.service.make(caller('owner'), 'r-1')).resolves.toBeDefined()
  })

  it('refuses a month whose records are too big for one PDF, before reading any', async () => {
    const big = report()
    big.expenses[0]!.documents[2]!.document = { ...invoice11, size: 200 * 1024 * 1024 }
    const { service, storage } = await setup(big)
    await expect(service.make(caller('owner'), 'r-1')).rejects.toThrow(PayloadTooLargeException)
    expect(storage.read).not.toHaveBeenCalled()
  })
})

describe('BuildGate', () => {
  const later = () => {
    let done!: () => void
    const p = new Promise<void>((r) => (done = r))
    return { p, done }
  }

  it('runs two at once; a third waits for a turn, and one that waits too long is told to try again', async () => {
    const gate = new BuildGate(2, 50)
    const a = later()
    const b = later()
    const started: string[] = []
    const one = gate.run(async () => (started.push('a'), a.p))
    const two = gate.run(async () => (started.push('b'), b.p))
    const three = gate.run(async () => void started.push('c'))
    await new Promise((r) => setTimeout(r, 5))
    expect(started).toEqual(['a', 'b'])
    a.done()
    await one
    await three
    expect(started).toEqual(['a', 'b', 'c'])

    const c = later()
    const four = gate.run(() => c.p)
    const five = gate.run(async () => 'never')
    await expect(five).rejects.toThrow(ServiceUnavailableException)
    await expect(five).rejects.toThrow('Try again in a minute.')
    b.done()
    c.done()
    await Promise.all([two, four])
    await expect(gate.run(async () => 'ok')).resolves.toBe('ok')
  })
})
