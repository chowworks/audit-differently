import 'dotenv/config'
import { NestFactory } from '@nestjs/core'
import helmet from 'helmet'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { AppModule } from './app.module'
import { corsOrigin } from './cors'
import { assertDeployedConfig } from './startup-checks'

async function bootstrap() {
  // TLS to any database off this machine, row-level security on, Clerk, the private bucket: checked before listening.
  assertDeployedConfig()
  const app = await NestFactory.create<NestExpressApplication>(AppModule)
  // An API answers JSON and files, never a page: no inline anything, no framing, no sniffing, HSTS for a year.
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      hsts: { maxAge: 31536000, includeSubDomains: true },
      referrerPolicy: { policy: 'no-referrer' },
    })
  )
  app.enableCors({
    origin: corsOrigin(process.env.FRONTEND_URL),
    // The web app reads the file name, and the size and sha256 it checks a downloaded part against.
    exposedHeaders: ['Content-Disposition', 'X-Export-Bytes', 'X-Export-Sha256'],
  })
  // Behind a proxy (Railway) set TRUST_PROXY=1 so req.ip is the client.
  if (process.env.TRUST_PROXY) {
    const hops = Number(process.env.TRUST_PROXY)
    app.set('trust proxy', Number.isInteger(hops) ? hops : true)
  }
  app.setGlobalPrefix('api')
  const port = process.env.PORT ?? 3000
  await app.listen(port)
  console.log(`API running on port ${port}`)
}

bootstrap()
