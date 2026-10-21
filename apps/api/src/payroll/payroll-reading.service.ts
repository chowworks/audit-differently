import { BadRequestException, Injectable } from '@nestjs/common'
import {
  DEFAULT_HIGHLIGHTS,
  DEFAULT_PAYROLL_READING,
  DOCUMENT_KIND_LABELS,
  HIGHLIGHT_FIELD_LABELS,
  type HighlightField,
  type PayrollDocumentKind,
  type PayrollSettingChangeDto,
  PAYROLL_READING_DAYS,
  PAYROLL_READING_LISTS,
  type PayrollReading,
  type PayrollReadingDto,
} from '@ad/types'
import type { Caller } from '../core/caller'
import { PrismaService } from '../prisma/prisma.service'
import { putReadingInForce } from './reading'

/** A word as the matchers read it: letters and digits, with spaces and a few marks a label prints ("Pay date:", "#"). */
const WORD = /^[\p{L}\p{N}][\p{L}\p{N} #&./'-]{0,39}$/u
const MAX_WORDS = 20
/** How many saves the history shows, newest first. */
const HISTORY = 100
const MAX_DAYS = 60

/** One problem of an admin's save, beside its list or number. */
export interface ReadingProblem {
  field: keyof PayrollReading
  message: string
}

/**
 * The words and day windows the payroll matchers read files by, for the whole system (owner's decision, 2026-10-19):
 * set by a platform admin in Admin tools → Payroll reading, read by both match screens. Append-only (migration
 * 20261019000400): each save is a new row holding all of them, the newest is in force, and with none the defaults are.
 * Reading or saving it puts it in force for the matchers (`reading.ts`): every payroll match and reconciliation reads
 * it first (`current`).
 */
@Injectable()
export class PayrollReadingService {
  constructor(private readonly prisma: PrismaService) {}

  /** The words in force, and who last changed them; put in force for the matchers. */
  async get(): Promise<PayrollReadingDto> {
    const row = await this.prisma.payrollReadingSetting.findFirst({
      orderBy: { changedAt: 'desc' },
    })
    // A word list added after the row was saved takes its default.
    const reading = {
      ...DEFAULT_PAYROLL_READING,
      ...((row?.reading ?? {}) as Partial<PayrollReading>),
    }
    putReadingInForce(reading)
    return {
      reading,
      changedByEmail: row?.changedByEmail ?? null,
      changedAt: row?.changedAt.toISOString() ?? null,
    }
  }

  /** The words in force, for a match about to be worked out (and put in force for it). */
  async current(): Promise<PayrollReading> {
    return (await this.get()).reading
  }

  /** Every list and number checked, with every problem at once. */
  static check(input: unknown): { reading: PayrollReading; problems: ReadingProblem[] } {
    const body = (input ?? {}) as Record<string, unknown>
    const problems: ReadingProblem[] = []
    const reading = { ...DEFAULT_PAYROLL_READING }
    for (const { key, title } of PAYROLL_READING_LISTS) {
      const raw = body[key]
      const words = Array.isArray(raw)
        ? raw
            .map((w) => (typeof w === 'string' ? w.replace(/\s+/g, ' ').trim() : ''))
            .filter((w, i, all) => all.findIndex((x) => x.toLowerCase() === w.toLowerCase()) === i)
        : []
      if (!words.length || words.some((w) => !w))
        problems.push({ field: key, message: `${title}: give at least one word` })
      else if (words.length > MAX_WORDS)
        problems.push({ field: key, message: `${title}: at most ${MAX_WORDS} words` })
      else if (words.some((w) => !WORD.test(w)))
        problems.push({
          field: key,
          message: `${title}: use letters, digits and spaces (up to 40 characters each)`,
        })
      else reading[key] = words
    }
    for (const { key, title } of PAYROLL_READING_DAYS) {
      const n = body[key]
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > MAX_DAYS)
        problems.push({ field: key, message: `${title}: a whole number of days, 0 to ${MAX_DAYS}` })
      else reading[key] = n
    }
    return { reading, problems }
  }

  /**
   * Every save of the configuration, newest first, with what it changed in words: the reading words and days (each
   * against the save before, the first against the defaults), and each proof type's highlighting. The rows are the
   * history: nothing else is kept, and nothing here is ever changed.
   */
  async history(): Promise<PayrollSettingChangeDto[]> {
    const [readings, highlights] = await Promise.all([
      this.prisma.payrollReadingSetting.findMany({
        orderBy: { changedAt: 'desc' },
        take: HISTORY + 1,
      }),
      this.prisma.highlightSetting.findMany({ orderBy: { changedAt: 'desc' }, take: HISTORY * 4 }),
    ])
    const out: PayrollSettingChangeDto[] = []
    readings.slice(0, HISTORY).forEach((row, i) => {
      const before = { ...DEFAULT_PAYROLL_READING, ...((readings[i + 1]?.reading ?? {}) as object) }
      const after = { ...DEFAULT_PAYROLL_READING, ...(row.reading as object) }
      out.push({
        changedAt: row.changedAt.toISOString(),
        changedByEmail: row.changedByEmail,
        part: 'reading',
        changes: readingChanges(before, after),
      })
    })
    highlights.forEach((row, i) => {
      const kind = row.kind as PayrollDocumentKind
      const previous = highlights.slice(i + 1).find((r) => r.kind === row.kind)
      const before = (previous?.fields ?? DEFAULT_HIGHLIGHTS[kind]) as HighlightField[]
      const after = row.fields as HighlightField[]
      const label = (f: HighlightField) => HIGHLIGHT_FIELD_LABELS[f].toLowerCase()
      const added = after.filter((f) => !before.includes(f)).map(label)
      const removed = before.filter((f) => !after.includes(f)).map(label)
      const title = DOCUMENT_KIND_LABELS[kind as keyof typeof DOCUMENT_KIND_LABELS] ?? kind
      const parts = [
        ...(added.length ? [`highlights ${added.join(', ')}`] : []),
        ...(removed.length ? [`no longer ${removed.join(', ')}`] : []),
      ]
      out.push({
        changedAt: row.changedAt.toISOString(),
        changedByEmail: row.changedByEmail,
        part: 'highlights',
        changes: [
          `${title.charAt(0).toUpperCase()}${title.slice(1)}: ${parts.join('; ') || 'no change'}`,
        ],
      })
    })
    return out.sort((a, b) => b.changedAt.localeCompare(a.changedAt)).slice(0, HISTORY)
  }

  /** A platform admin saves every list and number at once, in their own name; refused whole with every problem. */
  async set(admin: Caller, input: unknown): Promise<PayrollReadingDto> {
    const { reading, problems } = PayrollReadingService.check(input)
    if (problems.length)
      throw new BadRequestException({
        message: problems.map((p) => p.message).join('. '),
        problems,
      })
    await this.prisma.payrollReadingSetting.create({
      data: { reading: reading as object, changedById: admin.userId, changedByEmail: admin.email },
    })
    return this.get()
  }
}

/** What one save of the reading words changed, in words, list by list; "No change" when nothing did. */
export function readingChanges(before: PayrollReading, after: PayrollReading): string[] {
  const out: string[] = []
  const quote = (ws: string[]) => ws.map((w) => `"${w}"`).join(', ')
  for (const { key, title } of PAYROLL_READING_LISTS) {
    const was = before[key].map((w) => w.toLowerCase())
    const now = after[key].map((w) => w.toLowerCase())
    const added = after[key].filter((w) => !was.includes(w.toLowerCase()))
    const removed = before[key].filter((w) => !now.includes(w.toLowerCase()))
    const parts = [
      ...(added.length ? [`added ${quote(added)}`] : []),
      ...(removed.length ? [`removed ${quote(removed)}`] : []),
    ]
    if (parts.length) out.push(`${title}: ${parts.join('; ')}`)
  }
  for (const { key, title } of PAYROLL_READING_DAYS)
    if (before[key] !== after[key]) out.push(`${title}: ${before[key]} → ${after[key]} days`)
  return out.length ? out : ['No change']
}
