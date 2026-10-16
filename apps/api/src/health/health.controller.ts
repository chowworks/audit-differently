import { Controller, Get, HttpStatus, Logger, Res } from '@nestjs/common'
import type { Response } from 'express'
import type { Health } from '@ad/types'
import {
  FAILURE_WINDOW_MS,
  ServiceFailureLog,
  type FailureKind,
  type RecentFailures,
} from '../core/service-failure-log'

/**
 * The environment this API runs in: Railway's environment name when it has one ("production", "dev"), else
 * "production" under NODE_ENV=production, else "local".
 */
export function environmentName(env: NodeJS.ProcessEnv = process.env): string {
  return env.RAILWAY_ENVIRONMENT_NAME || (env.NODE_ENV === 'production' ? 'production' : 'local')
}

/** A count that has not answered by then is down. */
export const CHECK_TIMEOUT_MS = 5_000
/** These routes are public, so a result is reused for this long and a busy caller cannot hammer the database. */
export const CHECK_CACHE_MS = 60_000

/** What a recent-failures check answers when it could not count: the database did not answer. */
const DOWN: RecentFailures = {
  status: 'failing',
  failures: 0,
  windowMinutes: FAILURE_WINDOW_MS / 60_000,
}

@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name)
  private readonly cache = new Map<FailureKind, { at: number; result: Promise<RecentFailures> }>()

  constructor(private readonly failures: ServiceFailureLog) {}

  /** The API is answering. The CI smoke test reads it; it touches nothing else. */
  @Get()
  check(): Health {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: '0.0.1',
      environment: environmentName(),
    }
  }

  /**
   * Proof uploads that failed in the last 15 minutes through no fault of the person (storage refused the file, or
   * saving its record failed). 503 when there was any, or when the count could not be read.
   */
  @Get('upload-failures')
  async uploadFailures(@Res({ passthrough: true }) res: Response): Promise<RecentFailures> {
    return this.answer(res, 'upload')
  }

  /** Requests the API answered with a 5xx in the last 15 minutes, on any route. 503 when there was any. */
  @Get('server-errors')
  async serverErrors(@Res({ passthrough: true }) res: Response): Promise<RecentFailures> {
    return this.answer(res, 'server')
  }

  private async answer(res: Response, kind: FailureKind): Promise<RecentFailures> {
    const hit = this.cache.get(kind)
    let result = hit && Date.now() - hit.at < CHECK_CACHE_MS ? hit.result : undefined
    if (!result) {
      result = this.count(kind)
      this.cache.set(kind, { at: Date.now(), result })
    }
    const out = await result
    if (out.status === 'failing') res.status(HttpStatus.SERVICE_UNAVAILABLE)
    return out
  }

  private async count(kind: FailureKind): Promise<RecentFailures> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`no answer in ${CHECK_TIMEOUT_MS} ms`)),
        CHECK_TIMEOUT_MS
      )
    })
    try {
      return await Promise.race([this.failures.recent(kind), timeout])
    } catch (err) {
      // the reason goes to the log only; the answer says failing and nothing more
      this.logger.warn(`Counting ${kind} failures failed: ${(err as Error).message}`)
      return DOWN
    } finally {
      clearTimeout(timer)
    }
  }
}
