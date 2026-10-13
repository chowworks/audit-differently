import 'reflect-metadata'
import { BadRequestException, Logger, ServiceUnavailableException } from '@nestjs/common'
import { ContactController, validateContact } from './contact.controller'

const good = {
  name: 'Robin Example',
  email: 'robin@example.org',
  organization: 'Example Training Co',
  message: 'Hello,\nwe would like a demo.',
}

describe('validateContact', () => {
  it.each([
    ['no name', { ...good, name: '  ' }],
    ['a long name', { ...good, name: 'x'.repeat(121) }],
    ['a bad email', { ...good, email: 'robin@' }],
    ['no email', { ...good, email: undefined }],
    ['a long organization', { ...good, organization: 'x'.repeat(161) }],
    ['no message', { ...good, message: '' }],
    ['a long message', { ...good, message: 'x'.repeat(4001) }],
    ['a message that is not text', { ...good, message: { html: '<b>' } }],
    ['an unknown category', { ...good, category: 'urgent' }],
    ['a category that is not text', { ...good, category: ['demo'] }],
    ['an empty category', { ...good, category: '' }],
    ['a page that is not a path', { ...good, page: 'example.org/x' }],
    ['a full address as the page', { ...good, page: 'https://example.org/x' }],
    ['a page with a query string', { ...good, page: '/x?token=abc' }],
    ['a page with a hash', { ...good, page: '/x#token' }],
    ['a page with a space', { ...good, page: '/a b' }],
    ['a long page', { ...good, page: '/' + 'x'.repeat(300) }],
    ['a page that is not text', { ...good, page: ['/x'] }],
    ['an empty page', { ...good, page: '' }],
  ])('refuses %s with 400', (_, body) => {
    expect(() => validateContact(body)).toThrow(BadRequestException)
  })

  it('strips control characters: none in one-line fields, line breaks kept in the message', () => {
    const out = validateContact({
      ...good,
      name: 'Robin\r\nBcc: x@example.org',
      message: 'one\u0000\r\ntwo\u0007',
    })
    expect(out.name).toBe('Robin Bcc: x@example.org')
    expect(out.message).toBe('one\ntwo')
  })

  it('accepts an empty organization', () => {
    expect(validateContact({ ...good, organization: undefined }).organization).toBe('')
  })

  it('treats a missing category as a general question, with no page', () => {
    const out = validateContact(good)
    expect(out.category).toBe('question')
    expect(out.page).toBe('')
  })

  it.each(['demo', 'question', 'broken-link', 'privacy', 'account', 'other'])(
    'accepts the %s category',
    (category) => {
      expect(validateContact({ ...good, category }).category).toBe(category)
    }
  )

  it('accepts a path as the page, up to 300 characters', () => {
    expect(validateContact({ ...good, page: '/engagements/old-link' }).page).toBe(
      '/engagements/old-link'
    )
    const long = '/' + 'x'.repeat(299)
    expect(validateContact({ ...good, page: long }).page).toBe(long)
  })
})

describe('ContactController', () => {
  const env = { ...process.env }
  let fetchMock: jest.Mock
  let warn: jest.SpyInstance
  let error: jest.SpyInstance
  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 })
    global.fetch = fetchMock as unknown as typeof fetch
    process.env.RESEND_API_KEY = 're_test_fictional'
    process.env.CONTACT_FROM_EMAIL = 'Audit Differently <form@example.org>'
    delete process.env.CONTACT_TO_EMAIL
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
  })
  afterEach(() => {
    process.env = { ...env }
    warn.mockRestore()
    error.mockRestore()
  })

  it('answers 204 to a filled honeypot and sends nothing', async () => {
    await expect(new ContactController().send({ ...good, website: 'spam.example' })).resolves.toBe(
      undefined
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('answers 503 contact_unavailable when Resend is not configured, and sends nothing', async () => {
    delete process.env.RESEND_API_KEY
    const err = await new ContactController().send({ ...good }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ServiceUnavailableException)
    expect((err as ServiceUnavailableException).getResponse()).toMatchObject({
      code: 'contact_unavailable',
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/robin|demo/i)
  })

  it('does not send an invalid message', async () => {
    await expect(new ContactController().send({ ...good, email: 'nope' })).rejects.toThrow(
      BadRequestException
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends once through Resend with the right fields', async () => {
    await new ContactController().send({ ...good, website: '' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.resend.com/emails')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer re_test_fictional')
    const sent = JSON.parse(init.body as string)
    expect(sent).toEqual({
      from: 'Audit Differently <form@example.org>',
      to: ['info@auditdifferently.tech'],
      reply_to: 'robin@example.org',
      subject: 'Audit Differently contact (A general question): Robin Example',
      text: expect.stringContaining('we would like a demo.'),
    })
    expect(sent.text).toContain('Organization: Example Training Co')
    expect(sent.text).toContain('Topic: A general question')
    expect(sent.text).not.toContain('Page:')
  })

  it('puts the category in the subject and the page in the body', async () => {
    await new ContactController().send({ ...good, category: 'broken-link', page: '/old/report' })
    const sent = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string)
    expect(sent.subject).toBe(
      'Audit Differently contact (A broken link or missing page): Robin Example'
    )
    expect(sent.text).toContain('Topic: A broken link or missing page')
    expect(sent.text).toContain('Page: /old/report')
  })

  it('does not send a message with an invalid category or page', async () => {
    await expect(new ContactController().send({ ...good, category: 'urgent' })).rejects.toThrow(
      BadRequestException
    )
    await expect(new ContactController().send({ ...good, page: '/x?token=abc' })).rejects.toThrow(
      BadRequestException
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('answers 503 when Resend refuses the email', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 422 })
    await expect(new ContactController().send({ ...good })).rejects.toThrow(
      ServiceUnavailableException
    )
    expect(JSON.stringify(error.mock.calls)).not.toMatch(/robin|demo/i)
  })

  it('is throttled to 5 per 10 minutes', () => {
    const handler = ContactController.prototype.send
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler)).toBe(5)
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', handler)).toBe(600_000)
  })
})
