import { Global, Module } from '@nestjs/common'
import { ClerkService } from './clerk.service'
import { AuthenticatedGuard } from './authenticated.guard'
import { AdminGuard } from './admin.guard'
import { TermsService } from './terms.service'

@Global()
@Module({
  providers: [ClerkService, TermsService, AuthenticatedGuard, AdminGuard],
  exports: [ClerkService, TermsService, AuthenticatedGuard, AdminGuard],
})
export class AuthModule {}
