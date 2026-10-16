import { ConflictException, type ArgumentsHost } from '@nestjs/common'
import { BaseExceptionFilter } from '@nestjs/core'
import { Prisma } from '@prisma/client'
import { MonthLockedFilter, isMonthLocked } from './month-locked.filter'

describe('MonthLockedFilter', () => {
  const host = {} as ArgumentsHost
  const passed = () => {
    const spy = jest.spyOn(BaseExceptionFilter.prototype, 'catch').mockImplementation(() => {})
    return spy
  }
  afterEach(() => jest.restoreAllMocks())

  it("answers the database's month lock with a 409", () => {
    const spy = passed()
    const e = new Prisma.PrismaClientUnknownRequestError(
      'db error: ERROR: month_locked: the 2026-09 report is closed; only a draft month can change',
      { clientVersion: '5' }
    )
    expect(isMonthLocked(e)).toBe(true)
    new MonthLockedFilter().catch(e, host)
    expect(spy.mock.calls[0][0]).toBeInstanceOf(ConflictException)
  })

  it('passes every other database error on unchanged', () => {
    const spy = passed()
    const e = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: '5',
    })
    new MonthLockedFilter().catch(e, host)
    expect(spy.mock.calls[0][0]).toBe(e)
  })
})
