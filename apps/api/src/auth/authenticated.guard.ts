import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common'
import { identifyCaller } from '../core/tenant-context'
import { ClerkService } from './clerk.service'

/**
 * Guard for endpoints that need any signed-in user. Verifies the Clerk Bearer token, attaches `request.userId`
 * and tells the tenant context who the caller is. What the caller may do inside a workspace is decided by their
 * Membership rows, in the handler (core/caller.ts). Clerk is the only way in, in every environment.
 */
@Injectable()
export class AuthenticatedGuard implements CanActivate {
  constructor(private readonly clerk: ClerkService) {}

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
    return true
  }
}
