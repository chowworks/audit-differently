import { Module } from '@nestjs/common'
import { DocumentsModule } from '../documents/documents.module'
import { ReportsModule } from '../reports/reports.module'
import { StorageModule } from '../storage/storage.module'
import { PayrollController } from './payroll.controller'
import { PayrollService } from './payroll.service'

@Module({
  imports: [DocumentsModule, ReportsModule, StorageModule],
  controllers: [PayrollController],
  providers: [PayrollService],
})
export class PayrollModule {}
