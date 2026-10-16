import { Injectable, Logger } from '@nestjs/common'
import type { MatchFeature, MatchOutcome } from '@ad/types'
import { PrismaService } from '../prisma/prisma.service'

/**
 * One finished match run as Admin tools → Matching statistics counts it (MatchRunStat, migration 20261016001500).
 * Counts, sizes and durations only: the type has no place for a file name, a person's or vendor's name, an amount or a
 * record's id, and `record` writes exactly these fields.
 */
export interface MatchRun {
  workspaceId: string
  feature: MatchFeature
  startedById: string
  /** The person's email, as staff are named everywhere (`staffName`). */
  startedByEmail: string
  startedAt: Date
  outcome: MatchOutcome
  fileCount: number
  totalBytes: number
  /** Time spent reading the files; null when it is not known. */
  readMs?: number | null
  items?: number
  matched?: number
  guessed?: number
  missing?: number
  failed?: number
  bankLines?: number
}

const INT_MAX = 2_147_483_647
const count = (n: number | undefined) =>
  Math.min(INT_MAX, Math.max(0, Math.round(Number.isFinite(n) ? n! : 0)))

/**
 * Writes the row where a run ends, as the person (or the member an emailed receipt is filed as) under their own
 * row-level security. After the action and outside its transaction, on purpose: a statistic that cannot be written is
 * a warning in the API's log, never a failed Save, upload or filing. Not an access-log line: it records no change to
 * the workspace's records, only that a run happened.
 */
@Injectable()
export class MatchStatsService {
  private readonly logger = new Logger(MatchStatsService.name)

  constructor(private readonly prisma: PrismaService) {}

  async record(run: MatchRun): Promise<void> {
    try {
      const now = new Date()
      // createMany: a bookkeeper writes the row but does not read it back (only owners and the admin read them).
      await this.prisma.matchRunStat.createMany({
        data: [
          {
            workspaceId: run.workspaceId,
            feature: run.feature,
            startedById: run.startedById,
            startedByEmail: run.startedByEmail,
            startedAt: run.startedAt,
            finishedAt: now,
            outcome: run.outcome,
            fileCount: count(run.fileCount),
            totalBytes: BigInt(Math.max(0, Math.round(run.totalBytes || 0))),
            readMs: run.readMs == null ? null : count(run.readMs),
            durationMs: count(now.getTime() - run.startedAt.getTime()),
            items: count(run.items),
            matched: count(run.matched),
            guessed: count(run.guessed),
            missing: count(run.missing),
            failed: count(run.failed),
            bankLines: count(run.bankLines),
          },
        ],
      })
    } catch (e) {
      this.logger.warn(
        `Could not record a ${run.feature} match run's statistics: ${(e as Error).name}`
      )
    }
  }

  /** The same, for a caller that has to work the row out first: a failure there is a warning too. */
  async recordWith(feature: MatchFeature, build: () => Promise<MatchRun>): Promise<void> {
    let run: MatchRun
    try {
      run = await build()
    } catch (e) {
      this.logger.warn(
        `Could not work out a ${feature} match run's statistics: ${(e as Error).name}`
      )
      return
    }
    await this.record(run)
  }
}
