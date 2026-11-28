import type { PGlite } from '@electric-sql/pglite'
import { PAYROLL_BUDGET_KINDS, payrollHolder } from '@ad/types'
import { applyMigration, dbTestsEnabled, insert, migratedDb } from '../core/testing/tenant-db'

// Payroll budget line items filled once from each line's payroll ticks (#138, migration 20261128000100).
const suite = dbTestsEnabled ? describe : describe.skip
const MIGRATION = '20261128000100_payroll_rollup'

suite('payroll budget line items from the payroll ticks', () => {
  let db: PGlite
  afterAll(() => db.close())

  const line = (
    id: string,
    engagementId: string,
    name: string,
    reportLine: string,
    payroll: string[] = []
  ) =>
    insert(db, 'BudgetLine', {
      id,
      engagementId,
      name,
      reportLine,
      amount: 100,
      payroll: `{${payroll.join(',')}}`,
    })

  beforeAll(async () => {
    db = await migratedDb(MIGRATION)
    await insert(db, 'Workspace', { id: 'W1', name: 'W1' })
    for (const e of ['E1', 'E2', 'E3', 'E4', 'E5'])
      await insert(db, 'Engagement', { id: e, workspaceId: 'W1', name: e, number: e })
    // Staff pay on Staff Salaries at E1 and E2, on Personnel at E3.
    await line('E1-ss', 'E1', 'Staff Salaries', 'staff-salaries', ['staff-pay', 'staff-taxes'])
    await line('E2-ss', 'E2', 'staff salaries', 'staff-salaries', ['staff-pay'])
    await line('E3-p', 'E3', 'Personnel', 'staff-salaries', ['staff-pay'])
    // E2 holds the taxes on Staff Fringe.
    await line('E2-sf', 'E2', 'Staff Fringe', 'staff-fringe', ['staff-taxes'])
    // E4 has both listed names, ticked on Personnel: a clash the copy settles with its own row.
    await line('E4-ss', 'E4', 'Staff Salaries', 'staff-salaries')
    await line('E4-p', 'E4', 'Personnel', 'staff-salaries', ['staff-pay'])
    // E5 has a Staff Salaries line holding nothing today: it must stay off the budget.
    await line('E5-ss', 'E5', 'Staff Salaries', 'staff-salaries')
    // Participant pay on Work Experience; punctuation counts, so E3's "Work-Experience" is another line, unticked,
    // and the report line would take it without its own row.
    await line('E1-we', 'E1', 'Work Experience', 'wex', ['participant-pay'])
    await line('E3-we', 'E3', 'Work-Experience', 'wex')
    // A second workspace reusing W1's names with other ticks, and an engagement with no lines: nothing crosses over.
    await insert(db, 'Workspace', { id: 'W2', name: 'W2' })
    for (const e of ['E6', 'E7'])
      await insert(db, 'Engagement', { id: e, workspaceId: 'W2', name: e, number: e })
    await line('E6-p', 'E6', 'Personnel', 'staff-salaries', ['participant-pay'])
    await line('E6-ss', 'E6', 'Staff Salaries', 'staff-salaries')
    await insert(db, 'Workspace', { id: 'W3', name: 'W3' })
    await applyMigration(db, MIGRATION)
  })

  const rows = async (ws = 'W1') =>
    (
      await db.query<{
        e: string | null
        kind: string
        key: string
        goes: string | null
      }>(
        `SELECT "engagementId" AS e, "name" AS kind, "key",
           CASE WHEN "unallowable" THEN NULL ELSE "budgetLineName" END AS goes
         FROM "LineAlias" WHERE "list" = 'payroll' AND "workspaceId" = $1
         ORDER BY "name", "engagementId" NULLS FIRST, "key"`,
        [ws]
      )
    ).rows

  it('lists every ticked name for the workspace, and gives an engagement its own row only where needed', async () => {
    expect((await rows()).map((r) => [r.kind, r.e, r.goes, r.key])).toEqual([
      ['participant-pay', null, 'Work Experience', 'participant-pay|work experience'],
      ['participant-pay', 'E2', null, 'participant-pay'],
      ['participant-pay', 'E3', null, 'participant-pay'],
      ['participant-pay', 'E4', null, 'participant-pay'],
      ['participant-pay', 'E5', null, 'participant-pay'],
      // Nobody ticks participant taxes: off the budget everywhere, no engagement row needed.
      ['participant-taxes', null, null, 'participant-taxes'],
      ['staff-pay', null, 'Personnel', 'staff-pay|personnel'],
      ['staff-pay', null, 'Staff Salaries', 'staff-pay|staff salaries'],
      ['staff-pay', 'E4', 'Personnel', 'staff-pay'],
      ['staff-pay', 'E5', null, 'staff-pay'],
      ['staff-taxes', null, 'Staff Fringe', 'staff-taxes|staff fringe'],
      ['staff-taxes', null, 'Staff Salaries', 'staff-taxes|staff salaries'],
      // E1 has exactly one listed line, the one it ticks; E2 has both; the others tick nothing.
      ['staff-taxes', 'E2', 'Staff Fringe', 'staff-taxes'],
      ['staff-taxes', 'E3', null, 'staff-taxes'],
      ['staff-taxes', 'E4', null, 'staff-taxes'],
      ['staff-taxes', 'E5', null, 'staff-taxes'],
    ])
  })

  it("keeps each workspace's list to its own names", async () => {
    expect((await rows('W2')).map((r) => [r.kind, r.e, r.goes])).toEqual([
      ['participant-pay', null, 'Personnel'],
      // E7 has no lines: its own Not linked keeps it off the budget, as today.
      ['participant-pay', 'E7', null],
      ['participant-taxes', null, null],
      ['staff-pay', null, null],
      ['staff-taxes', null, null],
    ])
    // A workspace with no engagements gets no rows, as a workspace made later starts.
    expect(await rows('W3')).toEqual([])
  })

  it.each([
    ['W1', ['E1', 'E2', 'E3', 'E4', 'E5']],
    ['W2', ['E6', 'E7']],
  ])("puts every engagement's pay exactly where its ticks put it (%s)", async (ws, engagements) => {
    const entries = (await rows(ws)).map((r) => ({
      kind: r.kind as (typeof PAYROLL_BUDGET_KINDS)[number],
      engagementId: r.e,
      budgetLineName: r.goes,
    }))
    const lines = (
      await db.query<{
        id: string
        e: string
        name: string
        reportLine: string
        payroll: string[]
      }>(
        `SELECT "id", "engagementId" AS e, "name", "reportLine", "payroll" FROM "BudgetLine"
         ORDER BY "sortOrder", "id"`
      )
    ).rows
    for (const e of engagements)
      for (const kind of PAYROLL_BUDGET_KINDS) {
        const mine = lines.filter((l) => l.e === e)
        const today = mine.find((l) => l.payroll.includes(kind))?.id ?? null
        expect([e, kind, payrollHolder(kind, e, entries, mine)?.id ?? null]).toEqual([
          e,
          kind,
          today,
        ])
      }
  })

  it('adds nothing when it runs again', async () => {
    const before = [await rows('W1'), await rows('W2')]
    await applyMigration(db, MIGRATION)
    expect([await rows('W1'), await rows('W2')]).toEqual(before)
  })
})
