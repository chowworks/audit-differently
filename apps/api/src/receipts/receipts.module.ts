import { Module } from '@nestjs/common'
import { DocumentsModule } from '../documents/documents.module'
import { ReportsModule } from '../reports/reports.module'
import { ReceiptsController } from './receipts.controller'
import { ReceiptsService } from './receipts.service'

@Module({
  imports: [DocumentsModule, ReportsModule],
  controllers: [ReceiptsController],
  providers: [ReceiptsService],
  exports: [ReceiptsService],
})
export class ReceiptsModule {}
