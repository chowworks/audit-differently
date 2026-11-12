import { Module } from '@nestjs/common'
import { ChecksModule } from '../checks/checks.module'
import { DocumentsModule } from '../documents/documents.module'
import { StorageModule } from '../storage/storage.module'
import { ExpensesController } from './expenses.controller'
import { ExpensesService } from './expenses.service'

@Module({
  imports: [ChecksModule, DocumentsModule, StorageModule],
  controllers: [ExpensesController],
  providers: [ExpensesService],
})
export class ExpensesModule {}
