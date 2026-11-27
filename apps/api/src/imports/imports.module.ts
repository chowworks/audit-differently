import { Module } from '@nestjs/common'
import { AliasesModule } from '../aliases/aliases.module'
import { EngagementsModule } from '../engagements/engagements.module'
import { ReportsModule } from '../reports/reports.module'
import { ImportsController } from './imports.controller'
import { ImportsService } from './imports.service'

@Module({
  imports: [AliasesModule, EngagementsModule, ReportsModule],
  controllers: [ImportsController],
  providers: [ImportsService],
})
export class ImportsModule {}
