import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { runAsSystem } from '../core/tenant-context'
import { PayrollMatchService } from './payroll-match.service'

/** How often expired payroll matches are looked for. A run goes at most this long after its RUN_HOURS. */
export const SWEEP_MS = 15 * 60_000

/**
 * Removes the payroll matches nobody saved or discarded within RUN_HOURS, in every workspace, with their staged objects
 * and the text read from them (`PayrollMatchService.expireAll`). Trusted work (runAsSystem, a reviewed path): no one is
 * signed in, and a starter who never comes back would otherwise leave their pay stubs staged for good. Every
 * SWEEP_MS; never two passes at once, and never under the tests.
 */
@Injectable()
export class PayrollMatchSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PayrollMatchSweeper.name)
  private timer: NodeJS.Timeout | null = null
  private busy = false

  constructor(private readonly matches: PayrollMatchService) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID) return
    this.timer = setInterval(() => void this.sweep(), SWEEP_MS)
    this.timer.unref()
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** One pass: every expired run, a batch at a time. The number removed. */
  async sweep(): Promise<number> {
    if (this.busy) return 0
    this.busy = true
    let removed = 0
    try {
      let n: number
      do {
        n = await runAsSystem(() => this.matches.expireAll())
        removed += n
      } while (n > 0)
    } catch (e) {
      this.logger.error(`The payroll match sweeper stopped a pass: ${(e as Error).name}`)
    } finally {
      this.busy = false
    }
    return removed
  }
}
