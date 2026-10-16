import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { ChecksModule } from '../checks/checks.module'
import { CoreModule } from '../core/core.module'
import { PrismaModule } from '../prisma/prisma.module'
import { StorageModule } from '../storage/storage.module'
import { AuditPackageService } from './audit-package.service'
import { BudgetController } from './budget.controller'
import { BudgetService } from './budget.service'
import { EngagementsController } from './engagements.controller'
import { EngagementsService } from './engagements.service'

@Module({
  imports: [PrismaModule, CoreModule, ChecksModule, AuthModule, StorageModule],
  controllers: [EngagementsController, BudgetController],
  providers: [EngagementsService, AuditPackageService, BudgetService],
  exports: [EngagementsService, AuditPackageService],
})
export class EngagementsModule {}
