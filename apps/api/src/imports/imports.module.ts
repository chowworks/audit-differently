import { Module } from '@nestjs/common'
import { EngagementsModule } from '../engagements/engagements.module'
import { ReportsModule } from '../reports/reports.module'
import { ImportsController } from './imports.controller'
import { ImportsService } from './imports.service'

@Module({
  imports: [EngagementsModule, ReportsModule],
  controllers: [ImportsController],
  providers: [ImportsService],
})
export class ImportsModule {}
