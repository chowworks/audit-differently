import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { inboundConfig } from './config'
import { InboundService } from './inbound.service'

/** How often the worker looks for emailed receipts that are due, and how often it removes old rows nobody needs. */
export const TICK_MS = 30_000
const PURGE_MS = 60 * 60_000

/**
 * The worker that files emailed receipts, inside the API process: every 30 seconds it claims what is due and processes
 * it, one row at a time. It never starts when the email provider is not set up, nor under the tests.
 */
@Injectable()
export class InboundWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InboundWorker.name)
  private timer: NodeJS.Timeout | null = null
  private busy = false
  private lastPurge = 0

  constructor(private readonly inbound: InboundService) {}

  onModuleInit(): void {
    if (!inboundConfig() || process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID) return
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    this.timer.unref()
    this.logger.log('Email in receipts is on: the worker checks the queue every 30 seconds')
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** One pass: everything due, in batches, then the old rows nobody needs once an hour. Never two passes at once. */
  async tick(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      while ((await this.inbound.runDue()) > 0) {
        /* the next batch */
      }
      if (Date.now() - this.lastPurge > PURGE_MS) {
        await this.inbound.purgeOld()
        this.lastPurge = Date.now()
      }
    } catch (e) {
      this.logger.error(`The emailed receipts worker stopped a pass: ${(e as Error).name}`)
    } finally {
      this.busy = false
    }
  }
}
