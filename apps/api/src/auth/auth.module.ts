import { Global, Module } from '@nestjs/common'
import { ClerkService } from './clerk.service'
import { AuthenticatedGuard } from './authenticated.guard'

@Global()
@Module({
  providers: [ClerkService, AuthenticatedGuard],
  exports: [ClerkService, AuthenticatedGuard],
})
export class AuthModule {}
