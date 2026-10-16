import { Global, Module } from '@nestjs/common'
import { APP_FILTER } from '@nestjs/core'
import { AccessLogService } from './access-log.service'
import { CallerService } from './caller'
import { ServerErrorFilter } from './server-error.filter'
import { ServiceFailureLog } from './service-failure-log'

@Global()
@Module({
  providers: [
    CallerService,
    AccessLogService,
    ServiceFailureLog,
    // counts every 5xx for the server-errors health check (health.controller.ts)
    { provide: APP_FILTER, useClass: ServerErrorFilter },
  ],
  exports: [CallerService, AccessLogService, ServiceFailureLog],
})
export class CoreModule {}
