import Anthropic from '@anthropic-ai/sdk'
import { Logger } from '@nestjs/common'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readReceipt, readText } from './read-receipt'

/** The SDK's client, with its messages.create replaced: no request ever leaves a test. */
const mockCreate = jest.fn()
const mockOptions: unknown[] = []
jest.mock('@anthropic-ai/sdk', () => {
  const actual = jest.requireActual('@anthropic-ai/sdk')
  class Mocked extends actual.default {
    constructor(options: object) {
      super(options)
      mockOptions.push(options)
      ;(this as unknown as { messages: unknown }).messages = {
        create: (...a: unknown[]) => mockCreate(...a),
      }
    }
  }
  return { ...actual, __esModule: true, default: Mocked }
})

/** Reading a receipt: the PDF's text by rules, Claude only with the key, and a personal document never. */
const fixture = (name: string) =>
  readFileSync(join(__dirname, '../../test/fixtures/receipts', name))
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const NO_KEY = {} as NodeJS.ProcessEnv
const KEY = { ANTHROPIC_API_KEY: 'test-key' } as NodeJS.ProcessEnv

const answer = (text: string, stop_reason = 'end_turn') => ({
  stop_reason,
  content: [{ type: 'text', text }],
})

beforeEach(() => {
  mockCreate.mockReset()
  mockOptions.length = 0
})

describe('readText', () => {
  it('takes the total, never the subtotal, the first date and the first line that names a business', () => {
    expect(
      readText(
        'Receipt\nPinecrest Coffee & Catering\n2026-09-24\nSubtotal 90.00\nTax 6.00\nTotal 96.00'
      )
    ).toEqual({ amount: 96, date: '2026-09-24', vendor: 'Pinecrest Coffee & Catering' })
  })

  it('leaves out what it cannot find', () => {
    expect(readText('Thank you')).toEqual({ amount: null, date: null, vendor: null })
  })
})

describe('readReceipt', () => {
  it.each([
    ['bright-path-office-supply.pdf', 212.18, '2026-09-02', 'Bright Path Office Supply'],
    ['summit-laptop-rentals.pdf', 1480, '2026-09-10', 'Summit Laptop Rentals'],
    ['fern-hollow-mileage.pdf', 86.25, '2026-09-16', 'Fern Hollow Mileage Service'],
  ])('reads %s from its text, without asking Claude', async (name, amount, date, vendor) => {
    const read = await readReceipt(
      { buffer: fixture(name), contentType: 'application/pdf', sensitivity: 'financial' },
      true,
      KEY
    )
    expect(read).toEqual({ amount, date, vendor, readBy: 'text' })
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('leaves a photo blank without the key', async () => {
    const read = await readReceipt(
      { buffer: PNG, contentType: 'image/png', sensitivity: 'financial' },
      true,
      NO_KEY
    )
    expect(read).toEqual({ amount: null, date: null, vendor: null, readBy: null })
    expect(mockCreate).not.toHaveBeenCalled()
    expect(mockOptions).toEqual([])
  })

  it('sends a photo to Claude with the key, and keeps what it answers', async () => {
    mockCreate.mockResolvedValue(
      answer('{"amount": 320, "date": "2026-09-14", "vendor": "Lakeside Transit Co."}')
    )
    const read = await readReceipt(
      { buffer: PNG, contentType: 'image/png', sensitivity: 'financial' },
      true,
      KEY
    )
    expect(read).toEqual({
      amount: 320,
      date: '2026-09-14',
      vendor: 'Lakeside Transit Co.',
      readBy: 'ai',
    })
    expect(mockOptions).toEqual([{ apiKey: 'test-key', timeout: 15_000, maxRetries: 1 }])
    const body = mockCreate.mock.calls[0][0]
    expect(body).toMatchObject({ model: 'claude-haiku-5-5', thinking: { type: 'disabled' } })
    expect(body.messages[0].content[0]).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') },
    })
  })

  it('falls back silently when Claude fails or answers nonsense', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    mockCreate
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Anthropic.APIError(500, undefined, 'boom', new Headers()))
      .mockRejectedValueOnce(new Anthropic.APIConnectionTimeoutError())
      .mockResolvedValueOnce(answer('I cannot read this'))
      .mockResolvedValueOnce(answer('{"amount": 320}', 'max_tokens'))
      .mockResolvedValueOnce(answer('{"amount": 320}', 'refusal'))
    for (let i = 0; i < 6; i++) {
      const read = await readReceipt(
        { buffer: PNG, contentType: 'image/png', sensitivity: 'financial' },
        true,
        KEY
      )
      expect(read.readBy).toBeNull()
    }
    expect(JSON.stringify(warn.mock.calls)).not.toContain('test-key')
    warn.mockRestore()
  })

  it('never sends a receipt to Claude without a yes, not even with the key', async () => {
    mockCreate.mockResolvedValue(answer('{"amount": 320, "date": "2026-09-14", "vendor": "X"}'))
    const photo = await readReceipt(
      { buffer: PNG, contentType: 'image/png', sensitivity: 'financial' },
      false,
      KEY
    )
    expect(photo).toEqual({ amount: null, date: null, vendor: null, readBy: null })
    // A PDF whose text gives only part: the text rules keep what they found, the rest is left to type.
    const partial = await readReceipt(
      {
        buffer: fixture('bright-path-office-supply.pdf'),
        contentType: 'application/pdf',
        sensitivity: 'financial',
      },
      false,
      KEY
    )
    expect(partial.readBy).toBe('text')
    expect(mockCreate).not.toHaveBeenCalled()
    expect(mockOptions).toEqual([])
  })

  it('never reads a personal document, not even with the key', async () => {
    mockCreate.mockResolvedValue(answer('{"amount": 1}'))
    const read = await readReceipt(
      {
        buffer: fixture('bright-path-office-supply.pdf'),
        contentType: 'application/pdf',
        sensitivity: 'personal',
      },
      true,
      KEY
    )
    expect(read).toEqual({ amount: null, date: null, vendor: null, readBy: null })
    expect(mockCreate).not.toHaveBeenCalled()
  })
})
