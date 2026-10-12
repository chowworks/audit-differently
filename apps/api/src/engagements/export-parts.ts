import { strToU8 } from 'fflate'
import { zipEntries, type ZipSource } from './zip-stream'

/**
 * A big export is split into several zips so none passes the 4 GB a plain zip can hold, and no single request
 * runs for many minutes. At most about this many bytes of source data go in one part (uploads are capped at
 * 25 MB, so a part can always be filled).
 */
export const PART_SOURCE_LIMIT = 1_500_000_000

/** A stored object to fetch: its path in the zip, its storage key and its size in bytes. */
export type ExportObject = [path: string, key: string, size: number]

/** What an export holds: the text files made here, and the stored objects to fetch. */
export interface ExportContent {
  name: string
  text: Record<string, Uint8Array>
  objects: ExportObject[]
}

/** Which stored objects go in part `n`. Part 1 also holds every text file. */
export interface PartLayout {
  n: number
  fileName: string
  /** Bytes of source data in the part (before the zip's own overhead and deflate of the text files). */
  sourceBytes: number
  paths: string[]
}

/** "<name>.zip" for a single part; "<name> - part 2 of 3.zip" for several. */
export const partFileName = (name: string, n: number, total: number) =>
  total === 1 ? name : name.replace(/(\.zip)?$/i, ` - part ${n} of ${total}.zip`)

/**
 * Fills parts in order: a part takes the next file while it stays within the limit, then the next part starts.
 * Files keep the order of the plan, so related records stay together. There is always at least one part.
 */
export function splitParts(content: ExportContent, limit = PART_SOURCE_LIMIT): PartLayout[] {
  const textBytes = Object.values(content.text).reduce((t, b) => t + b.length, 0)
  const groups: { bytes: number; paths: string[] }[] = [{ bytes: textBytes, paths: [] }]
  for (const [path, , size] of content.objects) {
    let cur = groups[groups.length - 1]!
    if (cur.paths.length > 0 && cur.bytes + size > limit) {
      cur = { bytes: 0, paths: [] }
      groups.push(cur)
    }
    cur.paths.push(path)
    cur.bytes += size
  }
  return groups.map((g, i) => ({
    n: i + 1,
    fileName: partFileName(content.name, i + 1, groups.length),
    sourceBytes: g.bytes,
    paths: g.paths,
  }))
}

/** The note every part of a split export carries, so any one of them says where the rest are. */
function partNote(layouts: PartLayout[], n: number): string {
  const mine = layouts[n - 1]!
  return [
    `PART ${n} OF ${layouts.length}`,
    '',
    'This export is split into several zips so each stays a size a browser and a computer can handle.',
    'Every part opens on its own. Together the parts hold every file, each in exactly one part.',
    n === 1
      ? 'This part also holds the README and the CSV files (Index.csv lists every file of all parts).'
      : 'The README and the CSV files are in part 1.',
    '',
    `FILES IN THIS PART (${mine.paths.length})`,
    ...mine.paths,
    '',
  ].join('\n')
}

/**
 * Part `n` as zip chunks, one stored object in memory at a time. Throws when a path the layout names is no
 * longer in the plan. A single part is the plain package: no PART.txt.
 */
export function streamPart(
  content: ExportContent,
  layouts: PartLayout[],
  n: number,
  read: (key: string) => Promise<Uint8Array>
): AsyncGenerator<Uint8Array> {
  const layout = layouts[n - 1]
  if (!layout) throw new Error(`No part ${n}`)
  const byPath = new Map(content.objects.map((o) => [o[0], o[1]]))
  const entries: [string, ZipSource][] = []
  if (layouts.length > 1) entries.push(['PART.txt', strToU8(partNote(layouts, n))])
  if (n === 1) entries.push(...Object.entries(content.text))
  for (const path of layout.paths) {
    const key = byPath.get(path)
    if (key === undefined) throw new Error(`${path} is no longer part of the export`)
    entries.push([path, async () => new Uint8Array(await read(key))])
  }
  return zipEntries(entries)
}
