import { BadRequestException } from '@nestjs/common'
import type { AccessLogService } from '../core/access-log.service'
import type { Caller } from '../core/caller'
import type { PrismaService } from '../prisma/prisma.service'
import { linkDocument, type LinkTarget } from './link'
import type { StagedFile } from './staged-file'

const staged = (data: { engagementId: string | null; period: string | null; kind: string }) =>
  ({
    data: { workspaceId: 'w-1', sensitivity: 'financial', ...data },
    commit: jest.fn(async (fn: () => Promise<unknown>) => fn()),
  }) as unknown as StagedFile

const target = (over: Partial<LinkTarget> = {}): LinkTarget => ({
  workspaceId: 'w-1',
  engagementId: 'e-1',
  resource: 'expense',
  subjectId: 'x-1',
  subject: 'expense 1001',
  purpose: 'timesheet',
  words: (p) => p,
  find: async () => null,
  create: async () => undefined,
  move: async () => undefined,
  ...over,
})

describe('linkDocument, a new upload', () => {
  const log = { change: jest.fn(async () => undefined) } as unknown as AccessLogService
  const prisma = {} as PrismaService
  const caller = {} as Caller
  const link = (t: LinkTarget, s: StagedFile) => linkDocument(prisma, log, caller, t, s)

  it("is filed under the record's engagement", async () => {
    await expect(
      link(target(), staged({ engagementId: 'e-1', period: '2026-09', kind: 'timesheet' }))
    ).resolves.toBeUndefined()
    await expect(
      link(target(), staged({ engagementId: 'e-2', period: '2026-09', kind: 'timesheet' }))
    ).rejects.toThrow(BadRequestException)
  })

  it("is filed once for the workspace when an owner adds a payroll proof on the month end, for the record's month only", async () => {
    const owner = target({ workspacePayroll: { period: '2026-09' } })
    await expect(
      link(owner, staged({ engagementId: null, period: '2026-09', kind: 'timesheet' }))
    ).resolves.toBeUndefined()
    // Another month, a kind that is not payroll proof, or no owner: refused.
    await expect(
      link(owner, staged({ engagementId: null, period: '2026-08', kind: 'timesheet' }))
    ).rejects.toThrow(BadRequestException)
    await expect(
      link(owner, staged({ engagementId: null, period: '2026-09', kind: 'invoice' }))
    ).rejects.toThrow(BadRequestException)
    await expect(
      link(target(), staged({ engagementId: null, period: '2026-09', kind: 'timesheet' }))
    ).rejects.toThrow(BadRequestException)
  })
})
