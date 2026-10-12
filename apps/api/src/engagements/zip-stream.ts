import { Zip, ZipDeflate, ZipPassThrough } from 'fflate'

/** One file of a package: its bytes, or a function that fetches them when its turn comes. */
export type ZipSource = Uint8Array | (() => Promise<Uint8Array>)

const TEXT = /\.(csv|txt)$/i

/**
 * A zip made one file at a time: each stored object is fetched, written out and let go before the next is read, so
 * memory is the largest single file (uploads are capped at 25 MB), not the whole package. Uploads are already
 * compressed (pdf, png, jpg, xlsx, docx), so they are stored; the CSV and text files are deflated. Not zip64: a
 * package over 4 GB cannot be made.
 */
export async function* zipEntries(
  entries: Iterable<[string, ZipSource]>
): AsyncGenerator<Uint8Array> {
  const queue: Uint8Array[] = []
  let failure: Error | undefined
  const zip = new Zip((err, chunk) => {
    if (err) failure = err
    else queue.push(chunk)
  })
  const drain = function* () {
    if (failure) throw failure
    while (queue.length > 0) yield queue.shift()!
  }
  for (const [name, source] of entries) {
    const data = typeof source === 'function' ? await source() : source
    const file = TEXT.test(name) ? new ZipDeflate(name, { level: 6 }) : new ZipPassThrough(name)
    zip.add(file)
    file.push(data, true)
    yield* drain()
  }
  zip.end()
  yield* drain()
}
