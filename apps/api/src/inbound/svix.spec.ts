import { createHmac } from 'node:crypto'
import { verifySvix } from './svix'

/** The provider's webhook signature (Svix): the exact bytes, the right key, a fresh timestamp, any v1 signature. */
const key = Buffer.from('a fictional signing key for the tests')
const SECRET = `whsec_${key.toString('base64')}`
const body = Buffer.from('{"type":"email.received","data":{"email_id":"em-1"}}')
const NOW = 1_790_000_000

const sign = (id: string, ts: number, raw: Buffer, k = key) =>
  createHmac('sha256', k).update(`${id}.${ts}.`).update(raw).digest('base64')
const headers = (ts = NOW, sig = sign('msg_1', ts, body)) => ({
  id: 'msg_1',
  timestamp: String(ts),
  signature: `v1,${sig}`,
})

describe('verifySvix', () => {
  it('accepts a good signature, also as one of several', () => {
    expect(verifySvix(SECRET, headers(), body, NOW)).toBe(true)
    const several = { ...headers(), signature: `v1,bm90IGl0 v1,${sign('msg_1', NOW, body)}` }
    expect(verifySvix(SECRET, several, body, NOW)).toBe(true)
  })

  it('refuses a bad signature, another key, changed bytes, or a missing header', () => {
    expect(verifySvix(SECRET, { ...headers(), signature: 'v1,bm90IGl0' }, body, NOW)).toBe(false)
    const other = sign('msg_1', NOW, body, Buffer.from('another key'))
    expect(verifySvix(SECRET, headers(NOW, other), body, NOW)).toBe(false)
    expect(verifySvix(SECRET, headers(), Buffer.from(`${body.toString()} `), NOW)).toBe(false)
    expect(verifySvix(SECRET, { ...headers(), id: 'msg_2' }, body, NOW)).toBe(false)
    expect(verifySvix(SECRET, { ...headers(), signature: undefined }, body, NOW)).toBe(false)
    expect(
      verifySvix(SECRET, { ...headers(), signature: `v2,${sign('msg_1', NOW, body)}` }, body, NOW)
    ).toBe(false)
  })

  it('refuses a timestamp more than five minutes off, either way', () => {
    expect(verifySvix(SECRET, headers(NOW - 299), body, NOW)).toBe(true)
    expect(verifySvix(SECRET, headers(NOW - 301), body, NOW)).toBe(false)
    expect(verifySvix(SECRET, headers(NOW + 301), body, NOW)).toBe(false)
    expect(verifySvix(SECRET, { ...headers(), timestamp: 'soon' }, body, NOW)).toBe(false)
  })
})
