import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common'
import { identifyAdmin } from '../core/tenant-context'
import { ClerkService } from './clerk.service'

/**
 * Guard for the platform admin's routes, always after AuthenticatedGuard: `@UseGuards(AuthenticatedGuard, AdminGuard)`.
 * AuthenticatedGuard has verified the token, named the caller and applied the Terms gate; this asks Clerk's backend for
 * the caller's `publicMetadata.role` on every request (a role the browser claims is never trusted) and refuses anyone
 * but an admin with 403. For an admin it marks the request, so PrismaService sets app.admin = 'on': workspace level
 * only (migration 20261013000200). Same convention as Interview Differently's AdminGuard.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  private readonly logger = new Logger(AdminGuard.name)

  constructor(private readonly clerk: ClerkService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const { userId } = context.switchToHttp().getRequest<{ userId?: string }>()
    if (!userId) throw new UnauthorizedException('AdminGuard runs after AuthenticatedGuard')
    if ((await this.clerk.getRole(userId)) !== 'admin') {
      this.logger.debug(`Admin route refused for ${userId}`)
      throw new ForbiddenException('Platform admins only')
    }
    identifyAdmin()
    return true
  }
}
