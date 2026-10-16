import { DEFAULT_HIGHLIGHTS } from '@ad/types'
import { HighlightSettingsService } from './highlight-settings.service'

const admin = { userId: 'admin-1', email: 'admin@example.test' } as never

function service(rows: object[] = []) {
  const create = jest.fn().mockResolvedValue({})
  const prisma = { highlightSetting: { findMany: jest.fn().mockResolvedValue(rows), create } }
  return { s: new HighlightSettingsService(prisma as never), create }
}

describe('HighlightSettingsService', () => {
  it('uses the defaults for a proof type nobody changed, and the newest save for one that was', async () => {
    const { s } = service([
      {
        kind: 'paystub',
        fields: ['name'],
        changedByEmail: 'admin@example.test',
        changedAt: new Date('2026-10-16T12:00:00Z'),
      },
      {
        kind: 'paystub',
        fields: ['amount'],
        changedByEmail: 'old@example.test',
        changedAt: new Date('2026-10-01T12:00:00Z'),
      },
    ])
    const now = await s.current()
    expect(now.paystub).toEqual(['name'])
    expect(now.timesheet).toEqual(DEFAULT_HIGHLIGHTS.timesheet)
    const list = await s.list()
    expect(list.find((x) => x.kind === 'paystub')).toMatchObject({
      changedByEmail: 'admin@example.test',
    })
    expect(list.find((x) => x.kind === 'timesheet')).toMatchObject({
      changedByEmail: null,
      changedAt: null,
    })
  })

  it("saves a new row in the admin's own name, and refuses an unknown proof type or field, or none", async () => {
    const { s, create } = service()
    await expect(s.set(admin, 'register', ['amount'])).rejects.toThrow(/Choose a timesheet/)
    await expect(
      s.set(admin, 'payroll-register', ['payPeriod', 'amount', 'amount'])
    ).resolves.toBeDefined()
    expect(create).toHaveBeenLastCalledWith({
      data: {
        kind: 'payroll-register',
        fields: ['payPeriod', 'amount'],
        changedById: 'admin-1',
        changedByEmail: 'admin@example.test',
      },
    })
    await expect(s.set(admin, 'paystub', [])).rejects.toThrow(/at least one/)
    await expect(s.set(admin, 'paystub', ['ssn'])).rejects.toThrow(/at least one/)
    expect(create).toHaveBeenCalledTimes(1)
  })
})
