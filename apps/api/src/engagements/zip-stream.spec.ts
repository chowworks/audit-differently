import { strFromU8, strToU8, unzipSync } from 'fflate'
import { zipEntries } from './zip-stream'

describe('zipEntries', () => {
  it('makes a zip that opens, fetching each stored object only when its turn comes', async () => {
    const order: string[] = []
    const pdf = new Uint8Array(200_000).map((_, i) => i % 251)
    const chunks: Uint8Array[] = []
    for await (const c of zipEntries([
      ['a/one.pdf', async () => (order.push('one'), pdf)],
      ['a/Index.csv', strToU8('"x","y"\r\n'.repeat(500))],
      ['a/two.png', async () => (order.push('two'), strToU8('png bytes'))],
    ])) {
      order.push(`chunk ${chunks.length}`)
      chunks.push(c)
    }
    // The second object is not fetched until the first has been written out.
    expect(order.indexOf('two')).toBeGreaterThan(order.indexOf('one'))
    expect(
      order.slice(order.indexOf('one'), order.indexOf('two')).some((x) => x.startsWith('chunk'))
    ).toBe(true)
    const total = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
    let at = 0
    for (const c of chunks) {
      total.set(c, at)
      at += c.length
    }
    const zip = unzipSync(total)
    expect(zip['a/one.pdf']).toEqual(pdf)
    expect(strFromU8(zip['a/two.png'])).toBe('png bytes')
    expect(strFromU8(zip['a/Index.csv'])).toBe('"x","y"\r\n'.repeat(500))
  })

  it('fails the stream when an object cannot be fetched', async () => {
    const run = async () => {
      for await (const c of zipEntries([['a.pdf', async () => Promise.reject(new Error('gone'))]]))
        void c
    }
    await expect(run()).rejects.toThrow('gone')
  })
})
