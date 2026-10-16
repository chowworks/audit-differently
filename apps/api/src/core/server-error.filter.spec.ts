import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common'
import type { ArgumentsHost } from '@nestjs/common'
import { BaseExceptionFilter } from '@nestjs/core'
import { ServerErrorFilter } from './server-error.filter'
import type { ServiceFailureLog } from './service-failure-log'

function setup(route: { path: string } | null = { path: '/api/engagements/:id' }) {
  const record = jest.fn().mockResolvedValue(undefined)
  const filter = new ServerErrorFilter({ record } as unknown as ServiceFailureLog)
  const req = { method: 'GET', route: route ?? undefined, url: '/api/engagements/e-123' }
  const host = {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ArgumentsHost
  return { filter, record, host }
}

describe('ServerErrorFilter', () => {
  // Nest's own answer is not under test here
  beforeEach(() => jest.spyOn(BaseExceptionFilter.prototype, 'catch').mockImplementation(() => {}))
  afterEach(() => jest.restoreAllMocks())

  it('counts an unexpected error by its route pattern, never its ids, then lets Nest answer', () => {
    const { filter, record, host } = setup()
    const err = new Error('boom')
    filter.catch(err, host)
    expect(record).toHaveBeenCalledWith('server', 'GET /api/engagements/:id')
    expect(BaseExceptionFilter.prototype.catch).toHaveBeenCalledWith(err, host)
  })

  it('counts a 5xx HttpException', () => {
    const { filter, record, host } = setup()
    filter.catch(new ServiceUnavailableException(), host)
    expect(record).toHaveBeenCalledWith('server', 'GET /api/engagements/:id')
  })

  it("does not count a 4xx: that is the request's fault", () => {
    const { filter, record, host } = setup()
    filter.catch(new NotFoundException(), host)
    filter.catch(new BadRequestException(), host)
    expect(record).not.toHaveBeenCalled()
    expect(BaseExceptionFilter.prototype.catch).toHaveBeenCalledTimes(2)
  })

  it('names a request that matched no route without its path', () => {
    const { filter, record, host } = setup(null)
    filter.catch(new Error('boom'), host)
    expect(record).toHaveBeenCalledWith('server', 'GET unmatched')
  })
})
