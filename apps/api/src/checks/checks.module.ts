import { Global, Module } from '@nestjs/common'
import { ChecksService } from './checks.service'

@Global()
@Module({ providers: [ChecksService], exports: [ChecksService] })
export class ChecksModule {}
