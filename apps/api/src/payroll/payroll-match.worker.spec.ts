import { PDFDocument, StandardFonts } from 'pdf-lib'
import { hostname } from 'node:os'
import {
  MAX_READ_ATTEMPTS,
  PayrollMatchWorker,
  READ_CLAIM_SQL,
  storageName,
} from './payroll-match.worker'

async function pdfWith(text: string): Promise<Buffer> {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([612, 792])
  page.drawText(text, {
    x: 50,
    y: 700,
    size: 10,
    font: await pdf.embedFont(StandardFonts.Helvetica),
  })
  return Buffer.from(await pdf.save())
}

/** The worker with its database and storage mocked: what it writes for each file is what the test reads. */
function worker(read: (key: string) => Promise<Buffer>) {
  const updateMany = jest.fn().mockResolvedValue({ count: 1 })
  const prisma = { payrollMatchFile: { updateMany } }
  const w = new PayrollMatchWorker(prisma as never, { read } as never)
  return { w, written: () => updateMany.mock.calls.map((c) => c[0].data) }
}
const file = (over: object = {}) => ({
  id: 'f1',
  workspaceId: 'W1',
  storageKey: 'W1/E1/2026-01/a.pdf',
  contentType: 'application/pdf',
  attempts: 1,
  ...over,
})

describe('PayrollMatchWorker', () => {
  it('reads a PDF into lines with their boxes', async () => {
    const { w, written } = worker(() => pdfWith('Jordan Sample | $280.00'))
    await w.read(file())
    const [data] = written()
    expect(data).toMatchObject({ status: 'read', pages: 1, scanned: false, error: null })
    expect((data.lines as { text: string }[])[0]!.text).toBe('Jordan Sample | $280.00')
  })

  it('reads an image as scanned, to be matched by hand', async () => {
    const read = jest.fn()
    const { w, written } = worker(read)
    await w.read(file({ contentType: 'image/png', storageKey: 'W1/E1/2026-01/a.png' }))
    expect(written()[0]).toMatchObject({ status: 'read', scanned: true, pages: 0 })
    expect(read).not.toHaveBeenCalled()
  })

  it('tries a file that fails again, and gives it up after the last try', async () => {
    const { w, written } = worker(async () => Buffer.from('%PDF-1.7 broken'))
    await w.read(file({ attempts: 1 }))
    await w.read(file({ attempts: MAX_READ_ATTEMPTS }))
    expect(written()).toEqual([
      { status: 'waiting', leaseUntil: null },
      { status: 'failed', error: 'This PDF could not be opened', scanned: true, leaseUntil: null },
    ])
  })

  it("never reads an object outside the file's own workspace", async () => {
    const read = jest.fn()
    const { w, written } = worker(read)
    await w.read(file({ storageKey: 'W2/E9/2026-01/a.pdf', attempts: MAX_READ_ATTEMPTS }))
    expect(read).not.toHaveBeenCalled()
    expect(written()[0]).toMatchObject({ status: 'failed' })
  })

  it("claims only the files in this API's own storage", async () => {
    const bucket = process.env.R2_DOCUMENTS_BUCKET
    try {
      process.env.R2_DOCUMENTS_BUCKET = 'ad-dev-fictional'
      expect(storageName()).toBe('r2:ad-dev-fictional')
      const prisma = {
        $executeRawUnsafe: jest.fn().mockResolvedValue(0),
        $queryRawUnsafe: jest.fn().mockResolvedValue([]),
      }
      const w = new PayrollMatchWorker(prisma as never, {} as never)
      expect(await w.runDue(5)).toBe(0)
      expect(prisma.$queryRawUnsafe).toHaveBeenCalledWith(
        READ_CLAIM_SQL,
        5,
        MAX_READ_ATTEMPTS,
        'r2:ad-dev-fictional'
      )
      delete process.env.R2_DOCUMENTS_BUCKET
      expect(storageName()).toBe(`local:${hostname()}`)
    } finally {
      if (bucket === undefined) delete process.env.R2_DOCUMENTS_BUCKET
      else process.env.R2_DOCUMENTS_BUCKET = bucket
    }
  })
})
