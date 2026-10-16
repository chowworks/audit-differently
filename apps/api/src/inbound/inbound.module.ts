import { Module } from '@nestjs/common'
import { EngagementsModule } from '../engagements/engagements.module'
import { ReceiptsModule } from '../receipts/receipts.module'
import { InboundWebhookController, ReceiptsInboxController } from './inbound.controller'
import { InboundService } from './inbound.service'
import { InboundWorker } from './inbound.worker'
import { ResendInbound } from './resend'
import { SenderCheck } from './sender-check'

/** Email in receipts: the provider's webhook, the queue's worker, and the receipts inbox. */
@Module({
  imports: [EngagementsModule, ReceiptsModule],
  controllers: [InboundWebhookController, ReceiptsInboxController],
  providers: [InboundService, InboundWorker, ResendInbound, SenderCheck],
})
export class InboundModule {}
