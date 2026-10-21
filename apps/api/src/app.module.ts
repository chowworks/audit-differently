import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common'
import { APP_FILTER, APP_GUARD } from '@nestjs/core'
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler'
import { MonthLockedFilter } from './reports/month-locked.filter'
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
import { DeletionModule } from './deletion/deletion.module'
import { ContactModule } from './contact/contact.module'
import { AdminModule } from './admin/admin.module'
import { ImportsModule } from './imports/imports.module'
import { ReceiptsModule } from './receipts/receipts.module'
import { PayrollModule } from './payroll/payroll.module'
import { InboundModule } from './inbound/inbound.module'
import { StaffModule } from './staff/staff.module'
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
    DeletionModule,
    ContactModule,
    AdminModule,
    ImportsModule,
    ReceiptsModule,
    PayrollModule,
    StaffModule,
    InboundModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // The database's month lock (a closed or submitted month refuses ledger writes) answers as a 409 on every route.
    { provide: APP_FILTER, useClass: MonthLockedFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantMiddleware).forRoutes('*')
  }
}
