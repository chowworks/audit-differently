import { Injectable, Logger } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'

/** How long a failure counts as recent for the health checks. */
export const FAILURE_WINDOW_MS = 15 * 60 * 1000
/** Failures older than this are deleted. */
export const FAILURE_KEEP_MS = 30 * 24 * 60 * 60 * 1000
/** Old rows are deleted on a write at most this often, so a burst of failures does not double its writes. */
const PRUNE_EVERY_MS = 60 * 60 * 1000
/** The column's bound (migration 20261016000100). */
const MAX_ROUTE = 200

/** upload: storing a proof upload or saving its record failed. server: a request answered 500. */
export type FailureKind = 'upload' | 'server'

/** What a recent-failures health check answers: whether people hit this kind of failure in the last 15 minutes. */
export interface RecentFailures {
  status: 'ok' | 'failing'
  failures: number
  windowMinutes: number
}

/**
 * Failures people hit through no fault of their own, kept in the ServiceFailure table so the health checks survive a
 * deploy. A row is when, which kind and the route pattern, nothing else: the reason goes to the API's log, never here
 * (no workspace, person, file name or error message), so it is not a tenant table and needs no context to write.
 */
@Injectable()
export class ServiceFailureLog {
  private readonly logger = new Logger(ServiceFailureLog.name)
  private prunedAt = Number.NEGATIVE_INFINITY
  now: () => number = () => Date.now()

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records a failure. Callers do not await it, so a request is never slowed; the promise never rejects (a database
   * error is logged and the failure is lost). Deletes rows older than FAILURE_KEEP_MS at most once an hour.
   */
  async record(kind: FailureKind, route: string): Promise<void> {
    try {
      const at = this.now()
      await this.prisma.serviceFailure.create({
        data: { at: new Date(at), kind, route: route.slice(0, MAX_ROUTE) },
      })
      if (at - this.prunedAt >= PRUNE_EVERY_MS) {
        this.prunedAt = at
        await this.prisma.serviceFailure.deleteMany({
          where: { at: { lt: new Date(at - FAILURE_KEEP_MS) } },
        })
      }
    } catch (err) {
      this.logger.error(`Could not record a ${kind} failure on ${route}: ${(err as Error).message}`)
    }
  }

  /** How many failures of `kind` happened in the last FAILURE_WINDOW_MS. A database error rejects. */
  async recent(kind: FailureKind): Promise<RecentFailures> {
    const failures = await this.prisma.serviceFailure.count({
      where: { kind, at: { gte: new Date(this.now() - FAILURE_WINDOW_MS) } },
    })
    return {
      status: failures > 0 ? 'failing' : 'ok',
      failures,
      windowMinutes: FAILURE_WINDOW_MS / 60_000,
    }
  }
}
