import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common'
import type { Role } from '@ad/types'
import { member, scoped, stranger, W } from '../core/testing/callers'
import { expectNoneOf, fakeLog } from '../core/testing/log'
import { BudgetService } from './budget.service'

/** Who may change an engagement's approved budget, what each change logs, and that the checks run again. */
const engagement = () => ({
  id: 'e-1',
  workspaceId: W,
  name: 'Coding Pathway',
  workspace: { id: W },
})
const travel = () => ({
  id: 'b-1',
  workspaceId: W,
  engagementId: 'e-1',
  name: 'Travel',
  category: 'travel',
  reportLine: 'program-costs',
  amount: 1500,
  narrative: 'Mileage for site visits',
  sortOrder: 2,
})

/** A month of the engagement, as its row stands. */
const month = (id: string, period: string, status: string, extra: object = {}) => ({
  id,
  workspaceId: W,
  engagementId: 'e-1',
  period,
  status,
  preparedByName: 'Pat Example',
  submittedAt: null as Date | null,
  authorizedByName: null as string | null,
  authorizedAt: null as Date | null,
  closingNote: null as string | null,
  sentBackReason: null as string | null,
  ...extra,
})
const drafts = () => [
  month('r-1', '2026-08', 'draft'),
  month('r-2', '2026-09', 'draft'),
  month('r-3', '2026-10', 'draft'),
]
const approved = { authorizedByName: 'Dana Director', authorizedAt: new Date('2026-10-05') }
/** A submitted August, a closed September and a draft October. */
const mixed = () => [
  month('r-1', '2026-08', 'submitted', { ...approved, submittedAt: new Date('2026-09-10') }),
  month('r-2', '2026-09', 'closed', {
    ...approved,
    closingNote: 'Signed off at the board meeting',
  }),
  month('r-3', '2026-10', 'draft'),
]

function service(lines = [travel()], months = drafts(), spending = 0) {
  const rows = scoped(...lines)
  const prisma = {
    engagement: scoped(engagement()),
    budgetLine: {
      findFirst: jest.fn(async (args: { where: Record<string, unknown> }) => {
        const { category, engagementId, ...rest } = args.where
        const found = await rows.findFirst({ where: rest })
        if (!found) return null
        if (category !== undefined && found.category !== category) return null
        if (engagementId !== undefined && found.engagementId !== engagementId) return null
        return found
      }),
      findMany: jest.fn(async () => lines.filter((l) => l.engagementId === 'e-1')),
      count: jest.fn(async () => lines.filter((l) => l.engagementId === 'e-1').length),
      create: jest.fn(async ({ data }: { data: object }) => ({ id: 'b-2', ...data })),
      update: jest.fn(async ({ data }: { data: object }) => ({ ...travel(), ...data })),
      delete: jest.fn(async () => travel()),
    },
    // How many expenses are spent against the line.
    expense: { count: jest.fn(async () => spending) },
    monthlyReport: {
      findMany: jest.fn(async (args: { where: { status?: { in: string[] } } }) =>
        months
          .filter((m) => !args.where.status || args.where.status.in.includes(m.status))
          .map((m) => ({ id: m.id }))
      ),
      // A copy, as Prisma reads a row.
      findFirst: jest.fn(async (args: { where: { id: string } }) => {
        const m = months.find((x) => x.id === args.where.id)
        return m ? { ...m } : null
      }),
      update: jest.fn(async (args: { where: { id: string }; data: object }) =>
        Object.assign(
          months.find((x) => x.id === args.where.id)!,
          args.data
        )
      ),
    },
    reportReopening: {
      findFirst: jest.fn(async () => null),
      create: jest.fn(async ({ data }: { data: object }) => ({ id: 'ro-1', ...data })),
    },
    document: {
      // The signed copy August was submitted with.
      findMany: jest.fn(async () => [
        {
          id: 'd-signed',
          kind: 'signed-report',
          period: '2026-08',
          uploadedAt: new Date('2026-09-09'),
        },
      ]),
    },
  }
  const engagements = { detail: jest.fn().mockResolvedValue({ id: 'e-1' }) }
  const checks = { refresh: jest.fn().mockResolvedValue([]) }
  const log = fakeLog(prisma)
  const writes = [prisma.budgetLine.create, prisma.budgetLine.update, prisma.budgetLine.delete]
  return {
    service: new BudgetService(
      prisma as never,
      engagements as never,
      checks as never,
      log as never
    ),
    prisma,
    checks,
    log,
    writes,
    months,
  }
}

describe('BudgetService', () => {
  it('answers a member of another workspace with 404 and writes nothing', async () => {
    const { service: s, log, writes } = service()
    const who = stranger()
    await expect(
      s.add(who, 'e-1', { name: 'Rent', reportLine: 'program-costs', amount: 100 })
    ).rejects.toThrow(NotFoundException)
    await expect(s.update(who, 'e-1', 'b-1', { amount: 1 })).rejects.toThrow(NotFoundException)
    await expect(s.remove(who, 'e-1', 'b-1')).rejects.toThrow(NotFoundException)
    for (const w of writes) expect(w).not.toHaveBeenCalled()
    expect(log.entries).toEqual([])
  })

  it('lets an auditor change nothing', async () => {
    const { service: s, log, writes } = service()
    const who = member('auditor')
    await expect(s.add(who, 'e-1', { name: 'Rent', reportLine: 'program-costs' })).rejects.toThrow(
      ForbiddenException
    )
    await expect(s.update(who, 'e-1', 'b-1', { amount: 1 })).rejects.toThrow(ForbiddenException)
    await expect(s.remove(who, 'e-1', 'b-1')).rejects.toThrow(ForbiddenException)
    for (const w of writes) expect(w).not.toHaveBeenCalled()
    expect(log.entries).toEqual([])
  })

  it('answers a line of another engagement with 404', async () => {
    const { service: s, writes } = service([{ ...travel(), engagementId: 'e-9' }])
    await expect(s.update(member('owner'), 'e-1', 'b-1', { amount: 1 })).rejects.toThrow(
      NotFoundException
    )
    await expect(s.remove(member('owner'), 'e-1', 'b-1')).rejects.toThrow(NotFoundException)
    for (const w of writes) expect(w).not.toHaveBeenCalled()
  })

  it('takes a named line, once per engagement, with its form line and an amount of $0 or more', async () => {
    const { service: s, writes } = service()
    const who = member('bookkeeper')
    const rent = { name: 'Rent', reportLine: 'program-costs' as const }
    for (const bad of [
      { reportLine: 'program-costs' as const },
      { name: '   ', reportLine: 'program-costs' as const },
      { name: 'Rent' },
      { name: 'Rent', reportLine: 'not-a-line' as never },
      { name: ' travel ', reportLine: 'program-costs' as const, amount: 10 },
      { ...rent, amount: -5 },
      { ...rent, amount: 'lots' as unknown as number },
      { ...rent, narrative: 'x'.repeat(2001) },
    ])
      await expect(s.add(who, 'e-1', bad)).rejects.toThrow(BadRequestException)
    await expect(s.update(who, 'e-1', 'b-1', { amount: -1 })).rejects.toThrow(BadRequestException)
    for (const w of writes) expect(w).not.toHaveBeenCalled()
  })

  it.each(['owner', 'bookkeeper'] as Role[])(
    'lets the %s add, change and remove a line, each logged with the amount and the narrative by name',
    async (role) => {
      const { service: s, prisma, checks, log } = service()
      const who = member(role)
      await s.add(who, 'e-1', {
        name: 'Rent',
        reportLine: 'program-costs',
        amount: 1200,
        narrative: 'Classroom rent',
      })
      expect(prisma.budgetLine.create).toHaveBeenCalledWith({
        data: {
          engagementId: 'e-1',
          sortOrder: 1,
          name: 'Rent',
          reportLine: 'program-costs',
          amount: '1200.00',
          narrative: 'Classroom rent',
        },
      })
      await s.update(who, 'e-1', 'b-1', { amount: 1800, narrative: 'Mileage for site visits' })
      expect(prisma.budgetLine.update).toHaveBeenCalledWith({
        where: { id: 'b-1' },
        data: { amount: '1800.00', narrative: 'Mileage for site visits' },
      })
      // Nothing that differs: no write, no line.
      await s.update(who, 'e-1', 'b-1', { amount: 1500 })
      expect(prisma.budgetLine.update).toHaveBeenCalledTimes(1)
      await s.remove(who, 'e-1', 'b-1')
      expect(prisma.budgetLine.delete).toHaveBeenCalledWith({ where: { id: 'b-1' } })
      expect(log.entries).toEqual([
        {
          workspaceId: W,
          resource: 'engagement',
          subjectId: 'e-1',
          action: 'create',
          description: 'Added Rent to the approved budget of Coding Pathway',
          changes: [
            { field: 'Name', after: 'Rent' },
            { field: 'Rolls up to', after: 'Program Costs' },
            { field: 'Amount', after: '1200.00' },
            { field: 'Note' },
          ],
        },
        {
          workspaceId: W,
          resource: 'engagement',
          subjectId: 'e-1',
          action: 'update',
          description: 'Changed Travel on the approved budget of Coding Pathway',
          changes: [{ field: 'Amount', before: '1500.00', after: '1800.00' }],
        },
        {
          workspaceId: W,
          resource: 'engagement',
          subjectId: 'e-1',
          action: 'delete',
          description: 'Removed Travel from the approved budget of Coding Pathway',
          changes: [
            { field: 'Name', before: 'Travel' },
            { field: 'Rolls up to', before: 'Program Costs' },
            { field: 'Amount', before: '1500.00' },
            { field: 'Note' },
          ],
        },
      ])
      expectNoneOf(log.entries, ['Classroom rent', 'Mileage'])
      // Each change runs every month's checks again, closed and submitted ones included: they compare spending
      // with the budget.
      expect(checks.refresh).toHaveBeenCalledTimes(9)
      expect(checks.refresh).toHaveBeenCalledWith('r-3')
      expect(prisma.monthlyReport.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { engagementId: 'e-1' } })
      )
    }
  )

  it('puts every closed and submitted month back to draft in the change, one line each, drafts untouched', async () => {
    const { service: s, prisma, checks, log, months } = service([travel()], mixed())
    const who = member('bookkeeper')
    const answer = await s.update(who, 'e-1', 'b-1', { amount: 100 })
    expect(answer.backToDraft).toEqual([
      { id: 'r-1', period: '2026-08', was: 'submitted' },
      { id: 'r-2', period: '2026-09', was: 'closed' },
    ])
    // September is sent back, as the Send back button does it, with the reason on the month.
    expect(months[1]).toMatchObject({
      status: 'draft',
      authorizedByName: null,
      authorizedAt: null,
      closingNote: null,
      sentBackReason: expect.stringMatching(
        /^Sent back because the approved budget changed on [A-Z][a-z]+ \d{1,2}, \d{4}\.$/
      ),
      // The person who changed the budget, and when, for the month's page.
      sentBackAt: expect.any(Date),
      sentBackByEmail: who.email,
    })
    // August is reopened, as Reopen to correct does it: its submission, approval and signed copy kept for good.
    expect(months[0]).toMatchObject({
      status: 'draft',
      submittedAt: null,
      authorizedByName: null,
      authorizedAt: null,
      sentBackReason: null,
    })
    expect(prisma.reportReopening.create).toHaveBeenCalledTimes(1)
    expect(prisma.reportReopening.create).toHaveBeenCalledWith({
      data: {
        monthlyReportId: 'r-1',
        reopenedById: who.userId,
        reopenedByEmail: who.email,
        reason: expect.stringMatching(
          /^The approved budget changed on [A-Z][a-z]+ \d{1,2}, \d{4}\.$/
        ),
        submittedAt: new Date('2026-09-10'),
        approvedByName: 'Dana Director',
        approvedAt: new Date('2026-10-05'),
        signedDocumentId: 'd-signed',
      },
    })
    // October was a draft: untouched.
    expect(months[2]!.status).toBe('draft')
    expect(prisma.monthlyReport.update).toHaveBeenCalledTimes(2)
    expect(prisma.monthlyReport.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'r-3' } })
    )
    // One line per month in the person's name, then the budget's own; the approver and note by name alone.
    expect(log.entries.map((e) => e.description)).toEqual([
      'Reopened August 2026 of Coding Pathway because the approved budget changed',
      'Sent back the month-end closing of September 2026 of Coding Pathway because the approved budget changed',
      'Changed Travel on the approved budget of Coding Pathway',
    ])
    expect(log.entries[0]).toMatchObject({
      workspaceId: W,
      resource: 'report',
      subjectId: 'r-1',
      action: 'review',
      changes: expect.arrayContaining([
        { field: 'Status', before: 'submitted', after: 'draft' },
        { field: 'Submitted on', before: '2026-09-10', after: null },
        { field: 'Approved by' },
        { field: 'Why it was reopened' },
      ]),
    })
    expect(log.entries[1]).toMatchObject({
      resource: 'report',
      subjectId: 'r-2',
      changes: expect.arrayContaining([
        { field: 'Status', before: 'closed', after: 'draft' },
        { field: 'Note' },
        { field: 'Why it was sent back' },
      ]),
    })
    expect(log.actors).toEqual([who, who, who])
    expectNoneOf(log.entries, ['Dana Director', 'board meeting'])
    // The checks ran again after, on every month.
    expect(checks.refresh).toHaveBeenCalledTimes(3)
  })

  it('does it on adding and removing a line too, and not when nothing changed', async () => {
    const add = service([travel()], mixed())
    expect(
      (await add.service.add(member('owner'), 'e-1', { name: 'Rent', reportLine: 'program-costs' }))
        .backToDraft
    ).toHaveLength(2)
    const remove = service([travel()], mixed())
    expect((await remove.service.remove(member('owner'), 'e-1', 'b-1')).backToDraft).toHaveLength(2)
    const same = service([travel()], mixed())
    expect(
      (await same.service.update(member('owner'), 'e-1', 'b-1', { amount: 1500 })).backToDraft
    ).toEqual([])
    expect(same.months.map((m) => m.status)).toEqual(['submitted', 'closed', 'draft'])
    const none = service()
    expect(
      (await none.service.update(member('owner'), 'e-1', 'b-1', { amount: 100 })).backToDraft
    ).toEqual([])
    expect(none.prisma.monthlyReport.update).not.toHaveBeenCalled()
  })

  it('writes the months inside the budget change, so a failure there fails the change and logs nothing', async () => {
    const { service: s, prisma, checks, log } = service([travel()], mixed())
    // Every write goes through the change's transaction: the fake log throws on a write through the outer client.
    prisma.reportReopening.create.mockRejectedValueOnce(new Error('the database refused'))
    await expect(s.update(member('owner'), 'e-1', 'b-1', { amount: 100 })).rejects.toThrow(
      'the database refused'
    )
    // The change's write threw before its line: the real transaction keeps neither the budget nor the months.
    expect(log.change).toHaveBeenCalledTimes(1)
    expect(log.entries).toEqual([])
    expect(checks.refresh).not.toHaveBeenCalled()
  })

  it('renames a line, and keeps a line with spending on its form line and on the budget', async () => {
    const { service: s, prisma, log } = service([travel()], drafts(), 3)
    const who = member('owner')
    await s.update(who, 'e-1', 'b-1', { name: 'Staff travel' })
    expect(prisma.budgetLine.update).toHaveBeenCalledWith({
      where: { id: 'b-1' },
      data: { name: 'Staff travel' },
    })
    expect(log.entries.at(-1)?.changes).toEqual([
      { field: 'Name', before: 'Travel', after: 'Staff travel' },
    ])
    await expect(s.update(who, 'e-1', 'b-1', { reportLine: 'indirect' })).rejects.toThrow(
      /keeps the line it rolls up to/
    )
    await expect(s.remove(who, 'e-1', 'b-1')).rejects.toThrow(/has spending/)
    expect(prisma.budgetLine.delete).not.toHaveBeenCalled()
  })

  it('enters a blank amount as $0 until the contract says', async () => {
    const { service: s, prisma } = service()
    await s.add(member('owner'), 'e-1', { name: 'Rent', reportLine: 'program-costs', amount: null })
    expect(prisma.budgetLine.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ amount: '0.00', narrative: null }),
    })
  })
})
