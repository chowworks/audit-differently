import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { ChecksModule } from '../checks/checks.module'
import { CoreModule } from '../core/core.module'
import { PrismaModule } from '../prisma/prisma.module'
import { StorageModule } from '../storage/storage.module'
import { AuditPackageService } from './audit-package.service'
import { BudgetController, PayrollRollupController } from './budget.controller'
import { BudgetService } from './budget.service'
import { PayrollRollupService } from './payroll-rollup.service'
import { EngagementsController } from './engagements.controller'
import { EngagementsService } from './engagements.service'

@Module({
  imports: [PrismaModule, CoreModule, ChecksModule, AuthModule, StorageModule],
  controllers: [EngagementsController, BudgetController, PayrollRollupController],
  providers: [EngagementsService, AuditPackageService, BudgetService, PayrollRollupService],
  exports: [EngagementsService, AuditPackageService],
})
export class EngagementsModule {}
