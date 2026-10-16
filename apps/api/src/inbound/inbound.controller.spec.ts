import { createHmac } from 'node:crypto'
import { BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common'
import { ThrottlerException } from '@nestjs/throttler'
import { InboundWebhookController, UNSIGNED_PER_MINUTE } from './inbound.controller'

/** The webhook: off is a 404; a call without the provider's signature is a 401; a signed email.received is queued. */
const key = Buffer.from('a fictional signing key for the tests')
const body = Buffer.from(
  JSON.stringify({
    type: 'email.received',
    data: { email_id: 'em-1', from: 'a@b.example.org', to: ['x@receipts.example.org'] },
  })
)
const signed = (raw: Buffer, ts = Math.floor(Date.now() / 1000)) => ({
  body: raw,
  headers: {
    'svix-id': 'msg_1',
    'svix-timestamp': String(ts),
    'svix-signature': `v1,${createHmac('sha256', key).update(`msg_1.${ts}.`).update(raw).digest('base64')}`,
  },
})

describe('POST /api/inbound/resend', () => {
  const env = { ...process.env }
  const inbound = { enqueue: jest.fn(async () => true) }
  let c = new InboundWebhookController(inbound as never)
  beforeEach(() => {
    c = new InboundWebhookController(inbound as never)
    inbound.enqueue.mockClear()
    process.env.RESEND_RECEIVING_API_KEY = 're_test_fictional'
    process.env.RESEND_WEBHOOK_SECRET = `whsec_${key.toString('base64')}`
    process.env.RECEIPTS_DOMAIN = 'receipts.example.org'
  })
  afterEach(() => {
    process.env = { ...env }
  })

  it('queues a signed email.received and answers at once', async () => {
    await expect(c.resend(signed(body))).resolves.toEqual({ queued: true })
    expect(inbound.enqueue).toHaveBeenCalledWith(JSON.parse(body.toString()))
  })

  it('is a 404 while email in receipts is not set up', async () => {
    delete process.env.RESEND_WEBHOOK_SECRET
    await expect(c.resend(signed(body))).rejects.toThrow(NotFoundException)
    expect(inbound.enqueue).not.toHaveBeenCalled()
  })

  it('refuses a call that is not signed by the provider, or signed too long ago', async () => {
    await expect(c.resend({ ...signed(body), headers: {} })).rejects.toThrow(UnauthorizedException)
    const changed = { ...signed(body), body: Buffer.from(`${body.toString()} `) }
    await expect(c.resend(changed)).rejects.toThrow(UnauthorizedException)
    const stale = signed(body, Math.floor(Date.now() / 1000) - 600)
    await expect(c.resend(stale)).rejects.toThrow(UnauthorizedException)
    expect(inbound.enqueue).not.toHaveBeenCalled()
  })

  it('answers 200 to a signed event of another type, and queues nothing', async () => {
    inbound.enqueue.mockResolvedValueOnce(false)
    const other = Buffer.from(JSON.stringify({ type: 'email.delivered', data: {} }))
    await expect(c.resend(signed(other))).resolves.toEqual({ queued: false })
  })

  it('throttles unsigned calls per address, never the signed ones of the provider', async () => {
    const unsigned = { ...signed(body), headers: {}, ip: '203.0.113.7' }
    for (let i = 0; i < UNSIGNED_PER_MINUTE; i++)
      await expect(c.resend(unsigned)).rejects.toThrow(UnauthorizedException)
    await expect(c.resend(unsigned)).rejects.toThrow(ThrottlerException)
    // The provider shares that address with others: its signed calls still go through.
    for (let i = 0; i < UNSIGNED_PER_MINUTE + 5; i++)
      await expect(c.resend({ ...signed(body), ip: '203.0.113.7' })).resolves.toEqual({
        queued: true,
      })
    await expect(c.resend({ ...unsigned, ip: '198.51.100.2' })).rejects.toThrow(
      UnauthorizedException
    )
  })

  it('refuses a signed body that is not JSON, or a body that was parsed already', async () => {
    await expect(c.resend(signed(Buffer.from('not json')))).rejects.toThrow(BadRequestException)
    await expect(c.resend({ ...signed(body), body: {} })).rejects.toThrow(BadRequestException)
  })
})
