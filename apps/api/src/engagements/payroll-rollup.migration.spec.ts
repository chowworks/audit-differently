import type { PGlite } from '@electric-sql/pglite'
import { applyMigration, dbTestsEnabled, insert, migratedDb } from '../core/testing/tenant-db'

// The payroll budget rollup filled once from each line's payroll ticks (#138, migration 20261128000100).
const suite = dbTestsEnabled ? describe : describe.skip
const MIGRATION = '20261128000100_payroll_rollup'

suite('the payroll rollup from the payroll ticks', () => {
  let db: PGlite
  afterAll(() => db.close())

  const line = (id: string, engagementId: string, name: string, payroll: string[] = []) =>
    insert(db, 'BudgetLine', {
      id,
      engagementId,
      name,
      amount: 100,
      payroll: `{${payroll.join(',')}}`,
    })

  beforeAll(async () => {
    db = await migratedDb(MIGRATION)
    await insert(db, 'Workspace', { id: 'W1', name: 'W1' })
    for (const e of ['E1', 'E2', 'E3', 'E4'])
      await insert(db, 'Engagement', { id: e, workspaceId: 'W1', name: e, number: e })
    // Staff pay on Staff Salaries at E1 and E2 (the most): the workspace's. E3 holds it on Personnel.
    await line('E1-ss', 'E1', 'Staff Salaries', ['staff-pay', 'staff-taxes'])
    await line('E2-ss', 'E2', 'staff salaries', ['staff-pay'])
    await line('E3-p', 'E3', 'Personnel', ['staff-pay'])
    // E2 has a Staff Fringe line holding the taxes; E4 has a Staff Salaries line holding nothing.
    await line('E2-sf', 'E2', 'Staff Fringe', ['staff-taxes'])
    await line('E4-ss', 'E4', 'Staff Salaries')
    // Participant pay on Work Experience (one engagement): punctuation counts, so "Work-Experience" elsewhere differs.
    await line('E1-we', 'E1', 'Work Experience', ['participant-pay'])
    await line('E3-we', 'E3', 'Work-Experience')
    await applyMigration(db, MIGRATION)
  })

  const list = async () =>
    (
      await db.query<{ e: string | null; name: string; goes: string | null; list: string }>(
        `SELECT "engagementId" AS e, "name", "list",
           CASE WHEN "unallowable" THEN 'Not on the budget' ELSE "budgetLineName" END AS goes
         FROM "LineAlias" ORDER BY "name", "engagementId" NULLS FIRST`
      )
    ).rows.map((r) => [r.list, r.name, r.e, r.goes])

  it("makes the most-ticked line the workspace's, and keeps every engagement's lines as they are", async () => {
    expect(await list()).toEqual([
      ['payroll', 'participant-pay', null, 'Work Experience'],
      // No engagement ticks participant taxes.
      ['payroll', 'participant-taxes', null, 'Not on the budget'],
      ['payroll', 'staff-pay', null, 'Staff Salaries'],
      ['payroll', 'staff-pay', 'E3', 'Personnel'],
      // E4 has a Staff Salaries line that holds nothing today.
      ['payroll', 'staff-pay', 'E4', 'Not on the budget'],
      // A tie (one each): the name first in order is the workspace's.
      ['payroll', 'staff-taxes', null, 'Staff Fringe'],
      ['payroll', 'staff-taxes', 'E1', 'Staff Salaries'],
    ])
  })

  it('adds nothing when it runs again', async () => {
    const before = await list()
    await applyMigration(db, MIGRATION)
    expect(await list()).toEqual(before)
  })
})
