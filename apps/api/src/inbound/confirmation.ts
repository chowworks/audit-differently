import { Injectable, Logger } from '@nestjs/common'
import {
  DOCUMENT_KIND_LABELS,
  EMAILED_KIND_WORDS,
  emailedFolder,
  type EmailedKind,
} from '@ad/types'
import { monthName } from '../core/changes'
import { INBOUND_TIME_ZONE } from './subject'

/** What became of an email from a verified member: filed, left for a person, or nothing in it could be filed. */
export type Outcome = 'filed' | 'unmatched' | 'nothing'

export interface Confirmation {
  to: string
  outcome: Outcome
  receivedAt: Date
  workspaceId: string
  /** The sender is an owner: their link opens Month End Close; anyone else's opens the inbox they can read. */
  owner: boolean
  kind: EmailedKind
  /** A payroll file's month (or a receipt's, when the subject named one). */
  period: string | null
  /** A receipt's engagement; null for receipts filed to the workspace's Receipts in Month End Close. */
  engagementName: string | null
  /** How many files the email filed that were not on file before. */
  filed: number
  /** How many of its files the folder had already (the same contents): pointed at, not kept twice. */
  alreadyOnFile: number
  /** The months its receipts went into. */
  periods: string[]
  /** A receipt's month page, when they went into one engagement month; null for the workspace's Receipts. */
  reportId: string | null
  /** How many attachments were passed over. */
  skipped: number
  /** Why it was left for a person, or why nothing could be filed: our own words, never the sender's. */
  reason: string | null
}

/**
 * The confirmation's settings: Resend's sending key (the contact form's RESEND_API_KEY), the address it is sent from
 * (RECEIPTS_REPLY_FROM, on a domain Resend may send from) and the web app's address for the link (the first exact https
 * address of FRONTEND_URL, else its first exact one: a laptop's http://localhost). With any missing, nothing is sent
 * and everything else works as before.
 */
export function confirmationConfig(env: NodeJS.ProcessEnv = process.env) {
  const key = env.RESEND_API_KEY?.trim()
  const from = env.RECEIPTS_REPLY_FROM?.trim()
  const exact = (env.FRONTEND_URL ?? '')
    .split(',')
    .map((u) => u.trim().replace(/\/+$/, ''))
    .filter((u) => /^https?:\/\/[^*\s]+$/.test(u))
  const app = exact.find((u) => u.startsWith('https://')) ?? exact[0]
  if (!key || !from || !app) return null
  return { key, from, app }
}

/** The subjects the confirmation is sent with, as patterns: an email back with one of them is our own coming round. */
const OWN_SUBJECTS = [
  /\bFiled: \d+ \S.* (for|in) \S/i,
  /\bAlready on file: \d+ \S.* for \S/i,
  /Your emailed documents need filing/i,
  /Nothing was filed from your email/i,
]

/**
 * Whether a subject is one of our confirmations' (also under "Re:", "Fwd:" or "Automatic reply:"): an auto-reply or a
 * forward of a confirmation sent back to the receipts address is never filed or answered, so the two never loop.
 */
export const isOwnConfirmation = (subject: string | null) =>
  !!subject && OWN_SUBJECTS.some((p) => p.test(subject.slice(0, 300)))

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** The words a person puts in the subject next time, from the folder list. */
const WORDS = (Object.values(EMAILED_KIND_WORDS) as (readonly string[])[])
  .map((w) => w[0])
  .filter(Boolean)
  .join(', ')

/**
 * The confirmation's subject and text (issue #82): where the files went (folder, month, engagement), how many, and a
 * link to fix it. Never a file name (a pay stub's is often a person's name), never the email's own subject, never an
 * amount or a vendor read from a receipt, and never a document or a link to one: the link opens a page that asks the
 * person to sign in (CLAUDE.md: no document leaves by email; notifications carry links).
 */
export function confirmationEmail(c: Confirmation, app: string): { subject: string; text: string } {
  const when = new Intl.DateTimeFormat('en-US', {
    timeZone: INBOUND_TIME_ZONE,
    dateStyle: 'long',
    timeStyle: 'short',
  }).format(c.receivedAt)
  const inbox = `${app}/workspaces/${c.workspaceId}#receipts`
  const payroll = c.kind !== 'receipt'
  const folder = emailedFolder(c.kind).name
  const label = payroll ? DOCUMENT_KIND_LABELS[c.kind] : 'receipt'
  const skipped = c.skipped
    ? [`${plural(c.skipped, 'attachment was', 'attachments were')} not filed; the inbox says why.`]
    : []
  const tip = [
    'Next time, one word in the subject says what the files are, and you can name the month:',
    `${WORDS} (for example "timesheets October"). With no word, they are filed as receipts; with no month, in this month.`,
  ]
  if (c.outcome === 'unmatched')
    return {
      subject: 'Your emailed documents need filing',
      text: [
        `We could not tell where the files in your email of ${when} go: ${c.reason ?? 'see the inbox'}.`,
        '',
        'File them from Emailed documents on your workspace page:',
        inbox,
        '',
        ...tip,
      ].join('\n'),
    }
  if (c.outcome === 'nothing')
    return {
      subject: 'Nothing was filed from your email',
      text: [
        `Nothing in your email of ${when} could be filed: ${c.reason ?? 'no file we take was attached'}.`,
        payroll
          ? `${folder} takes ${emailedFolder(c.kind)
              .extensions.filter((e) => e !== 'jpeg')
              .map((e) => e.toUpperCase())
              .join(', ')} files.`
          : 'Receipts are PDF, PNG or JPG files.',
        '',
        'See it in Emailed documents on your workspace page:',
        inbox,
      ].join('\n'),
    }
  if (payroll) {
    const month = c.period ? monthName(c.period) : 'this month'
    const fix = c.owner
      ? `${app}/workspaces/${c.workspaceId}/payroll${c.period ? `?period=${c.period}` : ''}`
      : inbox
    const onFile = plural(c.alreadyOnFile, 'file was', 'files were')
    return {
      subject: c.filed
        ? `Filed: ${plural(c.filed, label)} for ${month}`
        : `Already on file: ${plural(c.alreadyOnFile, label)} for ${month}`,
      text: [
        c.filed
          ? `We filed ${plural(c.filed, 'file')} from your email of ${when}:`
          : `Every file in your email of ${when} was already on file, so nothing new was kept:`,
        '',
        `Where: ${folder}, ${month}, in Month End Close's File Management.`,
        ...(c.filed && c.alreadyOnFile ? [`${onFile} already on file in ${folder}.`] : []),
        ...(c.filed
          ? [`They count once an owner matches ${month} again (Re-match with same files).`]
          : []),
        ...skipped,
        '',
        c.owner
          ? 'Wrong folder or month? Open File Management and use the … menu beside a file to move or rename it:'
          : 'Wrong folder or month? An owner can move it from Month End Close. Your inbox shows where it went:',
        fix,
        '',
        ...tip,
      ].join('\n'),
    }
  }
  const months = c.periods.length ? c.periods.map(monthName).join(', ') : 'its month'
  if (!c.engagementName) {
    // The workspace's Receipts in Month End Close (owner's decision, 2026-11-17): an owner matches the books' bills.
    const month = c.periods.length ? c.periods.map(monthName).join(', ') : 'this month'
    const one = c.periods.length === 1 ? c.periods[0]! : null
    const fix = c.owner
      ? `${app}/workspaces/${c.workspaceId}/payroll${one ? `?period=${one}` : ''}`
      : inbox
    const them = c.filed + c.alreadyOnFile === 1 ? 'it' : 'them'
    return {
      subject: c.filed
        ? `Filed: ${plural(c.filed, 'receipt')} for ${month}`
        : `Already on file: ${plural(c.alreadyOnFile, 'receipt')} for ${month}`,
      text: [
        c.filed
          ? `We filed ${plural(c.filed, 'receipt')} from your email of ${when}:`
          : `Every receipt in your email of ${when} was already on file, so nothing new was kept:`,
        '',
        `Where: ${folder}, ${month}, in Month End Close. An owner matches ${them} to the books' bills.`,
        ...(c.filed && c.alreadyOnFile
          ? [
              `${plural(c.alreadyOnFile, 'receipt was', 'receipts were')} already on file in ${folder}.`,
            ]
          : []),
        ...skipped,
        '',
        c.owner
          ? `Open Month End Close to match ${them} to the bills:`
          : 'Your inbox shows where it went:',
        fix,
        '',
        ...tip,
      ].join('\n'),
    }
  }
  const fix = c.reportId ? `${app}/reports/${c.reportId}` : inbox
  return {
    subject: `Filed: ${plural(c.filed, 'receipt')} in ${c.engagementName}`,
    text: [
      `We filed ${plural(c.filed, 'receipt')} from your email of ${when}:`,
      '',
      `Where: ${c.engagementName}, ${months}, matched to its expenses where one fits.`,
      ...skipped,
      '',
      'Wrong engagement or month? Open it here:',
      fix,
      '',
      ...tip,
    ].join('\n'),
  }
}

/**
 * Sends the confirmation through Resend's HTTP API, as plain text, to the verified sender alone, marked
 * `Auto-Submitted: auto-generated` (RFC 3834) so their mail system sends no automatic reply to it, and the inbound
 * handler refuses one that comes back anyway.
 */
@Injectable()
export class InboundConfirmation {
  private readonly logger = new Logger(InboundConfirmation.name)

  enabled(): boolean {
    return !!confirmationConfig()
  }

  async send(c: Confirmation): Promise<void> {
    const cfg = confirmationConfig()
    if (!cfg) return
    const { subject, text } = confirmationEmail(c, cfg.app)
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: cfg.from,
        to: [c.to],
        subject,
        text,
        headers: { 'Auto-Submitted': 'auto-generated' },
      }),
    }).catch(() => null)
    // Never the address or the words: the status alone.
    if (!response?.ok)
      this.logger.warn(`A confirmation was not accepted (${response?.status ?? 'no response'})`)
  }
}
