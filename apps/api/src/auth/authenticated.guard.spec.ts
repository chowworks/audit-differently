import { ForbiddenException, UnauthorizedException, type ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { SkipTermsGate } from './skip-terms-gate.decorator'
import { AuthenticatedGuard } from './authenticated.guard'
import { TermsService } from './terms.service'

/** A request with these headers, and the execution context that hands it to the guard. */
class Plain {
  handler() {}
}
class Open {
  @SkipTermsGate()
  handler() {}
}
const request = (
  headers: Record<string, string>,
  controller: typeof Plain | typeof Open = Plain
) => {
  const req: { headers: Record<string, string>; userId?: string } = { headers }
  const context = {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => controller.prototype.handler,
    getClass: () => controller,
  } as unknown as ExecutionContext
  return { req, context }
}

/** A guard whose Clerk verifies every token as `verified`. */
const guard = (verified: string | null, accepted = true) => {
  const clerk = { verifyBearerToken: jest.fn().mockResolvedValue(verified) }
  const terms = { hasAccepted: jest.fn().mockResolvedValue(accepted) }
  return {
    guard: new AuthenticatedGuard(
      clerk as never,
      terms as unknown as TermsService,
      new Reflector()
    ),
    clerk,
    terms,
  }
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

  describe('the Terms', () => {
    const good = { authorization: 'Bearer good' }

    it('refuses a signed-in person who has not accepted, with a code the app can act on', async () => {
      const { guard: g, terms } = guard('user_1', false)
      const refused = g.canActivate(request(good).context)
      await expect(refused).rejects.toThrow(ForbiddenException)
      await expect(refused).rejects.toMatchObject({
        response: { code: 'terms_required' },
        status: 403,
      })
      expect(terms.hasAccepted).toHaveBeenCalledWith('user_1')
    })

    it('lets them through once they have accepted', async () => {
      const { guard: g } = guard('user_1', true)
      expect(await g.canActivate(request(good).context)).toBe(true)
    })

    it('does not ask a route marked @SkipTermsGate', async () => {
      const { guard: g, terms } = guard('user_1', false)
      const { req, context } = request(good, Open)
      expect(await g.canActivate(context)).toBe(true)
      expect(req.userId).toBe('user_1')
      expect(terms.hasAccepted).not.toHaveBeenCalled()
    })

    it('still refuses an unverified token on a route marked @SkipTermsGate', async () => {
      const { guard: g } = guard(null, false)
      await expect(g.canActivate(request(good, Open).context)).rejects.toThrow(
        UnauthorizedException
      )
    })
  })
})
