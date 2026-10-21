import { Module } from '@nestjs/common'
import { DocumentsModule } from '../documents/documents.module'
import { EngagementsModule } from '../engagements/engagements.module'
import { StaffModule } from '../staff/staff.module'
import { ReportsModule } from '../reports/reports.module'
import { StorageModule } from '../storage/storage.module'
import { PayrollMatchController } from './payroll-match.controller'
import { HighlightSettingsService } from './highlight-settings.service'
import { PayrollAiService } from './payroll-ai.service'
import { PayrollReadingService } from './payroll-reading.service'
import { PayrollMatchService } from './payroll-match.service'
import { PayrollMatchSweeper } from './payroll-match.sweeper'
import { PayrollMatchWorker } from './payroll-match.worker'
import { PayrollController } from './payroll.controller'
import { PayrollService } from './payroll.service'
import { WorkspacePayrollController } from './workspace-payroll.controller'
import { WorkspacePayrollService } from './workspace-payroll.service'

@Module({
  imports: [DocumentsModule, EngagementsModule, ReportsModule, StaffModule, StorageModule],
  controllers: [PayrollController, PayrollMatchController, WorkspacePayrollController],
  providers: [
    PayrollService,
    PayrollMatchService,
    PayrollMatchWorker,
    PayrollMatchSweeper,
    HighlightSettingsService,
    PayrollReadingService,
    PayrollAiService,
    WorkspacePayrollService,
  ],
  exports: [HighlightSettingsService, PayrollReadingService],
})
export class PayrollModule {}
