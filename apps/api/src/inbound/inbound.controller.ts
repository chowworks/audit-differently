import { SkipThrottle, ThrottlerException } from '@nestjs/throttler'
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common'
import type { FileInboundReceiptRequest, ReceiptsInboxDto } from '@ad/types'
import { AuthenticatedGuard } from '../auth/authenticated.guard'
import { CallerService, UserId } from '../core/caller'
import { inboundConfig } from './config'
import { InboundService } from './inbound.service'
import { verifySvix } from './svix'

type WebhookRequest = {
  body?: unknown
  ip?: string
  headers: Record<string, string | string[] | undefined>
}
const header = (req: WebhookRequest, name: string) => {
  const v = req.headers[name]
  return typeof v === 'string' ? v : undefined
}

/** Unsigned calls one client address may make a minute, before 429. A call the provider signed is never throttled. */
export const UNSIGNED_PER_MINUTE = 60
const WINDOW_MS = 60_000

/** Counts unsigned calls per client address, in fixed one-minute windows, in this process. */
export class UnsignedCalls {
  private readonly windows = new Map<string, { start: number; count: number }>()

  /** Counts one call from `ip`; true when that is more than the limit for its minute. */
  over(ip: string, now = Date.now()): boolean {
    if (this.windows.size > 10_000)
      for (const [k, w] of this.windows) if (now - w.start >= WINDOW_MS) this.windows.delete(k)
    const w = this.windows.get(ip)
    if (!w || now - w.start >= WINDOW_MS) {
      this.windows.set(ip, { start: now, count: 1 })
      return false
    }
    w.count++
    return w.count > UNSIGNED_PER_MINUTE
  }
}

/**
 * The email provider's webhook (Resend inbound), the one public route that writes: no signed-in caller, so the
 * credential is the provider's signature over the exact bytes (main.ts keeps them raw for this path only). It only
 * queues the email and answers at once; the worker does the rest. 404 when email in receipts is not set up.
 *
 * The usual per-address throttle is skipped: the provider calls from addresses it shares, so a busy hour of real mail
 * would be refused. The signature is checked first (cheap, no database), and only unsigned calls are counted and
 * throttled. A signed event of another type is answered 200 and ignored, so the provider never retries it.
 */
@Controller('inbound')
export class InboundWebhookController {
  private readonly unsigned = new UnsignedCalls()

  constructor(private readonly inbound: InboundService) {}

  @SkipThrottle()
  @Post('resend')
  @HttpCode(200)
  async resend(@Req() req: WebhookRequest): Promise<{ queued: boolean }> {
    const cfg = inboundConfig()
    if (!cfg) throw new NotFoundException()
    const signed =
      Buffer.isBuffer(req.body) &&
      verifySvix(
        cfg.webhookSecret,
        {
          id: header(req, 'svix-id'),
          timestamp: header(req, 'svix-timestamp'),
          signature: header(req, 'svix-signature'),
        },
        req.body
      )
    if (!signed) {
      if (this.unsigned.over(req.ip ?? '')) throw new ThrottlerException()
      throw Buffer.isBuffer(req.body) ? new UnauthorizedException() : new BadRequestException()
    }
    let payload: unknown
    try {
      payload = JSON.parse((req.body as Buffer).toString('utf8'))
    } catch {
      throw new BadRequestException()
    }
    return { queued: await this.inbound.enqueue(payload) }
  }
}

/** The receipts inbox on the workspace page: what became of each emailed receipt, run again, file by hand. */
@Controller()
@UseGuards(AuthenticatedGuard)
export class ReceiptsInboxController {
  constructor(
    private readonly inbound: InboundService,
    private readonly callers: CallerService
  ) {}

  @Get('workspaces/:id/receipts-inbox')
  async inbox(@UserId() userId: string, @Param('id') id: string): Promise<ReceiptsInboxDto> {
    return this.inbound.inbox(await this.callers.load(userId), id)
  }

  @Post('inbound-receipts/:id/run-again')
  async runAgain(@UserId() userId: string, @Param('id') id: string): Promise<ReceiptsInboxDto> {
    return this.inbound.runAgain(await this.callers.load(userId), id)
  }

  @Post('inbound-receipts/:id/file')
  async file(
    @UserId() userId: string,
    @Param('id') id: string,
    @Body() body: Partial<FileInboundReceiptRequest>
  ): Promise<ReceiptsInboxDto> {
    return this.inbound.fileByHand(await this.callers.load(userId), id, body)
  }
}
