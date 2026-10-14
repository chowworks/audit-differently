import { ForbiddenException, UnauthorizedException, type ExecutionContext } from '@nestjs/common'
import { identifyCaller, tenantContext, withTenantContext } from '../core/tenant-context'
import { AdminGuard } from './admin.guard'

/** The request AuthenticatedGuard has already verified, as `userId`. */
const context = (userId?: string) =>
  ({ switchToHttp: () => ({ getRequest: () => ({ userId }) }) }) as unknown as ExecutionContext

/** A guard whose Clerk answers `role` for every user. */
const guard = (role: string | null) => {
  const clerk = { getRole: jest.fn().mockResolvedValue(role) }
  return { guard: new AdminGuard(clerk as never), clerk }
}

/** Runs the guard inside a request's context, as the middleware and AuthenticatedGuard leave it. */
const inRequest = <T>(userId: string, fn: () => Promise<T>) =>
  withTenantContext(async () => {
    identifyCaller({ userId })
    const out = await fn().catch((e: unknown) => e)
    return { out, ctx: { ...tenantContext() } }
  })

describe('AdminGuard', () => {
  it('asks Clerk for the role on every request and lets an admin through, marking the request', async () => {
    const { guard: g, clerk } = guard('admin')
    const { out, ctx } = await inRequest('user_admin', () => g.canActivate(context('user_admin')))
    expect(out).toBe(true)
    expect(clerk.getRole).toHaveBeenCalledWith('user_admin')
    expect(ctx).toEqual({ userId: 'user_admin', allWorkspaces: false, admin: true })
  })

  it.each([null, 'institution-admin', 'owner'])(
    'refuses anyone else with 403, and marks nothing (role %s)',
    async (role) => {
      const { guard: g } = guard(role)
      const { out, ctx } = await inRequest('user_pat', () => g.canActivate(context('user_pat')))
      expect(out).toBeInstanceOf(ForbiddenException)
      expect(ctx.admin).toBe(false)
    }
  )

  it('refuses a request AuthenticatedGuard did not verify', async () => {
    const { guard: g, clerk } = guard('admin')
    await expect(g.canActivate(context())).rejects.toThrow(UnauthorizedException)
    expect(clerk.getRole).not.toHaveBeenCalled()
  })

  it('cannot mark a request no guard has named a caller for', async () => {
    const { guard: g } = guard('admin')
    const ctx = await withTenantContext(async () => {
      await g.canActivate(context('user_admin'))
      return { ...tenantContext() }
    })
    expect(ctx.admin).toBeUndefined()
  })
})
