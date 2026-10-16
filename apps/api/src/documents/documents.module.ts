import { Module } from '@nestjs/common'
import { EngagementsModule } from '../engagements/engagements.module'
import { ParticipantsModule } from '../participants/participants.module'
import { ReportsModule } from '../reports/reports.module'
import { StorageModule } from '../storage/storage.module'
import { DocumentsController } from './documents.controller'
import { DocumentsService } from './documents.service'

@Module({
  imports: [StorageModule, ReportsModule, ParticipantsModule, EngagementsModule],
  controllers: [DocumentsController],
  providers: [DocumentsService],
  exports: [DocumentsService],
})
export class DocumentsModule {}
