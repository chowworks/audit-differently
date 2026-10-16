import type { Response } from 'express'
import type { ServiceFailureLog } from '../core/service-failure-log'
import {
  CHECK_CACHE_MS,
  CHECK_TIMEOUT_MS,
  HealthController,
  environmentName,
} from './health.controller'

describe('environmentName', () => {
  it('uses the Railway environment name when there is one', () => {
    expect(environmentName({ RAILWAY_ENVIRONMENT_NAME: 'dev', NODE_ENV: 'development' })).toBe(
      'dev'
    )
  })
  it('falls back to production or local from NODE_ENV', () => {
    expect(environmentName({ NODE_ENV: 'production' })).toBe('production')
    expect(environmentName({})).toBe('local')
  })
})

function setup() {
  const recent = jest.fn().mockResolvedValue({ status: 'ok', failures: 0, windowMinutes: 15 })
  const controller = new HealthController({ recent } as unknown as ServiceFailureLog)
  const res = () => {
    const r = { status: jest.fn() }
    r.status.mockReturnValue(r)
    return r as unknown as Response & { status: jest.Mock }
  }
  return { controller, recent, res }
}

describe('HealthController', () => {
  afterEach(() => jest.useRealTimers())

  it('reports the environment', () => {
    expect(setup().controller.check()).toMatchObject({
      status: 'ok',
      environment: expect.any(String),
    })
  })
  it('says nothing about configuration: four plain fields and no more', () => {
    expect(Object.keys(setup().controller.check()).sort()).toEqual([
      'environment',
      'status',
      'timestamp',
      'version',
    ])
  })

  it('counts each kind on its own route, and answers ok when there was none', async () => {
    const { controller, recent, res } = setup()
    const r = res()
    expect(await controller.uploadFailures(r)).toEqual({
      status: 'ok',
      failures: 0,
      windowMinutes: 15,
    })
    await controller.serverErrors(res())
    expect(recent.mock.calls).toEqual([['upload'], ['server']])
    expect(r.status).not.toHaveBeenCalled()
  })

  it('answers 503 when there was a failure in the window', async () => {
    const { controller, recent, res } = setup()
    recent.mockResolvedValue({ status: 'failing', failures: 2, windowMinutes: 15 })
    const r = res()
    expect(await controller.serverErrors(r)).toMatchObject({ status: 'failing', failures: 2 })
    expect(r.status).toHaveBeenCalledWith(503)
  })

  it('answers 503 when it cannot count, and never says why', async () => {
    const { controller, recent, res } = setup()
    recent.mockRejectedValue(new Error('connect ECONNREFUSED db.internal:5432'))
    const r = res()
    const out = await controller.uploadFailures(r)
    expect(r.status).toHaveBeenCalledWith(503)
    expect(Object.keys(out).sort()).toEqual(['failures', 'status', 'windowMinutes'])
    expect(out.status).toBe('failing')
  })

  it('a count that hangs is failing after the timeout', async () => {
    jest.useFakeTimers()
    const { controller, recent, res } = setup()
    recent.mockReturnValue(new Promise(() => {}))
    const r = res()
    const pending = controller.serverErrors(r)
    await jest.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS)
    expect((await pending).status).toBe('failing')
    expect(r.status).toHaveBeenCalledWith(503)
  })

  it('reuses a result for a minute, so a public caller cannot hammer the database', async () => {
    jest.useFakeTimers()
    const { controller, recent, res } = setup()
    await controller.uploadFailures(res())
    await controller.uploadFailures(res())
    expect(recent).toHaveBeenCalledTimes(1)
    jest.advanceTimersByTime(CHECK_CACHE_MS)
    await controller.uploadFailures(res())
    expect(recent).toHaveBeenCalledTimes(2)
  })
})
