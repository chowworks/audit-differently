import { UnauthorizedException, type ExecutionContext } from '@nestjs/common'
import { AuthenticatedGuard } from './authenticated.guard'

/** A request with these headers, and the execution context that hands it to the guard. */
const request = (headers: Record<string, string>) => {
  const req: { headers: Record<string, string>; userId?: string } = { headers }
  const context = { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext
  return { req, context }
}

/** A guard whose Clerk verifies every token as `verified`. */
const guard = (verified: string | null) => {
  const clerk = { verifyBearerToken: jest.fn().mockResolvedValue(verified) }
  return { guard: new AuthenticatedGuard(clerk as never), clerk }
}

describe('AuthenticatedGuard', () => {
  it('refuses a request with no token', async () => {
    const { guard: g, clerk } = guard('user_1')
    await expect(g.canActivate(request({}).context)).rejects.toThrow(UnauthorizedException)
    expect(clerk.verifyBearerToken).not.toHaveBeenCalled()
  })

  it('refuses anything but a Bearer token, without asking Clerk', async () => {
    const { guard: g, clerk } = guard('user_1')
    await expect(
      g.canActivate(request({ authorization: 'Demo demo-sam' }).context)
    ).rejects.toThrow(UnauthorizedException)
    expect(clerk.verifyBearerToken).not.toHaveBeenCalled()
  })

  it('refuses a token Clerk does not verify', async () => {
    const { guard: g } = guard(null)
    await expect(g.canActivate(request({ authorization: 'Bearer nope' }).context)).rejects.toThrow(
      UnauthorizedException
    )
  })

  it('lets a verified bearer through and names the caller on the request', async () => {
    const { guard: g, clerk } = guard('user_1')
    const { req, context } = request({ authorization: 'Bearer good' })
    expect(await g.canActivate(context)).toBe(true)
    expect(clerk.verifyBearerToken).toHaveBeenCalledWith('good')
    expect(req.userId).toBe('user_1')
  })
})
