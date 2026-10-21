import { NotFoundException } from '@nestjs/common'
import type { Caller } from '../core/caller'
import { PayrollAiService } from './payroll-ai.service'

describe('reading payroll files with AI', () => {
  const W = 'w-1'
  const as = (role: 'owner' | 'bookkeeper' | 'auditor'): Caller =>
    ({
      userId: `u-${role}`,
      displayName: role,
      memberships: [{ workspaceId: W, workspaceName: 'Riverbend Youth Services', role }],
      workspaceIds: [W],
    }) as unknown as Caller

  it('refuses an auditor, who changes nothing, before anything is read or kept', async () => {
    const prisma = { payrollFileAiReading: { upsert: jest.fn(), findMany: jest.fn() } }
    const log = { change: jest.fn() }
    const ai = new PayrollAiService(prisma as never, log as never)
    jest.spyOn(ai, 'available').mockReturnValue(true)
    const bytes = jest.fn()
    const file = {
      id: 'f-1',
      sha256: 'sha-1',
      kind: 'paystub',
      contentType: 'application/pdf',
      documentId: null,
      lines: [],
      bytes,
    }
    await expect(ai.read(as('auditor'), W, [file], [], 'the payroll match')).rejects.toBeInstanceOf(
      NotFoundException
    )
    expect(bytes).not.toHaveBeenCalled()
    expect(prisma.payrollFileAiReading.upsert).not.toHaveBeenCalled()
    expect(log.change).not.toHaveBeenCalled()
  })
})
