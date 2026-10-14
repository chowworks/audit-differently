import { NotFoundException } from '@nestjs/common'
import { PassThrough } from 'node:stream'
import { strToU8, unzipSync } from 'fflate'
import { EngagementsController } from './engagements.controller'
import { splitParts, streamPart, type ExportContent } from './export-parts'

/** The audit package download: one zip as ever, or the list of parts when it is too big for one. */
function setup(sizes: number[], limit: number) {
  const plan: ExportContent & { files: number } = {
    name: 'Pathway - audit package.zip',
    text: { 'p/README.txt': strToU8('readme') },
    objects: sizes.map((n, i) => [`p/f${i}.pdf`, `k${i}`, n]),
    files: sizes.length,
  }
  const audit = {
    plan: jest.fn().mockResolvedValue(plan),
    parts: () => splitParts(plan, limit),
    streamPart: (_p: unknown, layouts: ReturnType<typeof splitParts>, n: number) =>
      streamPart(plan, layouts, n, async (k) => strToU8(`bytes of ${k}`)),
    logExport: jest.fn(),
  }
  const callers = { load: jest.fn().mockResolvedValue({}) }
  const controller = new EngagementsController({} as never, audit as never, callers as never)
  const res = Object.assign(new PassThrough(), {
    json: jest.fn(),
    setHeader: jest.fn(),
    headersSent: false,
  })
  const body: Buffer[] = []
  res.on('data', (c: Buffer) => body.push(c))
  return { controller, res, audit, body }
}

describe('GET audit-package', () => {
  it('sends one small package as a single zip, as before', async () => {
    const { controller, res, body, audit } = setup([10, 10], 1000)
    await controller.auditPackage('u', 'e-1', undefined, res as never)
    expect(Object.keys(unzipSync(new Uint8Array(Buffer.concat(body)))).sort()).toEqual([
      'p/README.txt',
      'p/f0.pdf',
      'p/f1.pdf',
    ])
    expect(audit.logExport).toHaveBeenCalledTimes(1)
    expect(audit.logExport).toHaveBeenCalledWith({}, expect.anything(), undefined)
    expect(res.json).not.toHaveBeenCalled()
  })

  it('lists the parts of a big package, and sends a part on ?part=n', async () => {
    const big = setup([20, 20, 20], 55)
    await big.controller.auditPackage('u', 'e-1', undefined, big.res as never)
    expect(big.res.json).toHaveBeenCalledWith({
      parts: [
        expect.objectContaining({ n: 1, fileName: 'Pathway - audit package - part 1 of 2.zip' }),
        expect.objectContaining({ n: 2, fileName: 'Pathway - audit package - part 2 of 2.zip' }),
      ],
    })
    expect(big.audit.logExport).not.toHaveBeenCalled()
    await big.controller.auditPackage('u', 'e-1', '2', big.res as never)
    expect(Object.keys(unzipSync(new Uint8Array(Buffer.concat(big.body)))).sort()).toEqual([
      'PART.txt',
      'p/f2.pdf',
    ])
    // The part's own line: that part's layout, so it counts that part's files.
    expect(big.audit.logExport).toHaveBeenCalledTimes(1)
    expect(big.audit.logExport).toHaveBeenCalledWith({}, expect.anything(), {
      layout: expect.objectContaining({ n: 2, paths: ['p/f2.pdf'] }),
      total: 2,
    })
  })

  it.each(['0', '3', 'x', '1.5'])('answers 404 for part %s', async (part) => {
    const big = setup([20, 20, 20], 55)
    await expect(big.controller.auditPackage('u', 'e-1', part, big.res as never)).rejects.toThrow(
      NotFoundException
    )
  })
})
