import { Global, Module } from '@nestjs/common'
import { AccessLogService } from './access-log.service'
import { CallerService } from './caller'

@Global()
@Module({
  providers: [CallerService, AccessLogService],
  exports: [CallerService, AccessLogService],
})
export class CoreModule {}
