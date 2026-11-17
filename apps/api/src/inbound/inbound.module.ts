import { Module } from '@nestjs/common'
import { DocumentsModule } from '../documents/documents.module'
import { EngagementsModule } from '../engagements/engagements.module'
import { ReceiptsModule } from '../receipts/receipts.module'
import { InboundConfirmation } from './confirmation'
import { InboundWebhookController, ReceiptsInboxController } from './inbound.controller'
import { InboundService } from './inbound.service'
import { InboundWorker } from './inbound.worker'
import { ResendInbound } from './resend'
import { SenderCheck } from './sender-check'

/** Emailed documents: the provider's webhook, the queue's worker, the confirmations and the emailed documents inbox. */
@Module({
  imports: [DocumentsModule, EngagementsModule, ReceiptsModule],
  controllers: [InboundWebhookController, ReceiptsInboxController],
  providers: [InboundService, InboundWorker, ResendInbound, SenderCheck, InboundConfirmation],
})
export class InboundModule {}
