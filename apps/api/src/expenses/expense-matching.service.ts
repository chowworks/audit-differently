import { BadRequestException, Injectable } from '@nestjs/common'
import {
  DEFAULT_EXPENSE_MATCHING,
  EXPENSE_MATCHING_DAYS,
  type ExpenseMatching,
  type ExpenseMatchingChangeDto,
  type ExpenseMatchingDto,
} from '@ad/types'
import type { Caller } from '../core/caller'
import { PrismaService } from '../prisma/prisma.service'

/** How many saves the history shows, newest first. */
const HISTORY = 100
const MAX_DAYS = 60

export interface MatchingProblem {
  field: keyof ExpenseMatching
  message: string
}

/**
 * How the month's expenses from the books match each bill to its receipt and its payment, for the whole system
 * (owner's decision, 2026-11-12): how many days a receipt's date, and a bank or card statement line's date, may be from
 * the bill's own. Set by a platform admin in Admin tools → File Matching, beside the payroll reading and apart from it.
 * Append-only (migration 20261112000200): each save is a new row holding both, the newest is in force, and with none
 * the defaults are.
 */
@Injectable()
export class ExpenseMatchingService {
  constructor(private readonly prisma: PrismaService) {}

  async get(): Promise<ExpenseMatchingDto> {
    const row = await this.prisma.expenseMatchingSetting.findFirst({
      orderBy: { changedAt: 'desc' },
    })
    return {
      matching: {
        ...DEFAULT_EXPENSE_MATCHING,
        ...((row?.matching ?? {}) as Partial<ExpenseMatching>),
      },
      changedByEmail: row?.changedByEmail ?? null,
      changedAt: row?.changedAt.toISOString() ?? null,
    }
  }

  /** The day windows in force, for a month's expenses about to be worked out. */
  async current(): Promise<ExpenseMatching> {
    return (await this.get()).matching
  }

  /** Every number checked, with every problem at once. */
  static check(input: unknown): { matching: ExpenseMatching; problems: MatchingProblem[] } {
    const body = (input ?? {}) as Record<string, unknown>
    const problems: MatchingProblem[] = []
    const matching = { ...DEFAULT_EXPENSE_MATCHING }
    for (const { key, title } of EXPENSE_MATCHING_DAYS) {
      const n = body[key]
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > MAX_DAYS)
        problems.push({ field: key, message: `${title}: a whole number of days, 0 to ${MAX_DAYS}` })
      else matching[key] = n
    }
    return { matching, problems }
  }

  /** Every save, newest first, with what it changed against the save before (the first against the defaults). */
  async history(): Promise<ExpenseMatchingChangeDto[]> {
    const rows = await this.prisma.expenseMatchingSetting.findMany({
      orderBy: { changedAt: 'desc' },
      take: HISTORY + 1,
    })
    return rows.slice(0, HISTORY).map((row, i) => ({
      changedAt: row.changedAt.toISOString(),
      changedByEmail: row.changedByEmail,
      part: 'expenses' as const,
      changes: matchingChanges(
        { ...DEFAULT_EXPENSE_MATCHING, ...((rows[i + 1]?.matching ?? {}) as object) },
        { ...DEFAULT_EXPENSE_MATCHING, ...(row.matching as object) }
      ),
    }))
  }

  /** A platform admin saves both numbers at once, in their own name; refused whole with every problem. */
  async set(admin: Caller, input: unknown): Promise<ExpenseMatchingDto> {
    const { matching, problems } = ExpenseMatchingService.check(input)
    if (problems.length)
      throw new BadRequestException({
        message: problems.map((p) => p.message).join('. '),
        problems,
      })
    await this.prisma.expenseMatchingSetting.create({
      data: {
        matching: matching as object,
        changedById: admin.userId,
        changedByEmail: admin.email,
      },
    })
    return this.get()
  }
}

/** What one save changed, in words; "No change" when nothing did. */
export function matchingChanges(before: ExpenseMatching, after: ExpenseMatching): string[] {
  const out = EXPENSE_MATCHING_DAYS.filter(({ key }) => before[key] !== after[key]).map(
    ({ key, title }) => `${title}: ${before[key]} → ${after[key]} days`
  )
  return out.length ? out : ['No change']
}
