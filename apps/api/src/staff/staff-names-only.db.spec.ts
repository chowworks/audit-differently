import type { PGlite } from '@electric-sql/pglite'
import { applyMigration, dbTestsEnabled, insert, migratedDb } from '../core/testing/tenant-db'

// Migration 20261018000600_staff_names_only on real Postgres (owner's decision, 2026-10-18): employee numbers go, and a
// person's name is their only key, one per workspace whatever its case. People who shared a name (told apart by their
// numbers until now) are all kept, every one after the first renamed for the owner to tell apart. Fictional people.
const suite = dbTestsEnabled ? describe : describe.skip
const MIGRATION = '20261018000600_staff_names_only'

suite('Staff names only', () => {
  let db: PGlite

  beforeAll(async () => {
    db = await migratedDb(MIGRATION)
    await insert(db, 'Workspace', { id: 'W1', name: 'Riverbend Youth Services' })
    await insert(db, 'Workspace', { id: 'W2', name: 'Harbor Tech Partners' })
    const person = (id: string, ws: string, name: string, number: string | null, at: string) =>
      insert(db, 'StaffMember', {
        id,
        workspaceId: ws,
        name,
        employeeNumber: number,
        role: null,
        createdAt: at,
        updatedAt: at,
      })
    await person('S1', 'W1', 'Morgan Lee', '1042', '2026-10-01T00:00:00Z')
    await person('S2', 'W1', 'morgan lee', '1077', '2026-10-02T00:00:00Z')
    await person('S3', 'W1', 'Morgan Lee', null, '2026-10-03T00:00:00Z')
    await person('S4', 'W1', 'Priya Shah', '2001', '2026-10-01T00:00:00Z')
    await person('S5', 'W2', 'Morgan Lee', '1042', '2026-10-01T00:00:00Z')
    await person('S6', 'W1', 'x'.repeat(120), '1', '2026-10-01T00:00:00Z')
    await person('S7', 'W1', 'X'.repeat(120), '2', '2026-10-02T00:00:00Z')
    await applyMigration(db, MIGRATION)
  })
  afterAll(async () => db?.close())

  it('drops the employee number', async () => {
    const cols = await db.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'StaffMember' AND column_name = 'employeeNumber'`
    )
    expect(cols.rows).toHaveLength(0)
  })

  it('keeps everyone, renaming a second and third person of one name, oldest first, within 120 characters', async () => {
    const rows = await db.query<{ id: string; name: string }>(
      `SELECT "id", "name" FROM "StaffMember" ORDER BY "id"`
    )
    expect(rows.rows).toEqual([
      { id: 'S1', name: 'Morgan Lee' },
      { id: 'S2', name: 'morgan lee (2)' },
      { id: 'S3', name: 'Morgan Lee (3)' },
      { id: 'S4', name: 'Priya Shah' },
      // Another workspace's person of the same name is no clash.
      { id: 'S5', name: 'Morgan Lee' },
      { id: 'S6', name: 'x'.repeat(120) },
      { id: 'S7', name: `${'X'.repeat(116)} (2)` },
    ])
  })

  it('refuses a second person of a name in a workspace, whatever its case', async () => {
    await expect(
      insert(db, 'StaffMember', { id: 'S8', workspaceId: 'W1', name: 'PRIYA SHAH' })
    ).rejects.toThrow(/StaffMember_workspaceId_name_key/)
    await expect(
      insert(db, 'StaffMember', { id: 'S9', workspaceId: 'W2', name: 'Priya Shah' })
    ).resolves.toBeTruthy()
  })
})
