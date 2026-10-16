import { Global, Module } from '@nestjs/common'
import { AccessLogService } from './access-log.service'
import { CallerService } from './caller'
import { MatchStatsService } from './match-stats.service'

@Global()
@Module({
  providers: [CallerService, AccessLogService, MatchStatsService],
  exports: [CallerService, AccessLogService, MatchStatsService],
})
export class CoreModule {}
