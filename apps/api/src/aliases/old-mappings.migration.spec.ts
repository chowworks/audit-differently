import type { PGlite } from '@electric-sql/pglite'
import { applyMigration, dbTestsEnabled, insert, migratedDb } from '../core/testing/tenant-db'

// The QuickBooks names list filled once from the two old mappings (#132, migration 20261127000300), on real Postgres.
const suite = dbTestsEnabled ? describe : describe.skip
const MIGRATION = '20261127000300_line_aliases_from_old_mappings'

suite('the QuickBooks names list from the old mappings', () => {
  let db: PGlite
  afterAll(() => db.close())

  beforeAll(async () => {
    db = await migratedDb(MIGRATION)
    await insert(db, 'Workspace', { id: 'W1', name: 'W1' })
    for (const e of ['E1', 'E2'])
      await insert(db, 'Engagement', { id: e, workspaceId: 'W1', name: e, number: e })
    await insert(db, 'BudgetLine', {
      id: 'E1-pc',
      engagementId: 'E1',
      name: 'Program Costs',
      amount: 9000,
    })
    await insert(db, 'BudgetLine', {
      id: 'E1-ss',
      engagementId: 'E1',
      name: 'Staff Salaries',
      amount: 1800,
    })
    await insert(db, 'BudgetLine', {
      id: 'E2-pc',
      engagementId: 'E2',
      name: 'Program Costs',
      amount: 500,
    })
    await insert(db, 'BudgetLine', { id: 'E2-tr', engagementId: 'E2', name: 'Travel', amount: 100 })
    // Two saved import mappings, the older first; they disagree on Travel.
    // The oldest names a line that is gone: passed over, so the next one's answer counts.
    await insert(db, 'ImportMapping', {
      id: 'IM-0',
      workspaceId: 'W1',
      name: 'Old export',
      createdAt: '2026-09-01T00:00:00Z',
      categories: JSON.stringify({ Travel: 'Mileage' }),
    })
    await insert(db, 'ImportMapping', {
      id: 'IM-1',
      workspaceId: 'W1',
      name: 'Ledger export',
      createdById: 'u-1',
      createdAt: '2026-10-01T00:00:00Z',
      categories: JSON.stringify({
        'Program supplies': 'Program Costs',
        Travel: 'Travel',
        Entertainment: 'skip',
        Equipment: 'Equipment',
      }),
    })
    await insert(db, 'ImportMapping', {
      id: 'IM-2',
      workspaceId: 'W1',
      name: 'Bank download',
      createdAt: '2026-10-05T00:00:00Z',
      categories: JSON.stringify({ travel: 'Program Costs' }),
    })
    // Each engagement's account mapping: E1's by its box, E2's with an owner's picks.
    const read = (accounts: Record<string, string | null>) =>
      JSON.stringify({
        title: 't',
        accounts,
        names: { '60901': 'Rent Expense', '60202': 'Insurance', '63102': 'Salaries' },
        categories: [
          // Named loosely, as Month End Close matched it: "Program" is the line "Program Costs".
          { category: 'PROGRAM COSTS', line: 'Program', amount: null },
          { category: 'STAFF', line: null, amount: 1800 },
        ],
        budget: null,
        start: null,
        end: null,
      })
    await insert(db, 'AccountMapping', {
      id: 'AM-1',
      workspaceId: 'W1',
      engagementId: 'E1',
      sha256: 'a'.repeat(64),
      changedById: 'u-1',
      changedAt: '2026-11-01T00:00:00Z',
      read: read({ '60901': 'PROGRAM COSTS', '60202': null, '63102': 'STAFF' }),
    })
    await insert(db, 'AccountMapping', {
      id: 'AM-2',
      workspaceId: 'W1',
      engagementId: 'E2',
      sha256: 'b'.repeat(64),
      changedById: 'u-2',
      changedAt: '2026-11-02T00:00:00Z',
      read: read({ '60901': 'PROGRAM COSTS', '60202': 'PROGRAM COSTS', '63102': 'STAFF' }),
      chosen: JSON.stringify({ 'PROGRAM COSTS': 'E2-tr', STAFF: 'skip' }),
    })
    await applyMigration(db, MIGRATION)
  })

  const list = async () =>
    (
      await db.query<{ e: string | null; name: string; goes: string }>(
        `SELECT "engagementId" AS e, "name",
           CASE WHEN "unallowable" THEN 'Unallowable' ELSE "budgetLineName" END AS goes
         FROM "LineAlias" ORDER BY "name", "engagementId" NULLS FIRST`
      )
    ).rows.map((r) => [r.name, r.e, r.goes])

  it("keeps the older import mapping's answer, an engagement's different one as its own, and leaves out a line no one has", async () => {
    expect(await list()).toEqual([
      // The first engagement to send it to a line gives the workspace's entry; one that left it blank keeps its own.
      ['60202 Insurance', null, 'Travel'],
      ['60202 Insurance', 'E1', 'Unallowable'],
      ['60901 Rent Expense', null, 'Program Costs'],
      ['60901 Rent Expense', 'E2', 'Travel'],
      ['63102 Salaries', null, 'Staff Salaries'],
      ['63102 Salaries', 'E2', 'Unallowable'],
      ['Entertainment', null, 'Unallowable'],
      ['Program supplies', null, 'Program Costs'],
      ['Travel', null, 'Travel'],
    ])
  })

  it('adds nothing when it runs again', async () => {
    const before = await list()
    await applyMigration(db, MIGRATION)
    expect(await list()).toEqual(before)
  })
})
