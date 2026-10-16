import { Module } from '@nestjs/common'
import { DocumentsModule } from '../documents/documents.module'
import { ReportsModule } from '../reports/reports.module'
import { StorageModule } from '../storage/storage.module'
import { PayrollMatchController } from './payroll-match.controller'
import { HighlightSettingsService } from './highlight-settings.service'
import { PayrollMatchService } from './payroll-match.service'
import { PayrollMatchWorker } from './payroll-match.worker'
import { PayrollController } from './payroll.controller'
import { PayrollService } from './payroll.service'

@Module({
  imports: [DocumentsModule, ReportsModule, StorageModule],
  controllers: [PayrollController, PayrollMatchController],
  providers: [PayrollService, PayrollMatchService, PayrollMatchWorker, HighlightSettingsService],
  exports: [HighlightSettingsService],
})
export class PayrollModule {}
