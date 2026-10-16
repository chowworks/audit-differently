import { Logger } from '@nestjs/common'
import type { PrismaService } from '../prisma/prisma.service'
import { FAILURE_KEEP_MS, FAILURE_WINDOW_MS, ServiceFailureLog } from './service-failure-log'

function setup() {
  const serviceFailure = {
    create: jest.fn().mockResolvedValue({}),
    deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    count: jest.fn().mockResolvedValue(0),
  }
  const log = new ServiceFailureLog({ serviceFailure } as unknown as PrismaService)
  log.now = () => Date.parse('2026-10-16T12:00:00Z')
  return { log, serviceFailure }
}

describe('ServiceFailureLog', () => {
  afterEach(() => jest.restoreAllMocks())

  it('keeps when, which kind and the route, and nothing else', async () => {
    const { log, serviceFailure } = setup()
    await log.record('upload', 'POST /api/documents')
    expect(serviceFailure.create).toHaveBeenCalledWith({
      data: { at: new Date('2026-10-16T12:00:00Z'), kind: 'upload', route: 'POST /api/documents' },
    })
  })

  it('cuts a long route to the column bound', async () => {
    const { log, serviceFailure } = setup()
    await log.record('server', `GET /${'x'.repeat(500)}`)
    expect(serviceFailure.create.mock.calls[0][0].data.route).toHaveLength(200)
  })

  it('deletes rows older than 30 days, at most once an hour', async () => {
    const { log, serviceFailure } = setup()
    await log.record('server', 'GET /api/x')
    await log.record('server', 'GET /api/x')
    expect(serviceFailure.deleteMany).toHaveBeenCalledTimes(1)
    expect(serviceFailure.deleteMany).toHaveBeenCalledWith({
      where: { at: { lt: new Date(Date.parse('2026-10-16T12:00:00Z') - FAILURE_KEEP_MS) } },
    })
  })

  it('never rejects: a database error is logged and the failure is lost', async () => {
    const { log, serviceFailure } = setup()
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {})
    serviceFailure.create.mockRejectedValue(new Error('database down'))
    await expect(log.record('upload', 'POST /api/documents')).resolves.toBeUndefined()
    expect(error).toHaveBeenCalled()
  })

  it('counts one kind in the last 15 minutes, failing when there is any', async () => {
    const { log, serviceFailure } = setup()
    expect(await log.recent('upload')).toEqual({ status: 'ok', failures: 0, windowMinutes: 15 })
    expect(serviceFailure.count).toHaveBeenCalledWith({
      where: {
        kind: 'upload',
        at: { gte: new Date(Date.parse('2026-10-16T12:00:00Z') - FAILURE_WINDOW_MS) },
      },
    })
    serviceFailure.count.mockResolvedValue(3)
    expect(await log.recent('server')).toEqual({
      status: 'failing',
      failures: 3,
      windowMinutes: 15,
    })
  })
})
