import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_BUDGET_ITEMS, type ImportRequest, type Role } from '@ad/types'
import { member, scoped, stranger, W } from '../core/testing/callers'
import { fakeLog } from '../core/testing/log'
import { ImportsService } from './imports.service'
import { fingerprintOf, fingerprintsOf, transactionsOf } from './mapping'
import { tableOf } from './table'

/** The SDK's client, with its messages.create replaced: no request ever leaves a test. */
const mockCreate = jest.fn()
jest.mock('@anthropic-ai/sdk', () => {
  const actual = jest.requireActual('@anthropic-ai/sdk')
  class Mocked extends actual.default {
    constructor(options: object) {
      super(options)
      ;(this as unknown as { messages: unknown }).messages = {
        create: (...a: unknown[]) => mockCreate(...a),
      }
    }
  }
  return { ...actual, __esModule: true, default: Mocked }
})

/**
 * Importing a transactions file into an engagement: who may, where each row goes or why it stays out, what is
 * written and logged, and that a row imported once is never made twice.
 */
const SAMPLE = {
  originalname: 'sample-qb-export.csv',
  buffer: readFileSync(join(__dirname, '../../test/fixtures/sample-qb-export.csv')),
}

type Month = { id: string; period: string; status: string }
const engagement = (months: Month[]) => ({
  id: 'e-1',
  workspaceId: W,
  name: 'Coding Pathway',
  periodStart: new Date('2026-07-01T00:00:00Z'),
  periodEnd: new Date('2027-06-30T00:00:00Z'),
  reportDueDay: 12,
  workspace: { id: W, budgetItems: DEFAULT_BUDGET_ITEMS },
  budgetLines: ['supplies', 'contractual', 'participant-training', 'travel'].map((category) => ({
    category,
  })),
  monthlyReports: months,
})
const AUG_SUBMITTED = { id: 'r-aug', period: '2026-08', status: 'submitted' }
const SEP_DRAFT = { id: 'r-sep', period: '2026-09', status: 'draft' }

const COLUMNS = {
  date: 'Date',
  vendor: 'Name',
  memo: 'Memo/Description',
  amount: 'Amount',
  reference: 'Num',
  account: 'Account',
  category: 'Split',
  flipSign: true,
}
const CATEGORIES = {
  'Office Supplies': 'supplies',
  'Contract Services': 'contractual',
  'Participant Training': 'participant-training',
  Travel: 'travel',
  Meals: 'skip',
}
const request = (extra: Partial<ImportRequest> = {}): ImportRequest => ({
  columns: COLUMNS,
  categories: CATEGORIES,
  ...extra,
})

function service(
  months: Month[] = [AUG_SUBMITTED, SEP_DRAFT],
  existing: { itemNumber: string; reportLine: string; importFingerprint: string | null }[] = [],
  saved: object[] = []
) {
  const prisma = {
    engagement: scoped(engagement(months)),
    importMapping: {
      findMany: jest.fn().mockResolvedValue(saved),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(async ({ data }: { data: object }) => ({ id: 'm-1', ...data })),
      update: jest.fn(),
    },
    expense: {
      findMany: jest.fn().mockResolvedValue(existing),
      createMany: jest.fn(async ({ data }: { data: unknown[] }) => ({ count: data.length })),
    },
    monthlyReport: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(async ({ data }: { data: { period: string } }) => ({
        id: `r-new-${data.period}`,
        ...data,
      })),
    },
  }
  const checks = { refresh: jest.fn().mockResolvedValue([]) }
  const engagements = { detail: jest.fn().mockResolvedValue({ id: 'e-1' }) }
  const reports = { fresh: jest.fn().mockResolvedValue({ id: 'r-sep' }) }
  const log = fakeLog(prisma)
  const s = new ImportsService(
    prisma as never,
    checks as never,
    log as never,
    engagements as never,
    reports as never
  )
  const writes = [
    prisma.expense.createMany,
    prisma.monthlyReport.create,
    prisma.importMapping.create,
    prisma.importMapping.update,
  ]
  return { s, prisma, checks, log, reports, writes }
}

beforeAll(() => {
  delete process.env.ANTHROPIC_API_KEY
})

describe('ImportsService', () => {
  it('answers a member of another workspace with 404 and reads nothing of the file', async () => {
    const { s, writes, log } = service()
    const who = stranger()
    await expect(s.read(who, 'e-1', SAMPLE)).rejects.toThrow(NotFoundException)
    await expect(s.preview(who, 'e-1', SAMPLE, request())).rejects.toThrow(NotFoundException)
    await expect(s.import(who, 'e-1', SAMPLE, request())).rejects.toThrow(NotFoundException)
    for (const w of writes) expect(w).not.toHaveBeenCalled()
    expect(log.entries).toEqual([])
  })

  it('lets an auditor import nothing, nor read a file in', async () => {
    const { s, writes, log } = service()
    const who = member('auditor')
    await expect(s.read(who, 'e-1', SAMPLE)).rejects.toThrow(ForbiddenException)
    await expect(s.preview(who, 'e-1', SAMPLE, request())).rejects.toThrow(ForbiddenException)
    await expect(s.import(who, 'e-1', SAMPLE, request())).rejects.toThrow(ForbiddenException)
    for (const w of writes) expect(w).not.toHaveBeenCalled()
    expect(log.entries).toEqual([])
  })

  it('reads the file: its columns, a few rows, the guess, and the budget lines this engagement uses', async () => {
    const { s, log } = service()
    const file = await s.read(member('bookkeeper'), 'e-1', SAMPLE)
    expect(file.headers).toContain('Split')
    expect(file.rowCount).toBe(19)
    expect(file.sample).toHaveLength(5)
    expect(file.guessedBy).toBe('headers')
    expect(file.guess).toEqual(COLUMNS)
    expect(file.mappingId).toBeNull()
    expect(file.budgetOptions.map((i) => i.key)).toEqual([
      'travel',
      'supplies',
      'contractual',
      'participant-training',
    ])
    // Reading a file in is no record read and no change: nothing is logged.
    expect(log.entries).toEqual([])
  })

  describe('with ANTHROPIC_API_KEY set', () => {
    beforeEach(() => {
      process.env.ANTHROPIC_API_KEY = 'test'
      mockCreate.mockReset()
      mockCreate.mockResolvedValue({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: '{"date":"Date","vendor":"Name","amount":"Amount"}' }],
      })
    })
    afterEach(() => {
      delete process.env.ANTHROPIC_API_KEY
    })
    const csv = (text: string) => ({ originalname: 'x.csv', buffer: Buffer.from(text) })

    it('never asks the AI when the file is read: the guess is by the names, and the button is offered', async () => {
      const { s } = service()
      const file = await s.read(member('owner'), 'e-1', SAMPLE)
      expect(file.guessedBy).toBe('headers')
      expect(file.aiAvailable).toBe(true)
      expect(mockCreate).not.toHaveBeenCalled()
    })

    it('asks only when the person presses the button, with the column names and no row below them', async () => {
      const { s, log } = service()
      const out = await s.suggest(member('bookkeeper'), 'e-1', SAMPLE)
      expect(out.columns).toBeTruthy()
      expect(mockCreate).toHaveBeenCalledTimes(1)
      const sent = JSON.stringify(mockCreate.mock.calls)
      expect(sent).toContain('Memo/Description')
      expect(sent).not.toContain('Bright Path Office Supply')
      expect(log.entries).toEqual([])
    })

    it('lets an auditor or another workspace ask nothing', async () => {
      const { s } = service()
      await expect(s.suggest(member('auditor'), 'e-1', SAMPLE)).rejects.toThrow(ForbiddenException)
      await expect(s.suggest(stranger(), 'e-1', SAMPLE)).rejects.toThrow(NotFoundException)
      expect(mockCreate).not.toHaveBeenCalled()
    })

    it('never asks when no header row was found: the first row may be a transaction', async () => {
      const { s } = service()
      const file = csv(
        '09/02/2026,Bright Path Office Supply,212.18\n09/03/2026,Lakeside Transit Co.,320.00\n'
      )
      expect((await s.read(member('owner'), 'e-1', file)).aiAvailable).toBe(false)
      await expect(s.suggest(member('owner'), 'e-1', file)).rejects.toThrow(BadRequestException)
      expect(mockCreate).not.toHaveBeenCalled()
    })

    it('never asks when a cell of the header row looks like a value', async () => {
      const { s } = service()
      const file = csv('Date,Name,Amount,212.18\n09/02/2026,Bright Path Office Supply,212.18,\n')
      await expect(s.suggest(member('owner'), 'e-1', file)).rejects.toThrow(BadRequestException)
      expect(mockCreate).not.toHaveBeenCalled()
    })

    it("says in the import's line when the person had AI suggest the columns", async () => {
      const { s, log } = service()
      await s.import(member('owner'), 'e-1', SAMPLE, request({ aiSuggested: true }))
      expect(log.entries[0]!.description).toBe(
        'Imported 7 transactions into Coding Pathway from a CSV file: 1 month, columns suggested with AI'
      )
      expect(mockCreate).not.toHaveBeenCalled()
    })
  })

  it('offers no AI without the key, and its line never claims AI', async () => {
    const { s, log } = service()
    expect((await s.read(member('owner'), 'e-1', SAMPLE)).aiAvailable).toBe(false)
    expect(await s.suggest(member('owner'), 'e-1', SAMPLE)).toEqual({ columns: null })
    await s.import(member('owner'), 'e-1', SAMPLE, request({ aiSuggested: true }))
    expect(log.entries[0]!.description).toBe(
      'Imported 7 transactions into Coding Pathway from a CSV file: 1 month'
    )
  })

  it('offers a saved mapping for the same columns first', async () => {
    const t = tableOf([
      [
        '',
        'Date',
        'Transaction Type',
        'Num',
        'Name',
        'Memo/Description',
        'Account',
        'Split',
        'Amount',
      ],
      ['', '1', '', '', '', '', '', '', ''],
    ])
    const saved = {
      id: 'm-qb',
      name: 'QuickBooks mapping',
      headers: t.headers.map((h) => h.toUpperCase()),
      columns: { ...COLUMNS, memo: undefined },
      categories: CATEGORIES,
    }
    const { s } = service(undefined, [], [saved])
    const file = await s.read(member('owner'), 'e-1', SAMPLE)
    expect(file.mappingId).toBe('m-qb')
    expect(file.guessedBy).toBe('saved')
    expect(file.mappings[0]).toMatchObject({ name: 'QuickBooks mapping', matches: true })
  })

  it('places each row in its month, and says why every other row stays out', async () => {
    const { s, writes } = service()
    const p = await s.preview(member('bookkeeper'), 'e-1', SAMPLE, request())
    for (const w of writes) expect(w).not.toHaveBeenCalled()
    expect(p.months).toEqual([{ period: '2026-09', isNew: false, rows: 7, total: 3713.33 }])
    expect(p.rows.map((r) => [r.itemNumber, r.reportLine, r.amount])).toEqual([
      ['2105', 'program-costs', 212.18],
      ['2106', 'program-costs', 1250],
      ['2107', 'program-costs', 1480],
      ['2108', 'program-costs', 320],
      ['IMP-1', 'program-costs', 86.25],
      ['2109', 'program-costs', 300],
      ['2111', 'program-costs', 64.9],
    ])
    const why = Object.fromEntries(p.notImported.map((r) => [r.line, r.reason]))
    expect(why).toEqual({
      6: 'A heading or total line, not a transaction',
      7: 'August 2026 is submitted; only a draft month takes new lines',
      8: 'August 2026 is submitted; only a draft month takes new lines',
      9: 'August 2026 is submitted; only a draft month takes new lines',
      10: 'August 2026 is submitted; only a draft month takes new lines',
      11: 'August 2026 is submitted; only a draft month takes new lines',
      12: 'A negative amount (a refund or credit): enter it by hand if it belongs',
      19: 'Skipped: its category is set to skip',
      21: 'Choose a budget line for "Rent"',
      22: 'A heading or total line, not a transaction',
      23: 'A heading or total line, not a transaction',
      25: 'A heading or total line, not a transaction',
    })
    expect(p.categories.find((c) => c.value === 'Office Supplies')).toEqual({
      value: 'Office Supplies',
      match: null,
      rows: 4,
      total: 415.28,
    })
  })

  it('refuses rows outside the contract period and in a month whose closing is approved', async () => {
    const { s } = service([{ id: 'r-aug', period: '2026-08', status: 'closed' }, SEP_DRAFT])
    const p = await s.preview(member('owner'), 'e-1', SAMPLE, request())
    expect(p.notImported.find((r) => r.line === 7)?.reason).toBe(
      'The month-end closing of August 2026 is approved; send it back to add lines'
    )
    const one = await s.preview(
      member('owner'),
      'e-1',
      {
        originalname: 'x.csv',
        buffer: Buffer.from(
          'Date,Name,Amount,Split\n06/30/2026,Bright Path,10.00,Office Supplies\n'
        ),
      },
      {
        columns: { date: 'Date', vendor: 'Name', amount: 'Amount', category: 'Split' },
        categories: CATEGORIES,
      }
    )
    expect(one.notImported[0].reason).toBe('Outside the contract period (2026-07-01 to 2027-06-30)')
  })

  it('flags a row imported before, and keeps identical purchases and split lines as rows of their own', async () => {
    const csv =
      'Date,Num,Name,Memo,Amount,Split\n' +
      '09/02/2026,2105,Bright Path Office Supply,Lab supplies,212.18,Office Supplies\n' +
      '09/03/2026,,Lakeside Transit Co.,Bus passes,320.00,Participant Training\n' +
      '09/03/2026,,Lakeside Transit Co.,Bus passes,320.00,Participant Training\n' +
      '09/03/2026,,Lakeside Transit Co.,Bus passes,320.00,Travel\n'
    const file = { originalname: 'x.csv', buffer: Buffer.from(csv) }
    const columns = {
      date: 'Date',
      vendor: 'Name',
      memo: 'Memo',
      amount: 'Amount',
      reference: 'Num',
      category: 'Split',
    }
    const rows = transactionsOf(
      tableOf(
        csv
          .trim()
          .split('\n')
          .map((l) => l.split(','))
      ),
      columns
    )
    const { s } = service(undefined, [
      {
        itemNumber: '2105',
        reportLine: 'program-costs',
        importFingerprint: fingerprintOf(rows[0]!),
      },
      { itemNumber: 'IMP-1', reportLine: 'wex', importFingerprint: null },
    ])
    const p = await s.preview(member('owner'), 'e-1', file, { columns, categories: CATEGORIES })
    expect(p.notImported.map((r) => [r.line, r.reason])).toEqual([[2, 'Already imported']])
    // A generated item number never takes one the engagement has.
    expect(p.rows.map((r) => [r.line, r.itemNumber])).toEqual([
      [3, 'IMP-2'],
      [4, 'IMP-3'],
      [5, 'IMP-4'],
    ])

    // The same file again: each identical row is refused as the one it was, none twice.
    const again = service(
      undefined,
      fingerprintsOf(rows).map((importFingerprint, i) => ({
        itemNumber: `IMP-${i + 1}`,
        reportLine: 'program-costs',
        importFingerprint,
      }))
    )
    const q = await again.s.preview(member('owner'), 'e-1', file, {
      columns,
      categories: CATEGORIES,
    })
    expect(q.rows).toEqual([])
    expect(q.notImported.map((r) => r.reason)).toEqual(Array(4).fill('Already imported'))
  })

  it('refuses an amount written another way (1.234,50) instead of reading it as 1.23', async () => {
    const csv =
      'Date,Name,Amount,Split\n' +
      '09/02/2026,Bright Path Office Supply,"1.234,50",Office Supplies\n' +
      '09/03/2026,Lakeside Transit Co.,12.345,Travel\n' +
      '09/04/2026,Lakeside Transit Co.,"1,234.50",Travel\n'
    const file = { originalname: 'x.csv', buffer: Buffer.from(csv) }
    const columns = { date: 'Date', vendor: 'Name', amount: 'Amount', category: 'Split' }
    const { s } = service()
    const p = await s.preview(member('owner'), 'e-1', file, { columns, categories: CATEGORIES })
    expect(p.notImported.map((r) => [r.line, r.reason])).toEqual([
      [2, expect.stringMatching(/cannot be read: write it like 1,234.50/)],
      [3, expect.stringMatching(/cannot be read/)],
    ])
    expect(p.rows.map((r) => r.amount)).toEqual([1234.5])
  })

  it('gives a reference another line already uses a suffix, so the item number stays unique on its line', async () => {
    const csv =
      'Date,Num,Name,Amount,Split\n09/02/2026,2105,Bright Path,10.00,Office Supplies\n09/03/2026,2105,Bright Path,11.00,Office Supplies\n'
    const { s } = service(undefined, [
      { itemNumber: '2105', reportLine: 'program-costs', importFingerprint: null },
    ])
    const p = await s.preview(
      member('owner'),
      'e-1',
      { originalname: 'x.csv', buffer: Buffer.from(csv) },
      {
        columns: {
          date: 'Date',
          vendor: 'Name',
          amount: 'Amount',
          reference: 'Num',
          category: 'Split',
        },
        categories: CATEGORIES,
      }
    )
    expect(p.rows.map((r) => r.itemNumber)).toEqual(['2105-2', '2105-3'])
  })

  it('refuses a mapping to a budget line the engagement does not use', async () => {
    const { s } = service()
    await expect(
      s.preview(member('owner'), 'e-1', SAMPLE, request({ categories: { Rent: 'personnel' } }))
    ).rejects.toThrow(BadRequestException)
  })

  it.each(['owner', 'bookkeeper'] as Role[])(
    'lets the %s import: months started as drafts, one line each row, one log line, the checks run again',
    async (role) => {
      const { s, prisma, checks, log } = service([SEP_DRAFT])
      const result = await s.import(member(role), 'e-1', SAMPLE, request())
      expect(prisma.monthlyReport.create).toHaveBeenCalledTimes(1)
      expect(prisma.monthlyReport.create).toHaveBeenCalledWith({
        data: {
          engagementId: 'e-1',
          period: '2026-08',
          dueDate: new Date('2026-09-12T23:59:59Z'),
        },
      })
      const rows = prisma.expense.createMany.mock.calls[0][0].data as Record<string, unknown>[]
      expect(rows).toHaveLength(11)
      expect(rows[0]).toEqual({
        engagementId: 'e-1',
        monthlyReportId: 'r-new-2026-08',
        itemNumber: '2101',
        date: new Date('2026-08-04T00:00:00Z'),
        vendor: 'Bright Path Office Supply',
        memo: 'Printer paper, toner',
        account: 'Checking',
        totalCost: '186.40',
        allocatedAmount: '186.40',
        allocationType: 'direct',
        reportLine: 'program-costs',
        importFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        createdById: `u-${role}-${W}`,
      })
      expect(new Set(rows.map((r) => r.monthlyReportId))).toEqual(
        new Set(['r-new-2026-08', 'r-sep'])
      )
      expect(checks.refresh.mock.calls.map((c) => c[0])).toEqual(['r-new-2026-08', 'r-sep'])
      expect(log.entries).toHaveLength(1)
      const line = log.entries[0]
      expect(line).toMatchObject({
        workspaceId: W,
        resource: 'expense',
        action: 'create',
        description: 'Imported 11 transactions into Coding Pathway from a CSV file: 2 months',
      })
      expect(line.changes?.slice(0, 5)).toEqual([
        { field: 'Transactions', after: '11' },
        { field: 'Total', after: '6069.73' },
        { field: 'August 2026', after: '4 transactions, $2,356.40 (month started)' },
        { field: 'September 2026', after: '7 transactions, $3,713.33' },
        { field: 'Not imported', after: '8' },
      ])
      // Counts and totals only: no payee or memo of any row reaches the log.
      expect(JSON.stringify(line)).not.toContain('Bright Path')
      expect(JSON.stringify(line)).not.toContain('Printer paper')
      expect(result).toMatchObject({ imported: 11, total: 6069.73, notImported: 8, report: null })
    }
  )

  it('answers with the month page it was started from', async () => {
    const { s, reports } = service()
    const result = await s.import(member('owner'), 'e-1', SAMPLE, request({ reportId: 'r-sep' }))
    expect(reports.fresh).toHaveBeenCalledWith(expect.anything(), 'r-sep')
    expect(result.report).toEqual({ id: 'r-sep' })
    await expect(
      s.import(member('owner'), 'e-1', SAMPLE, request({ reportId: 'r-other' }))
    ).rejects.toThrow(NotFoundException)
  })

  it('imports nothing and logs nothing when no row is ready', async () => {
    const { s, writes, log } = service([AUG_SUBMITTED, { ...SEP_DRAFT, status: 'submitted' }])
    await expect(
      s.import(member('owner'), 'e-1', SAMPLE, request({ saveAs: 'QuickBooks mapping' }))
    ).rejects.toThrow(/Nothing to import/)
    for (const w of writes) expect(w).not.toHaveBeenCalled()
    expect(log.entries).toEqual([])
  })

  it('saves the mapping by name on the workspace, with its own line', async () => {
    const { s, prisma, log } = service()
    await s.import(
      member('bookkeeper'),
      'e-1',
      SAMPLE,
      request({ saveAs: '  QuickBooks mapping ' })
    )
    expect(prisma.importMapping.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: W,
        name: 'QuickBooks mapping',
        columns: COLUMNS,
        categories: CATEGORIES,
        headers: expect.arrayContaining(['Date', 'Split']),
      }),
    })
    expect(log.entries[0]).toMatchObject({
      resource: 'workspace',
      action: 'create',
      description: 'Saved the import mapping QuickBooks mapping',
    })
    expect(log.entries[0].changes?.[1]).toEqual({
      field: 'Categories',
      after: '5 categories mapped',
    })
    expect(log.entries).toHaveLength(2)
    await expect(
      s.import(member('bookkeeper'), 'e-1', SAMPLE, request({ saveAs: ' ' }))
    ).rejects.toThrow(/Name the mapping/)
  })
})
