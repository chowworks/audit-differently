import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common'
import {
  MATCH_FEATURES,
  MATCH_STAT_DAYS,
  type AdminMatchStatsDto,
  type MatchFeature,
  type MatchOutcome,
  type MatchStatDayDto,
} from '@ad/types'
import type { Caller } from '../core/caller'
import { PrismaService } from '../prisma/prisma.service'

/** The table lists at most this many runs; the graph and the totals count every run of the period. */
const ROWS = 200
const DAY_MS = 86_400_000

const isFeature = (f: unknown): f is MatchFeature =>
  typeof f === 'string' && (MATCH_FEATURES as readonly string[]).includes(f)

/**
 * Admin tools → Matching statistics: every workspace's finished match runs (MatchRunStat), as a daily series for the
 * line graph and the newest runs for the table. Counts, sizes and durations, with the workspace's name and the email of
 * who started each; nothing below the workspace. Under the admin's mark (AdminGuard), which the table's read policy
 * admits (migration 20261016001500); never trusted work.
 */
@Injectable()
export class AdminMatchStatsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(caller: Caller, days: unknown, feature: unknown): Promise<AdminMatchStatsDto> {
    if (!caller.admin) throw new ForbiddenException('Platform admins only')
    const n = days == null || days === '' ? 30 : Number(days)
    if (!(MATCH_STAT_DAYS as readonly number[]).includes(n))
      throw new BadRequestException(`days must be one of ${MATCH_STAT_DAYS.join(', ')}`)
    if (feature != null && feature !== '' && !isFeature(feature))
      throw new BadRequestException(`feature must be one of ${MATCH_FEATURES.join(', ')}`)
    const only = isFeature(feature) ? feature : null
    // Whole UTC days: today and the n - 1 before it.
    const today = Date.UTC(
      new Date().getUTCFullYear(),
      new Date().getUTCMonth(),
      new Date().getUTCDate()
    )
    const from = new Date(today - (n - 1) * DAY_MS)
    const where = { finishedAt: { gte: from }, ...(only && { feature: only }) }
    const [all, rows] = await Promise.all([
      this.prisma.matchRunStat.findMany({
        where,
        select: {
          feature: true,
          finishedAt: true,
          fileCount: true,
          totalBytes: true,
          matched: true,
          guessed: true,
          missing: true,
        },
      }),
      this.prisma.matchRunStat.findMany({
        where,
        orderBy: { finishedAt: 'desc' },
        take: ROWS,
        include: { workspace: { select: { name: true } } },
      }),
    ])

    const series: MatchStatDayDto[] = Array.from({ length: n }, (_, i) => ({
      day: new Date(from.getTime() + i * DAY_MS).toISOString().slice(0, 10),
      runs: { payroll: 0, receipts: 0, 'emailed-receipts': 0 },
      matchRate: null,
    }))
    const looked = new Array<number>(n).fill(0)
    const found = new Array<number>(n).fill(0)
    const totals = { runs: 0, files: 0, bytes: 0, matched: 0, lookedFor: 0 }
    for (const s of all) {
      const i = Math.floor((s.finishedAt.getTime() - from.getTime()) / DAY_MS)
      if (i < 0 || i >= n || !isFeature(s.feature)) continue
      const lookedFor = s.matched + s.guessed + s.missing
      series[i]!.runs[s.feature]++
      looked[i]! += lookedFor
      found[i]! += s.matched
      totals.runs++
      totals.files += s.fileCount
      totals.bytes += Number(s.totalBytes)
      totals.matched += s.matched
      totals.lookedFor += lookedFor
    }
    series.forEach((d, i) => (d.matchRate = looked[i] ? found[i]! / looked[i]! : null))

    return {
      days: n,
      feature: only,
      series,
      totals,
      rows: rows.map((r) => ({
        id: r.id,
        feature: r.feature as MatchFeature,
        workspaceName: r.workspace.name,
        startedByEmail: r.startedByEmail,
        startedAt: r.startedAt.toISOString(),
        finishedAt: r.finishedAt.toISOString(),
        outcome: r.outcome as MatchOutcome,
        fileCount: r.fileCount,
        totalBytes: Number(r.totalBytes),
        readMs: r.readMs,
        durationMs: r.durationMs,
        items: r.items,
        matched: r.matched,
        guessed: r.guessed,
        missing: r.missing,
        failed: r.failed,
        bankLines: r.bankLines,
      })),
    }
  }
}
