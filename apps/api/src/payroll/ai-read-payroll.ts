import Anthropic from '@anthropic-ai/sdk'
import { Logger } from '@nestjs/common'
import type { AiFileFacts, AiPersonFact, PayrollDocumentKind, StatementLine } from '@ad/types'
import { aiFailure } from '../imports/ai-guess'
import { datesOf } from './pay-runs'
import { amountPattern } from './statement-lines'

/**
 * Reading a payroll file with AI, when a person asked for it (GitHub issue #22; owner's decisions, 2026-10-19). The
 * file goes whole, in its own request, with what we already know: the names on the workspace's lists. The question is a
 * lookup: for each person on our lists the file shows, where is their pay, pay period and pay date; for a register, its
 * pay date, period and stated totals. Every value comes back with the words it was read from, and is kept only when
 * the file's own text shows it (`verify`): AI finds, the file proves. Nothing is remembered between requests, and no
 * two workspaces' files are ever in one request.
 */

const logger = new Logger('AiReadPayroll')
/** A model our provider keeps nothing of under zero data retention (never one it must retain). */
export const PAYROLL_AI_MODEL = 'claude-sonnet-5-5'

/**
 * Whether payroll files may be read with AI here: a key, and either zero data retention declared (`PAYROLL_AI_ZDR=on`)
 * or the beta turned on (`PAYROLL_AI_BETA=on`, owner's decision, 2026-10-19: before ZDR is in place, each person is told
 * first that what is sent may be kept for up to 30 days).
 */
export const payrollAiAvailable = (env: NodeJS.ProcessEnv = process.env) =>
  !!env.ANTHROPIC_API_KEY && (env.PAYROLL_AI_ZDR === 'on' || env.PAYROLL_AI_BETA === 'on')

/** Reading with AI before zero data retention is in place: the screen says so before anything is sent. */
export const payrollAiBeta = (env: NodeJS.ProcessEnv = process.env) => env.PAYROLL_AI_ZDR !== 'on'

const KIND_WORDS: Record<PayrollDocumentKind, string> = {
  timesheet: 'a timesheet or time report',
  'payroll-register': 'a payroll register or payroll payments report',
  paystub: 'a pay stub (earnings statement)',
  'bank-statement': 'a bank statement',
  'payroll-details': "a payroll company's per-person payroll details export",
}

/** What AI answers, before it is checked against the file. */
interface RawFacts {
  payDate?: unknown
  periodStart?: unknown
  periodEnd?: unknown
  totals?: unknown
  people?: unknown
}

const ISO = /^\d{4}-\d{2}-\d{2}$/
const asDay = (v: unknown) => (typeof v === 'string' && ISO.test(v) ? v : null)
const asAmount = (v: unknown) => {
  const n =
    typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(/[$,\s]/g, '')) : NaN
  return Number.isFinite(n) && n > 0 && n < 1e9 ? Math.round(n * 100) / 100 : null
}
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

/** The question for one file: what to look for, and the shape of the answer. No personal value is in it but our names. */
export function promptFor(kind: PayrollDocumentKind, names: string[]): string {
  const list = names.length ? names.map((n) => `- ${n}`).join('\n') : '(none)'
  return [
    `This file is ${KIND_WORDS[kind]} from a company's payroll.`,
    'Find what it says about the people on this list (each name as our list keeps it; the file may print a middle name,',
    'a legal first name, or the other first name in quotes):',
    list,
    '',
    'Answer with one JSON object only:',
    '{"payDate": the pay date (or check date) of the payroll run as YYYY-MM-DD, or null,',
    ' "periodStart": the first day of the pay period as YYYY-MM-DD, or null,',
    ' "periodEnd": the last day of the pay period as YYYY-MM-DD, or null,',
    ' "totals": the totals the file states the run paid out by direct deposit or debited, as numbers ([] if none),',
    ' "people": [ one entry per row or pay of a person on the list that the file shows:',
    '   {"name": the name exactly as our list has it, "printedName": the name exactly as the file prints it,',
    '    "gross": their gross pay for this pay period on that row as a number (never year to date), or null,',
    '    "quote": the exact words of the file the gross pay is printed in, copied character for character} ]}',
    "Report a person's pay only when their name is printed on the same line or row as that amount, or the amount is",
    "unmistakably in that person's own block (a pay stub's, say). Match each name exactly as the file prints it against",
    'the names on our list. When two people are paid the same amount, or a name is unclear, leave the person out.',
    'Leave out anyone the file does not show, and anything you cannot read. Never guess a value.',
  ].join('\n')
}

/**
 * The answer checked against the file's own text: a date is kept only when the file prints it, a total only when a line
 * shows it, and a person only when the file prints the name AI read and their pay is on the quote's line or on a line
 * that also prints their name. What can't be shown in the file is dropped, never kept.
 */
export function verify(raw: RawFacts, lines: StatementLine[], names: string[]): AiFileFacts {
  const text = lines.map((l) => l.text)
  const dates = new Set(lines.flatMap((l) => datesOf(l.text)))
  const printed = (v: string | null) => (v && dates.has(v) ? v : null)
  // A person's pay: the quote's line, else a line with the amount that also prints their name. Never any line with the
  // amount alone, which pins one person's pay to another's row when two are paid the same.
  const lineOf = (amount: number, printedName: string, quote?: string) => {
    const re = amountPattern(amount)
    const q = quote ? norm(quote) : ''
    return (
      (q && lines.find((l) => re.test(l.text) && norm(l.text).includes(q))) ||
      (q && lines.find((l) => re.test(l.text) && q.includes(norm(l.text)))) ||
      lines.find((l) => re.test(l.text) && norm(l.text).includes(printedName)) ||
      null
    )
  }
  const totals = (Array.isArray(raw.totals) ? raw.totals : [])
    .map(asAmount)
    .filter((n): n is number => {
      if (n === null) return false
      const re = amountPattern(n)
      return lines.some((l) => re.test(l.text))
    })
  const listNames = new Map(names.map((n) => [norm(n), n]))
  const all = norm(text.join(' '))
  const people: AiPersonFact[] = []
  const start = printed(asDay(raw.periodStart))
  const end = printed(asDay(raw.periodEnd))
  const payDate = printed(asDay(raw.payDate))
  for (const p of Array.isArray(raw.people) ? raw.people : []) {
    const x = (p ?? {}) as Record<string, unknown>
    const name = typeof x.name === 'string' ? listNames.get(norm(x.name)) : undefined
    const printedName = typeof x.printedName === 'string' ? norm(x.printedName) : ''
    const gross = asAmount(x.gross)
    if (!name || !printedName || !all.includes(printedName) || gross === null) continue
    const line = lineOf(gross, printedName, typeof x.quote === 'string' ? x.quote : undefined)
    if (!line) continue
    people.push({ name, line, gross, payDate, start, end })
  }
  const facts: AiFileFacts = { payDate, start, end, totals, people }
  if (!people.length && !payDate && !start && !totals.length)
    facts.note = 'AI found nothing it could show in the file'
  return facts
}

/**
 * Sends one file to AI and answers what it found, checked against the file's text; null when it failed (the rules'
 * reading then stands). A PDF is sent whole; payroll details as its rows' text. The caller asked a person first, and checked `payrollAiAvailable`.
 */
export async function aiReadPayrollFile(
  file: { kind: PayrollDocumentKind; bytes: Buffer; contentType: string; lines: StatementLine[] },
  names: string[],
  env: NodeJS.ProcessEnv = process.env
): Promise<AiFileFacts | null> {
  // A PDF goes whole; payroll details (a spreadsheet) goes as its rows, as read (owner's decision, 2026-10-19).
  const sheet = file.kind === 'payroll-details'
  if (!payrollAiAvailable(env) || (file.contentType !== 'application/pdf' && !sheet)) return null
  try {
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: 120_000, maxRetries: 1 })
    const res = await client.messages.create({
      model: PAYROLL_AI_MODEL,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      messages: [
        {
          role: 'user',
          content: [
            sheet
              ? {
                  type: 'text',
                  text: `The file's rows, one per line, cells separated by " | ":\n${file.lines.map((l) => l.text).join('\n')}`,
                }
              : {
                  type: 'document',
                  source: {
                    type: 'base64',
                    media_type: 'application/pdf',
                    data: file.bytes.toString('base64'),
                  },
                },
            { type: 'text', text: promptFor(file.kind, names) },
          ],
        },
      ],
    })
    const text =
      res.stop_reason === 'end_turn'
        ? res.content.find((c): c is Anthropic.TextBlock => c.type === 'text')?.text
        : undefined
    if (!text) throw new Error(`the answer stopped with ${res.stop_reason}`)
    const json = /\{[\s\S]*\}/.exec(text)?.[0]
    if (!json) throw new Error('no JSON in the answer')
    return verify(JSON.parse(json) as RawFacts, file.lines, names)
  } catch (e) {
    // Never the file's name, a person or an amount in the log: why it failed only.
    logger.warn(
      `Reading a ${file.kind} with AI failed, so the rules' reading stands: ${aiFailure(e)}`
    )
    return null
  }
}
