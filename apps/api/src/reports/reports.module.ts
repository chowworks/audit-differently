import { Module } from '@nestjs/common'
import { StorageModule } from '../storage/storage.module'
import { MonthBundleService } from './month-bundle.service'
import { ReportsController } from './reports.controller'
import { ReportsService } from './reports.service'

@Module({
  imports: [StorageModule],
  controllers: [ReportsController],
  providers: [ReportsService, MonthBundleService],
  exports: [ReportsService],
})
export class ReportsModule {}
