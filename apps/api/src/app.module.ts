import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler'
import { HealthModule } from './health/health.module'
import { PrismaModule } from './prisma/prisma.module'
import { AuthModule } from './auth/auth.module'
import { CoreModule } from './core/core.module'
import { ChecksModule } from './checks/checks.module'
import { StorageModule } from './storage/storage.module'
import { MeModule } from './me/me.module'
import { EngagementsModule } from './engagements/engagements.module'
import { WorkspacesModule } from './workspaces/workspaces.module'
import { ReportsModule } from './reports/reports.module'
import { DocumentsModule } from './documents/documents.module'
import { ParticipantsModule } from './participants/participants.module'
import { TenantMiddleware } from './core/tenant.middleware'

@Module({
  imports: [
    // 120 requests a minute per client on every route; uploads, signed links and sign-in bootstrap are tighter
    // (@Throttle on the handlers). TRUST_PROXY makes the client address the real one behind Railway.
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 120 }]),
    PrismaModule,
    CoreModule,
    ChecksModule,
    HealthModule,
    AuthModule,
    StorageModule,
    MeModule,
    EngagementsModule,
    WorkspacesModule,
    ReportsModule,
    DocumentsModule,
    ParticipantsModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantMiddleware).forRoutes('*')
  }
}
