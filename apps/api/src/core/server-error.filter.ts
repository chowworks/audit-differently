import { ArgumentsHost, Catch, HttpException } from '@nestjs/common'
import { BaseExceptionFilter } from '@nestjs/core'
import type { Request } from 'express'
import { ServiceFailureLog } from './service-failure-log'

/**
 * Every error the API answers with a 5xx is counted for the /api/health/server-errors check, by its route pattern
 * (`GET /api/engagements/:id`, never the ids). Nest's own handling then answers as it always did; a 4xx (the request's
 * fault) is not counted.
 */
@Catch()
export class ServerErrorFilter extends BaseExceptionFilter {
  constructor(private readonly failures: ServiceFailureLog) {
    super()
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const status = exception instanceof HttpException ? exception.getStatus() : 500
    if (status >= 500 && host.getType() === 'http') {
      const req = host.switchToHttp().getRequest<Request>()
      const path = (req.route as { path?: string } | undefined)?.path ?? 'unmatched'
      void this.failures.record('server', `${req.method} ${path}`)
    }
    super.catch(exception, host)
  }
}
