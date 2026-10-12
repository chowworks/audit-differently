import { strFromU8, strToU8, unzipSync } from 'fflate'
import { PART_SOURCE_LIMIT, splitParts, streamPart, type ExportContent } from './export-parts'

const GB = 1_000_000_000
const content = (sizes: number[]): ExportContent => ({
  name: 'Pathway - audit package.zip',
  text: { 'p/README.txt': strToU8('readme'), 'p/Index.csv': strToU8('index') },
  objects: sizes.map((n, i) => [`p/file-${i}.pdf`, `key-${i}`, n]),
})

describe('splitting an export into parts', () => {
  it('keeps a small export in one part named as the package', () => {
    const parts = splitParts(content([1000, 2000]))
    expect(parts).toHaveLength(1)
    expect(parts[0]!.fileName).toBe('Pathway - audit package.zip')
    expect(parts[0]!.paths).toEqual(['p/file-0.pdf', 'p/file-1.pdf'])
  })

  it('still makes one part for an export with no stored files', () => {
    expect(splitParts(content([]))).toHaveLength(1)
  })

  it('splits many large files into parts under the limit, every file in exactly one', () => {
    const sizes = Array.from({ length: 400 }, (_, i) => 20_000_000 + (i % 5) * 1_000_000)
    const c = content(sizes)
    const parts = splitParts(c)
    expect(parts.length).toBeGreaterThan(3)
    for (const p of parts) expect(p.sourceBytes).toBeLessThanOrEqual(PART_SOURCE_LIMIT)
    const all = parts.flatMap((p) => p.paths)
    expect(all.sort()).toEqual(c.objects.map((o) => o[0]).sort())
    expect(new Set(all).size).toBe(all.length)
    expect(parts.map((p) => p.n)).toEqual(parts.map((_, i) => i + 1))
    expect(parts[1]!.fileName).toBe(`Pathway - audit package - part 2 of ${parts.length}.zip`)
  })

  it('never leaves a part empty, even for files at the cap', () => {
    const parts = splitParts(content([25_000_000, 25_000_000, 25_000_000]), 30_000_000)
    expect(parts.map((p) => p.paths.length)).toEqual([1, 1, 1])
  })

  it('fills in order: 1.4 GB then 0.2 GB starts a second part', () => {
    expect(splitParts(content([1.4 * GB, 0.2 * GB])).map((p) => p.paths.length)).toEqual([1, 1])
  })
})

describe('building a part', () => {
  const read = async (key: string) => strToU8(`bytes of ${key}`)
  const open = async (c: ExportContent, n: number, limit: number) => {
    const layouts = splitParts(c, limit)
    const chunks: Uint8Array[] = []
    for await (const ch of streamPart(c, layouts, n, read)) chunks.push(ch)
    const zip = new Uint8Array(chunks.reduce((t, ch) => t + ch.length, 0))
    let at = 0
    for (const ch of chunks) {
      zip.set(ch, at)
      at += ch.length
    }
    return { layouts, entries: unzipSync(zip) }
  }

  it('puts the CSVs and README in part 1 only, and a PART.txt in every part', async () => {
    const c = content([20, 20, 20])
    const first = await open(c, 1, 55)
    const second = await open(c, 2, 55)
    expect(first.layouts).toHaveLength(2)
    expect(Object.keys(first.entries).sort()).toEqual([
      'PART.txt',
      'p/Index.csv',
      'p/README.txt',
      'p/file-0.pdf',
      'p/file-1.pdf',
    ])
    expect(Object.keys(second.entries).sort()).toEqual(['PART.txt', 'p/file-2.pdf'])
    expect(strFromU8(second.entries['PART.txt']!)).toContain('PART 2 OF 2')
    expect(strFromU8(second.entries['PART.txt']!)).toContain('p/file-2.pdf')
    expect(strFromU8(second.entries['p/file-2.pdf']!)).toBe('bytes of key-2')
  })

  it('a single part is the plain package, without PART.txt', async () => {
    const { entries } = await open(content([20]), 1, 1000)
    expect(Object.keys(entries)).not.toContain('PART.txt')
  })

  it('refuses a part that does not exist or a file that has gone', () => {
    const c = content([20])
    expect(() => streamPart(c, splitParts(c), 2, read)).toThrow('No part 2')
    const layouts = splitParts(c)
    layouts[0]!.paths.push('p/gone.pdf')
    expect(() => streamPart(c, layouts, 1, read)).toThrow('no longer part')
  })
})
