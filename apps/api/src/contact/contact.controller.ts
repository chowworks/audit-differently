import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Logger,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import {
  CONTACT_PAGE_MAX,
  CONTACT_PAGE_PATTERN,
  CONTACT_TOPICS,
  CONTACT_TOPIC_LABELS,
  type ContactTopic,
} from '@ad/types'

/**
 * What the contact form posts. `website` is a honeypot: hidden from people, so only a bot fills it.
 * `category` is one of CONTACT_TOPICS ('question' when absent); `page` is the path a broken-link report is about.
 */
export interface ContactRequest {
  name?: unknown
  email?: unknown
  organization?: unknown
  message?: unknown
  category?: unknown
  page?: unknown
  website?: unknown
}

export interface ContactMessage {
  name: string
  email: string
  organization: string
  message: string
  category: ContactTopic
  /** '' when the message is not about a page. */
  page: string
}

const LIMITS = { name: 120, email: 254, organization: 160, message: 4000 }
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** One line of text: every control character goes, newlines included, so nothing can start a new header line. */
const oneLine = (v: unknown) =>
  typeof v === 'string'
    ? v
        // eslint-disable-next-line no-control-regex -- removing control characters is the point
        .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    : ''

/** Free text: keeps line breaks and tabs, drops every other control character. */
const text = (v: unknown) =>
  typeof v === 'string'
    ? v
        .replace(/\r\n?/g, '\n')
        // eslint-disable-next-line no-control-regex -- removing control characters is the point
        .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
        .trim()
    : ''

/** The cleaned message, or a 400 that says in plain words what to fix. */
export function validateContact(body: ContactRequest): ContactMessage {
  const out = {
    name: oneLine(body.name),
    email: oneLine(body.email),
    organization: oneLine(body.organization),
    message: text(body.message),
    category: body.category === undefined ? 'question' : body.category,
    page: oneLine(body.page),
  }
  const problems: string[] = []
  if (!out.name) problems.push('Enter your name.')
  else if (out.name.length > LIMITS.name)
    problems.push(`Keep your name to ${LIMITS.name} characters.`)
  if (!EMAIL.test(out.email) || out.email.length > LIMITS.email)
    problems.push('Enter a valid email address.')
  if (out.organization.length > LIMITS.organization)
    problems.push(`Keep the organization to ${LIMITS.organization} characters.`)
  if (!out.message) problems.push('Enter a message.')
  else if (out.message.length > LIMITS.message)
    problems.push(`Keep the message to ${LIMITS.message} characters.`)
  if (!CONTACT_TOPICS.includes(out.category as ContactTopic)) problems.push('Choose a topic.')
  if (
    body.page !== undefined &&
    (typeof body.page !== 'string' ||
      out.page.length > CONTACT_PAGE_MAX ||
      !CONTACT_PAGE_PATTERN.test(out.page))
  )
    problems.push('The page address is not valid.')
  if (problems.length) throw new BadRequestException({ message: problems.join(' ') })
  return out as ContactMessage
}

/**
 * The public contact form (the only route without AuthenticatedGuard besides health and the local file link):
 * a visitor writes to the team without an email client. Sent through Resend's HTTP API as plain text, to
 * CONTACT_TO_EMAIL with the visitor as reply-to. Nothing is stored, and the message body and the visitor's
 * address are never logged.
 */
@Controller('contact')
export class ContactController {
  private readonly logger = new Logger(ContactController.name)

  @Throttle({ default: { limit: 5, ttl: 600_000 } })
  @Post()
  @HttpCode(204)
  async send(@Body() body: ContactRequest = {}): Promise<void> {
    // A bot filled the hidden field: answer as if sent, send nothing.
    if (typeof body.website === 'string' ? body.website.trim() : body.website) return
    const msg = validateContact(body)
    const key = process.env.RESEND_API_KEY
    const from = process.env.CONTACT_FROM_EMAIL
    if (!key || !from) {
      this.logger.warn('Contact form used but RESEND_API_KEY or CONTACT_FROM_EMAIL is not set.')
      throw new ServiceUnavailableException({
        code: 'contact_unavailable',
        message: "The form isn't available right now; please try again later.",
      })
    }
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to: [process.env.CONTACT_TO_EMAIL || 'info@auditdifferently.tech'],
        reply_to: msg.email,
        subject: `Audit Differently contact (${CONTACT_TOPIC_LABELS[msg.category]}): ${msg.name}`,
        text: [
          `Topic: ${CONTACT_TOPIC_LABELS[msg.category]}`,
          ...(msg.page ? [`Page: ${msg.page}`] : []),
          `Name: ${msg.name}`,
          `Email: ${msg.email}`,
          `Organization: ${msg.organization || '(none given)'}`,
          '',
          msg.message,
        ].join('\n'),
      }),
    }).catch(() => null)
    if (!response?.ok) {
      this.logger.error(
        `Contact form: Resend did not accept the email (${response?.status ?? 'no response'}).`
      )
      throw new ServiceUnavailableException({
        code: 'contact_unavailable',
        message: "The form isn't available right now; please try again later.",
      })
    }
  }
}
