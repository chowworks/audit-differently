import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { CoreModule } from '../core/core.module'
import { EngagementsModule } from '../engagements/engagements.module'
import { PrismaModule } from '../prisma/prisma.module'
import { StorageModule } from '../storage/storage.module'
import { EngagementDeletionController, WorkspaceDeletionController } from './deletion.controller'
import { DeletionService } from './deletion.service'

@Module({
  imports: [PrismaModule, CoreModule, AuthModule, StorageModule, EngagementsModule],
  controllers: [EngagementDeletionController, WorkspaceDeletionController],
  providers: [DeletionService],
})
export class DeletionModule {}
