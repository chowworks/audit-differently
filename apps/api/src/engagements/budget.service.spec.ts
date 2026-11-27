import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common'
import { member, scoped, stranger, W } from '../core/testing/callers'
import { fakeLog } from '../core/testing/log'
import { BudgetService } from './budget.service'

/**
 * The approved budget from an Excel file (GitHub issue #98): who may upload it, what Save does with each line, the
 * budget history, what each save logs, and that a change puts closed and submitted months back to draft.
 */
const engagement = () => ({
  id: 'e-1',
  workspaceId: W,
  name: 'Coding Pathway',
  workspace: { id: W },
})

/** A budget line as Prisma reads it, with how many expenses are spent against it. */
const line = (
  id: string,
  name: string,
  reportLine: string,
  amount: number,
  narrative: string | null,
  expenses = 0,
  payroll: string[] = []
) => ({
  id,
  workspaceId: W,
  engagementId: 'e-1',
  name,
  reportLine,
  amount,
  narrative,
  sortOrder: 0,
  payroll,
  _count: { expenses },
})
/** Travel (no spending), Staff Salaries (spending, holding staff pay) and Rent (no spending). */
const budget = () => [
  line('b-1', 'Travel', 'program-costs', 1500, 'Site visits'),
  line('b-2', 'Staff Salaries', 'staff-salaries', 42000, null, 3, ['staff-pay']),
  line('b-3', 'Rent', 'program-costs', 900, null),
]

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
const drafts = () => [month('r-1', '2026-08', 'draft'), month('r-2', '2026-09', 'draft')]
const approved = { authorizedByName: 'Dana Director', authorizedAt: new Date('2026-10-05') }
/** A submitted August, a closed September and a draft October. */
const mixed = () => [
  month('r-1', '2026-08', 'submitted', { ...approved, submittedAt: new Date('2026-09-10') }),
  month('r-2', '2026-09', 'closed', { ...approved }),
  month('r-3', '2026-10', 'draft'),
]

/** A budget file as the template lays it out, as CSV (read the same way as an .xlsx). */
const csv = (...rows: string[]) => ({
  buffer: Buffer.from(['Budget line,Monthly report line,Approved amount,Note', ...rows].join('\n')),
  originalname: 'budget.csv',
})
/** The current budget, unchanged. */
const same = () =>
  csv(
    'Travel,Program Costs,1500,Site visits',
    'Staff Salaries,Staff Salaries,42000,',
    'Rent,Program Costs,900,'
  )

function service(lines = budget(), months = drafts()) {
  const files: object[] = [
    {
      id: 'f-1',
      workspaceId: W,
      engagementId: 'e-1',
      fileName: 'budget-v1.xlsx',
      contentType: 'x',
      storageKey: `${W}/e-1/general/k1.xlsx`,
      uploadedAt: new Date('2026-11-01T10:00:00Z'),
      uploadedByEmail: 'pat@example.org',
      lineCount: 3,
    },
  ]
  const prisma = {
    engagement: scoped(engagement()),
    budgetLine: {
      findMany: jest.fn(async () => lines),
      create: jest.fn(async ({ data }: { data: object }) => ({ id: 'b-new', ...data })),
      update: jest.fn(async ({ data }: { data: object }) => data),
      delete: jest.fn(async () => ({})),
    },
    budgetFile: {
      ...scoped(...(files as { id: string }[])),
      create: jest.fn(async ({ data }: { data: object }) => ({ id: 'f-2', ...data })),
    },
    monthlyReport: {
      findMany: jest.fn(async (args: { where: { status?: { in: string[] } } }) =>
        months
          .filter((m) => !args.where.status || args.where.status.in.includes(m.status))
          .map((m) => ({ id: m.id }))
      ),
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
    document: { findMany: jest.fn(async () => []) },
  }
  const storage = {
    upload: jest.fn(async () => undefined),
    read: jest.fn(async () => Buffer.from('the file')),
    delete: jest.fn(async () => undefined),
  }
  const engagements = { detail: jest.fn().mockResolvedValue({ id: 'e-1' }) }
  const checks = { refresh: jest.fn().mockResolvedValue([]) }
  const log = fakeLog(prisma)
  const writes = [
    prisma.budgetLine.create,
    prisma.budgetLine.update,
    prisma.budgetLine.delete,
    prisma.budgetFile.create,
    prisma.monthlyReport.update,
    storage.upload,
  ]
  return {
    service: new BudgetService(
      prisma as never,
      engagements as never,
      checks as never,
      log as never,
      storage as never
    ),
    prisma,
    storage,
    checks,
    log,
    writes,
    months,
  }
}

describe('BudgetService', () => {
  it('lets owners and bookkeepers use the budget file, and refuses an auditor and another workspace', async () => {
    const { service: s, writes } = service()
    for (const run of [
      (who: never) => s.template(who, 'e-1'),
      (who: never) => s.readFile(who, 'e-1', same()),
      (who: never) => s.upload(who, 'e-1', same()),
      (who: never) => s.history(who, 'e-1'),
      (who: never) => s.historyFile(who, 'e-1', 'f-1'),
    ]) {
      // The budget history and the upload are working files: never the auditor's (owner's rule, 2026-11-27).
      await expect(run(member('auditor') as never)).rejects.toThrow(ForbiddenException)
      await expect(run(stranger() as never)).rejects.toThrow(NotFoundException)
    }
    for (const w of writes) expect(w).not.toHaveBeenCalled()
    await expect(s.template(member('bookkeeper'), 'e-1')).resolves.toMatchObject({
      name: 'Coding Pathway - budget.xlsx',
    })
  })

  it('reads a file against the budget: what Save does with each line, and what it removes', async () => {
    const { service: s, writes } = service()
    const read = await s.readFile(
      member('owner'),
      'e-1',
      csv(
        'Travel,Program Costs,2000,Site visits',
        'staff salaries,Staff Salaries,42000,',
        'Supplies,Program Costs,0,Laptops'
      )
    )
    expect(read.rows.map((r) => [r.name, r.action])).toEqual([
      ['Travel', 'change'],
      // The same name in another case is the same line: Save changes its name in place.
      ['staff salaries', 'change'],
      ['Supplies', 'new'],
    ])
    expect(read.removed).toEqual(['Rent'])
    expect(read.problems).toEqual([])
    for (const w of writes) expect(w).not.toHaveBeenCalled()
  })

  it('refuses to leave out or move a line with spending, and counts a refused row as in the file', async () => {
    const { service: s } = service()
    const left = await s.readFile(member('owner'), 'e-1', csv('Travel,Program Costs,1500,'))
    expect(left.problems).toEqual([
      { row: null, reason: 'Staff Salaries has spending, so it must stay in the file' },
    ])
    const moved = await s.readFile(
      member('owner'),
      'e-1',
      csv('Travel,Program Costs,1500,', 'Staff Salaries,WEX,42000,', 'Rent,,900,')
    )
    expect(moved.problems).toEqual([
      {
        row: 3,
        reason: 'Staff Salaries has spending, so it keeps the monthly report line Staff Salaries',
      },
      { row: 4, reason: 'Monthly report line is blank' },
    ])
    // Rent's row is refused, but the file names it: it is not "left out".
    expect(moved.removed).toEqual([])
  })

  it('replaces the budget: changes a line in place, adds and removes, keeps the file, and logs each line', async () => {
    const { service: s, prisma, storage, log } = service()
    const saved = await s.upload(
      member('bookkeeper'),
      'e-1',
      csv(
        'Travel,Program Costs,2000,Site visits',
        'Staff Salaries,Staff Salaries,42000,',
        'Supplies,Program Costs,350,'
      )
    )
    expect(saved).toMatchObject({ added: 1, changed: 1, removed: 1, backToDraft: [] })
    // Changed in place, never removed and added again (CLAUDE.md, "A budget line's name is its key").
    expect(prisma.budgetLine.update).toHaveBeenCalledWith({
      where: { id: 'b-1' },
      data: {
        name: 'Travel',
        reportLine: 'program-costs',
        amount: '2000.00',
        narrative: 'Site visits',
      },
    })
    expect(prisma.budgetLine.delete).toHaveBeenCalledWith({ where: { id: 'b-3' } })
    // A new line takes no payroll: the upload leaves payroll as it is (#132).
    expect(prisma.budgetLine.create.mock.calls[0]![0].data).toEqual({
      engagementId: 'e-1',
      sortOrder: 3,
      name: 'Supplies',
      reportLine: 'program-costs',
      amount: '350.00',
      narrative: null,
    })
    // The file as uploaded, under its engagement, kept as the budget history.
    const key = (storage.upload.mock.calls[0] as unknown[])[0] as string
    expect(key).toMatch(new RegExp(`^${W}/e-1/general/[0-9a-f-]{36}\\.csv$`))
    expect(prisma.budgetFile.create.mock.calls[0]![0].data).toMatchObject({
      engagementId: 'e-1',
      fileName: 'budget.csv',
      storageKey: key,
      lineCount: 3,
      uploadedById: expect.any(String),
    })
    expect(log.entries.map((e) => e.description)).toEqual([
      'Removed Rent from the approved budget of Coding Pathway',
      'Changed Travel on the approved budget of Coding Pathway',
      'Added Supplies to the approved budget of Coding Pathway',
      'Uploaded a budget file to Coding Pathway, replacing its approved budget: 1 added, 1 changed, 1 removed',
    ])
  })

  it('puts every closed and submitted month back to draft on a change, and writes nothing for a file that changes nothing', async () => {
    const changed = service(budget(), mixed())
    const saved = await changed.service.upload(
      member('owner'),
      'e-1',
      csv(
        'Travel,Program Costs,1500,Site visits',
        'Staff Salaries,Staff Salaries,40000,',
        'Rent,Program Costs,900,'
      )
    )
    expect(saved.backToDraft.map((m) => m.period)).toEqual(['2026-08', '2026-09'])
    expect(changed.months.map((m) => m.status)).toEqual(['draft', 'draft', 'draft'])

    const unchanged = service(budget(), mixed())
    expect(await unchanged.service.upload(member('owner'), 'e-1', same())).toMatchObject({
      added: 0,
      changed: 0,
      removed: 0,
      backToDraft: [],
    })
    for (const w of unchanged.writes) expect(w).not.toHaveBeenCalled()
    expect(unchanged.months.map((m) => m.status)).toEqual(['submitted', 'closed', 'draft'])
    expect(unchanged.log.entries).toEqual([])
  })

  it('refuses a file with any problem whole, with every problem, and stores and writes nothing', async () => {
    const { service: s, writes, log } = service()
    const refused = await s
      .upload(member('owner'), 'e-1', csv('Travel,Program Costs,,', 'Supplies,Rent,abc,'))
      .catch((e: unknown) => e)
    expect(refused).toBeInstanceOf(BadRequestException)
    expect((refused as BadRequestException).getResponse()).toMatchObject({
      message: 'The file has 3 problems: correct the file and upload it again',
      problems: [
        { row: 2, reason: 'Approved amount is blank' },
        {
          row: 3,
          reason: expect.stringMatching(
            /^"abc" is not an amount\. Choose one of the monthly report lines/
          ),
        },
        { row: null, reason: 'Staff Salaries has spending, so it must stay in the file' },
      ],
    })
    for (const w of writes) expect(w).not.toHaveBeenCalled()
    expect(log.entries).toEqual([])
  })

  it('removes the stored file when the save fails, and logs nothing', async () => {
    const { service: s, prisma, storage, log, checks } = service()
    prisma.budgetFile.create.mockRejectedValueOnce(new Error('the database refused'))
    await expect(
      s.upload(
        member('owner'),
        'e-1',
        csv('Travel,Program Costs,1500,', 'Staff Salaries,Staff Salaries,1,')
      )
    ).rejects.toThrow('the database refused')
    expect(storage.delete).toHaveBeenCalledWith((storage.upload.mock.calls[0] as unknown[])[0])
    expect(log.entries).toEqual([])
    expect(checks.refresh).not.toHaveBeenCalled()
  })

  it('lists the budget history newest first, and logs each download of an earlier file', async () => {
    const { service: s, storage, log } = service()
    expect(await s.history(member('owner'), 'e-1')).toEqual([
      {
        id: 'f-1',
        fileName: 'budget-v1.xlsx',
        uploadedAt: '2026-11-01T10:00:00.000Z',
        uploadedByEmail: 'pat@example.org',
        lineCount: 3,
        current: true,
      },
    ])
    const file = await s.historyFile(member('bookkeeper'), 'e-1', 'f-1')
    expect(file).toMatchObject({ name: 'budget-v1.xlsx', bytes: Buffer.from('the file') })
    expect(storage.read).toHaveBeenCalledWith(`${W}/e-1/general/k1.xlsx`)
    expect(log.entries.map((e) => [e.action, e.description])).toEqual([
      ['read', 'Opened the budget file budget-v1.xlsx of Coding Pathway, uploaded 2026-11-01'],
    ])
    await expect(s.historyFile(member('owner'), 'e-1', 'f-other')).rejects.toThrow(
      NotFoundException
    )
  })
})
