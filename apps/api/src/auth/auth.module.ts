import { Global, Module } from '@nestjs/common'
import { ClerkService } from './clerk.service'
import { AuthenticatedGuard } from './authenticated.guard'
import { TermsService } from './terms.service'

@Global()
@Module({
  providers: [ClerkService, TermsService, AuthenticatedGuard],
  exports: [ClerkService, TermsService, AuthenticatedGuard],
})
export class AuthModule {}
