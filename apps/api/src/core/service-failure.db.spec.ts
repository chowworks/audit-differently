import type { PGlite } from '@electric-sql/pglite'
import { appRoleGrantsSql } from './app-role-grants'
import { dbTestsEnabled, migratedDb } from './testing/tenant-db'

// The ServiceFailure table on real Postgres, as the restricted role: it writes, counts and prunes rows with no
// request context (a failure can happen before anyone is known), and the table keeps only the two kinds.
const suite = dbTestsEnabled ? describe : describe.skip

suite('ServiceFailure', () => {
  let db: PGlite

  beforeAll(async () => {
    db = await migratedDb()
    await db.exec(`CREATE ROLE ad_app NOLOGIN;\n${appRoleGrantsSql('ad_app').join(';\n')};`)
  })
  afterAll(() => db.close())

  async function asApp<T>(fn: () => Promise<T>): Promise<T> {
    await db.exec('BEGIN')
    try {
      await db.exec('SET LOCAL ROLE ad_app')
      return await fn()
    } finally {
      await db.exec('ROLLBACK')
    }
  }

  it('lets the restricted role record, count and delete failures with no context', async () => {
    await asApp(async () => {
      await db.query(
        `INSERT INTO "ServiceFailure" (id, kind, route) VALUES ('f1', 'upload', 'POST /api/documents'),
           ('f2', 'server', 'GET /api/engagements/:id')`
      )
      const r = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "ServiceFailure" WHERE kind = 'upload'`
      )
      expect(r.rows[0].n).toBe(1)
      expect((await db.query(`DELETE FROM "ServiceFailure"`)).affectedRows).toBe(2)
    })
  })

  it('keeps only the two kinds and a bounded route', async () => {
    await asApp(async () => {
      await expect(
        db.query(`INSERT INTO "ServiceFailure" (id, kind, route) VALUES ('f3', 'other', 'x')`)
      ).rejects.toThrow(/ServiceFailure_kind_check/)
    })
    await asApp(async () => {
      await expect(
        db.query(`INSERT INTO "ServiceFailure" (id, kind, route) VALUES ('f4', 'server', $1)`, [
          'x'.repeat(201),
        ])
      ).rejects.toThrow(/ServiceFailure_route_check/)
    })
  })
})
