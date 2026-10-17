import { Logger } from '@nestjs/common'
import { tenantContext } from '../core/tenant-context'
import { PayrollMatchSweeper } from './payroll-match.sweeper'

/** The timer that removes payroll matches left past RUN_HOURS: trusted work, batch after batch, never two at once. */
describe('PayrollMatchSweeper', () => {
  it('removes expired runs as trusted work, a batch at a time, until none is left', async () => {
    const seen: unknown[] = []
    const counts = [50, 3, 0]
    const matches = {
      expireAll: jest.fn(async () => {
        seen.push(tenantContext())
        return counts.shift()!
      }),
    }
    const sweeper = new PayrollMatchSweeper(matches as never)
    expect(await sweeper.sweep()).toBe(53)
    expect(matches.expireAll).toHaveBeenCalledTimes(3)
    expect(seen).toEqual([
      { allWorkspaces: true },
      { allWorkspaces: true },
      { allWorkspaces: true },
    ])
  })

  it('runs one pass at a time, and a failed pass stops without throwing', async () => {
    let release!: (n: number) => void
    const matches = {
      expireAll: jest
        .fn()
        .mockImplementationOnce(() => new Promise<number>((r) => (release = r)))
        .mockRejectedValueOnce(new Error('database away')),
    }
    const sweeper = new PayrollMatchSweeper(matches as never)
    const first = sweeper.sweep()
    expect(await sweeper.sweep()).toBe(0)
    release(0)
    expect(await first).toBe(0)
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    await expect(sweeper.sweep()).resolves.toBe(0)
    expect(matches.expireAll).toHaveBeenCalledTimes(2)
  })

  it('starts no timer under the tests', () => {
    const spy = jest.spyOn(global, 'setInterval')
    new PayrollMatchSweeper({} as never).onModuleInit()
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})
