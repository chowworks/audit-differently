import { Controller, Get } from '@nestjs/common'
import type { Health } from '@ad/types'

/**
 * The environment this API runs in: Railway's environment name when it has one ("production", "dev"), else
 * "production" if NODE_ENV says so, else "local". The web app shows a banner when it is anything but
 * production, so a page always says which system it is talking to (EnvironmentBanner).
 */
export function environmentName(env: NodeJS.ProcessEnv = process.env): string {
  return env.RAILWAY_ENVIRONMENT_NAME || (env.NODE_ENV === 'production' ? 'production' : 'local')
}

@Controller('health')
export class HealthController {
  @Get()
  check(): Health {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: '0.0.1',
      environment: environmentName(),
    }
  }
}
