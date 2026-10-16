import Anthropic from '@anthropic-ai/sdk'
import { Logger } from '@nestjs/common'
import type { DocumentSensitivity, ReceiptReadBy } from '@ad/types'
import { aiFailure } from '../imports/ai-guess'

const logger = new Logger('ReadReceipt')
const MODEL = 'claude-haiku-5-5'

/** What was read from a receipt: each field, or null when it could not be found. */
export interface ReceiptRead {
  amount: number | null
  /** YYYY-MM-DD */
  date: string | null
  vendor: string | null
  readBy: ReceiptReadBy | null
}

const NOTHING: ReceiptRead = { amount: null, date: null, vendor: null, readBy: null }

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

const pad = (n: number) => String(n).padStart(2, '0')

/** A real calendar date as YYYY-MM-DD, or null. */
function isoDate(y: number, m: number, d: number): string | null {
  if (y < 100) y += 2000
  const t = new Date(Date.UTC(y, m - 1, d))
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null
  return `${y}-${pad(m)}-${pad(d)}`
}

const MONEY = /\$?\s?(\d{1,3}(?:,\d{3})+|\d+)\.(\d{2})\b/g

function amountsIn(line: string): number[] {
  return [...line.matchAll(MONEY)].map((m) => Number(`${m[1]!.replace(/,/g, '')}.${m[2]}`))
}

/** The total: the largest amount on a line that says total, amount due or paid (never subtotal), else the largest amount. */
function findAmount(lines: string[]): number | null {
  const totals = lines
    .filter((l) => /\b(grand total|total|amount due|amount paid|balance due|paid)\b/i.test(l))
    .filter((l) => !/sub\s*-?total/i.test(l))
    .flatMap(amountsIn)
  const all = totals.length ? totals : lines.flatMap(amountsIn)
  return all.length ? Math.max(...all) : null
}

/** The first date written as 09/02/2026, 2026-09-02 or September 2, 2026 (or Sep 2 2026). */
function findDate(text: string): string | null {
  const patterns: [RegExp, (m: RegExpExecArray) => string | null][] = [
    [/\b(\d{4})-(\d{2})-(\d{2})\b/, (m) => isoDate(+m[1]!, +m[2]!, +m[3]!)],
    [/\b(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b/, (m) => isoDate(+m[3]!, +m[1]!, +m[2]!)],
    [
      /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\b/i,
      (m) => isoDate(+m[3]!, MONTHS.indexOf(m[1]!.toLowerCase()) + 1, +m[2]!),
    ],
  ]
  let best: { at: number; date: string } | null = null
  for (const [re, toDate] of patterns) {
    const m = re.exec(text)
    const date = m && toDate(m)
    if (m && date && (!best || m.index < best.at)) best = { at: m.index, date }
  }
  return best?.date ?? null
}

/** The vendor: the first line with words that is not a heading like "Receipt", a date or an amount. */
function findVendor(lines: string[]): string | null {
  for (const l of lines) {
    if (!/[a-z]{2}/i.test(l)) continue
    if (/^(sales\s+)?(receipt|invoice|order|tax invoice)\b/i.test(l)) continue
    if (/^(date|total|subtotal|tax|amount|thank)/i.test(l)) continue
    return l.slice(0, 200)
  }
  return null
}

/** Amount, date and vendor from a receipt's text, by simple rules. */
export function readText(text: string): Omit<ReceiptRead, 'readBy'> {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  return { amount: findAmount(lines), date: findDate(text), vendor: findVendor(lines) }
}

/** The text layer of a PDF; empty for a scanned one (no text) or one that cannot be opened. */
export async function pdfText(buffer: Buffer): Promise<string> {
  try {
    const { extractText, getDocumentProxy } = await import('unpdf')
    const pdf = await getDocumentProxy(new Uint8Array(buffer))
    const { text } = await extractText(pdf, { mergePages: true })
    return text
  } catch (e) {
    logger.warn(`The PDF's text could not be read: ${(e as Error).message}`)
    return ''
  }
}

/**
 * Asks Claude for the receipt's amount, date and vendor, sending the file itself. Only when ANTHROPIC_API_KEY is set;
 * null on any failure, and the caller keeps what the text gave. The caller sends financial documents only, and only
 * with a yes (readReceipt's `withAi`).
 */
export async function aiRead(
  buffer: Buffer,
  contentType: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<Omit<ReceiptRead, 'readBy'> | null> {
  const apiKey = env.ANTHROPIC_API_KEY
  if (!apiKey) return null
  const data = buffer.toString('base64')
  let file: Anthropic.ContentBlockParam
  if (contentType === 'application/pdf')
    file = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
  else if (contentType === 'image/png' || contentType === 'image/jpeg')
    file = { type: 'image', source: { type: 'base64', media_type: contentType, data } }
  else return null
  const prompt =
    'This is a receipt or invoice for a business expense. Answer with one JSON object only: {"amount": the total paid as a number, "date": the date of the purchase as YYYY-MM-DD, "vendor": the business that issued it}. Use null for anything you cannot read.'
  try {
    const client = new Anthropic({ apiKey, timeout: 15_000, maxRetries: 1 })
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 200,
      thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: [file, { type: 'text', text: prompt }] }],
    })
    const text =
      res.stop_reason === 'end_turn'
        ? res.content.find((c): c is Anthropic.TextBlock => c.type === 'text')?.text
        : undefined
    if (!text) throw new Error(`the answer stopped with ${res.stop_reason}`)
    const json = /\{[\s\S]*\}/.exec(text)?.[0]
    if (!json) throw new Error('no JSON in the answer')
    const raw = JSON.parse(json) as Record<string, unknown>
    const amount = Number(raw.amount)
    const date = typeof raw.date === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.date) : null
    const out = {
      amount:
        raw.amount != null && Number.isFinite(amount) && amount >= 0 && amount < 1e10
          ? Math.round(amount * 100) / 100
          : null,
      date: date ? isoDate(+date[1]!, +date[2]!, +date[3]!) : null,
      vendor:
        typeof raw.vendor === 'string' && raw.vendor.trim()
          ? raw.vendor.trim().slice(0, 200)
          : null,
    }
    return out.amount != null || out.date || out.vendor ? out : null
  } catch (e) {
    logger.warn(`The AI reading failed, so the receipt keeps what its text gave: ${aiFailure(e)}`)
    return null
  }
}

/**
 * Reads a receipt's amount, date and vendor: from a PDF's text by rules first; then, if anything is still missing,
 * `withAi` is true (the person ticked "Read … with AI", or the owner turned it on for emailed receipts) and
 * ANTHROPIC_API_KEY is set, from Claude; otherwise what was found, the rest left for the person to type. A personal
 * document is never read, whatever its type, and never sent.
 */
export async function readReceipt(
  file: { buffer: Buffer; contentType: string; sensitivity: DocumentSensitivity | string },
  withAi: boolean,
  env: NodeJS.ProcessEnv = process.env
): Promise<ReceiptRead> {
  if (file.sensitivity !== 'financial') return NOTHING
  const fromText =
    file.contentType === 'application/pdf' ? readText(await pdfText(file.buffer)) : null
  const found = (r: Omit<ReceiptRead, 'readBy'>) => r.amount != null || !!r.date || !!r.vendor
  if (fromText && fromText.amount != null && fromText.date && fromText.vendor)
    return { ...fromText, readBy: 'text' }
  const ai = withAi ? await aiRead(file.buffer, file.contentType, env) : null
  if (ai)
    return {
      amount: ai.amount ?? fromText?.amount ?? null,
      date: ai.date ?? fromText?.date ?? null,
      vendor: ai.vendor ?? fromText?.vendor ?? null,
      readBy: 'ai',
    }
  if (fromText && found(fromText)) return { ...fromText, readBy: 'text' }
  return NOTHING
}
