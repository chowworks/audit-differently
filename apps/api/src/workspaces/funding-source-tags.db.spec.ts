import type { PGlite } from '@electric-sql/pglite'
import { Prisma } from '@prisma/client'
import { applyMigration, dbTestsEnabled, insert, migratedDb } from '../core/testing/tenant-db'
import { ripTag } from './workspaces.service'

// Migration 20261016000800_funding_source_tags on real Postgres: the sources of funds become an ordinary tag type, and
// every record's and engagement's funding-source tag moves from the source's words to its value's key. Then the SQL
// that takes a removed tag off every record, as WorkspacesService runs it.
const suite = dbTestsEnabled ? describe : describe.skip
const MIGRATION = '20261016000800_funding_source_tags'

suite('Funding source as an ordinary tag type', () => {
  let db: PGlite
  const one = async <T>(sql: string) => (await db.query<T>(sql)).rows[0]!

  beforeAll(async () => {
    db = await migratedDb(MIGRATION)
    await insert(db, 'Workspace', {
      id: 'W1',
      name: 'Riverbend Youth Services',
      fundingSources: '{"Youth Workforce Fund","Adult Training Fund"}',
      tagTypes: JSON.stringify([
        {
          key: 'age-group-ab12',
          label: 'Age group',
          appliesTo: ['participant'],
          values: [{ key: 'under-18-cd34', label: 'Under 18' }],
        },
      ]),
    })
    await insert(db, 'Workspace', { id: 'W2', name: 'Harbor Tech Partners', fundingSources: '{}' })
    await insert(db, 'Engagement', {
      id: 'E1',
      workspaceId: 'W1',
      name: 'Coding Pathway',
      fundingSources: '{"Adult Training Fund","Gone Fund"}',
    })
    await insert(db, 'MonthlyReport', { id: 'R1', engagementId: 'E1', period: '2026-09' })
    await insert(db, 'Expense', {
      id: 'X1',
      engagementId: 'E1',
      monthlyReportId: 'R1',
      tags: '{"funding-source:Youth Workforce Fund","site-ef56:north-gh78"}',
    })
    await insert(db, 'Participant', {
      id: 'P1',
      engagementId: 'E1',
      tags: '{"age-group-ab12:under-18-cd34","funding-source:Adult Training Fund"}',
    })
    await insert(db, 'WexPayment', {
      id: 'WX1',
      monthlyReportId: 'R1',
      participantId: 'P1',
      tags: '{"funding-source:Gone Fund"}',
    })
    // A submitted month's records convert too: the lock is off for the conversion only.
    await db.exec(`UPDATE "MonthlyReport" SET "status" = 'submitted' WHERE "id" = 'R1'`)
    await applyMigration(db, MIGRATION)
  })

  afterAll(async () => db?.close())

  it('makes the sources of funds the first tag type, keyed, applying to engagements and every record', async () => {
    const w = await one<{ tagTypes: { key: string; values: unknown[] }[] }>(
      `SELECT "tagTypes" FROM "Workspace" WHERE "id" = 'W1'`
    )
    expect(w.tagTypes).toEqual([
      {
        key: 'funding-source',
        label: 'Funding source',
        appliesTo: ['engagement', 'expense', 'payroll', 'participant'],
        values: [
          { key: 'youth-workforce-fund-1', label: 'Youth Workforce Fund' },
          { key: 'adult-training-fund-2', label: 'Adult Training Fund' },
        ],
      },
      expect.objectContaining({ key: 'age-group-ab12' }),
    ])
    // An empty list adds no type, and the old columns are gone.
    expect(
      (await one<{ tagTypes: unknown }>(`SELECT * FROM "Workspace" WHERE "id" = 'W2'`)).tagTypes
    ).toEqual([])
    const cols = await db.query(
      `SELECT table_name FROM information_schema.columns WHERE column_name = 'fundingSources'`
    )
    expect(cols.rows).toEqual([])
  })

  it("moves every record's and engagement's tag to the value's key, in order, dropping words not in the list", async () => {
    const tags = async (table: string, id: string) =>
      (await one<{ tags: string[] }>(`SELECT "tags" FROM "${table}" WHERE "id" = '${id}'`)).tags
    expect(await tags('Expense', 'X1')).toEqual([
      'funding-source:youth-workforce-fund-1',
      'site-ef56:north-gh78',
    ])
    expect(await tags('Participant', 'P1')).toEqual([
      'age-group-ab12:under-18-cd34',
      'funding-source:adult-training-fund-2',
    ])
    expect(await tags('WexPayment', 'WX1')).toEqual([])
    expect(await tags('Engagement', 'E1')).toEqual(['funding-source:adult-training-fund-2'])
  })

  it('keeps the month lock on afterwards', async () => {
    await expect(db.exec(`UPDATE "Expense" SET "tags" = '{}' WHERE "id" = 'X1'`)).rejects.toThrow(
      /month_locked/
    )
  })

  it('takes a removed tag off every kind of record in the workspace and counts each', async () => {
    await db.exec(`UPDATE "MonthlyReport" SET "status" = 'draft' WHERE "id" = 'R1'`)
    const tx = {
      $executeRaw: async (parts: TemplateStringsArray, ...values: unknown[]) => {
        const q = Prisma.sql(parts, ...values)
        return (await db.query(q.text, q.values as never[])).affectedRows ?? 0
      },
    }
    expect(await ripTag(tx as never, 'W1', 'funding-source:adult-training-fund-2')).toEqual({
      engagement: 1,
      expense: 0,
      payroll: 0,
      participant: 1,
    })
    expect(
      (await one<{ tags: string[] }>(`SELECT "tags" FROM "Participant" WHERE "id" = 'P1'`)).tags
    ).toEqual(['age-group-ab12:under-18-cd34'])
    expect(await ripTag(tx as never, 'W2', 'funding-source:youth-workforce-fund-1')).toEqual({
      engagement: 0,
      expense: 0,
      payroll: 0,
      participant: 0,
    })
  })
})
