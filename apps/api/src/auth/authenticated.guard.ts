import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { TERMS_REQUIRED_CODE } from '@ad/types'
import { identifyCaller } from '../core/tenant-context'
import { ClerkService } from './clerk.service'
import { SKIP_TERMS_GATE } from './skip-terms-gate.decorator'
import { TermsService } from './terms.service'

/**
 * Guard for endpoints that need any signed-in user. Verifies the Clerk Bearer token, attaches `request.userId`
 * and tells the tenant context who the caller is. What the caller may do inside a workspace is decided by their
 * Membership rows, in the handler (core/caller.ts). Clerk is the only way in, in every environment.
 *
 * Then the Terms: a person who has not accepted the current version (the fingerprint of their wording) is refused with 403
 * `{ code: 'terms_required' }`, except on the routes marked @SkipTermsGate (GET /me, POST /me/terms).
 */
@Injectable()
export class AuthenticatedGuard implements CanActivate {
  constructor(
    private readonly clerk: ClerkService,
    private readonly terms: TermsService,
    private readonly reflector: Reflector
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>
      userId?: string
    }>()
    const auth = request.headers['authorization'] ?? request.headers['Authorization']
    if (!auth?.startsWith('Bearer ')) throw new UnauthorizedException('Missing Bearer token')
    const userId = await this.clerk.verifyBearerToken(auth.slice('Bearer '.length).trim())
    if (!userId) throw new UnauthorizedException('Invalid or expired token')
    request.userId = userId
    identifyCaller({ userId })
    const skip = this.reflector.getAllAndOverride<boolean | undefined>(SKIP_TERMS_GATE, [
      context.getHandler(),
      context.getClass(),
    ])
    if (!skip && !(await this.terms.hasAccepted(userId)))
      throw new ForbiddenException({
        code: TERMS_REQUIRED_CODE,
        message: 'Accept the Terms & Conditions to continue.',
      })
    return true
  }
}
