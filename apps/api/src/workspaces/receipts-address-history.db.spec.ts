import type { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sinceRemovalSql } from '../admin/admin-receipts-addresses.service'
import { appRoleGrantsSql } from '../core/app-role-grants'
import { applyMigration, dbTestsEnabled, insert, migratedDb } from '../core/testing/tenant-db'
import { PURGE_SQL, REJECT, UNKNOWN_KEPT_DAYS } from '../inbound/inbound.service'

// Migration 20261017000400_receipts_address_history on real Postgres: every receipts address in use today goes into the
// history as current, first used when its "Set the receipts address" line was written, else when its workspace was
// made. Then the emails refused at a previously used address: counted (never stored), kept past the clean-up while
// the address is held, and removed when it is released.
const suite = dbTestsEnabled ? describe : describe.skip
const MIGRATION = '20261017000400_receipts_address_history'

it('releases the refused emails by the very reason the webhook writes', () => {
  const sql = readFileSync(
    join(__dirname, `../../prisma/migrations/${MIGRATION}/migration.sql`),
    'utf8'
  )
  expect(sql).toContain(`"rejectReason" = '${REJECT.retired}'`)
})

suite('Receipts address history, from the addresses in use', () => {
  let db: PGlite

  beforeAll(async () => {
    db = await migratedDb(MIGRATION)
    await insert(db, 'Workspace', { id: 'W1', name: 'Riverbend Youth Services' })
    await insert(db, 'Workspace', {
      id: 'W2',
      name: 'Harbor Tech Partners',
      createdAt: '2026-09-01T08:00:00Z',
    })
    await insert(db, 'Workspace', { id: 'W3', name: 'No address yet' })
    await db.query(`UPDATE "Workspace" SET "receiptsAddress" = 'riverbend-youth' WHERE id = 'W1'`)
    await db.query(`UPDATE "Workspace" SET "receiptsAddress" = 'harbor-tech' WHERE id = 'W2'`)
    await insert(db, 'DataAccessLog', {
      id: 'L1',
      workspaceId: 'W1',
      actorId: 'u1',
      description: 'Set the receipts address',
      createdAt: '2026-10-15T14:00:00Z',
    })
    await applyMigration(db, MIGRATION)
  })
  afterAll(() => db.close())

  it('keeps each address in use as current, first set where the log says, else when its workspace was made', async () => {
    const rows = (
      await db.query<{
        address: string
        workspaceId: string
        firstUsedAt: string
        current: boolean
      }>(
        `SELECT address, "workspaceId", to_char("firstUsedAt", 'YYYY-MM-DD HH24:MI') AS "firstUsedAt", "removedAt" IS NULL AS current
           FROM "ReceiptsAddress" ORDER BY address`
      )
    ).rows
    expect(rows.map((r) => [r.address, r.workspaceId, r.current])).toEqual([
      ['harbor-tech', 'W2', true],
      ['riverbend-youth', 'W1', true],
    ])
    expect(rows.map((r) => r.firstUsedAt)).toEqual(['2026-09-01 08:00', '2026-10-15 14:00'])
  })
})

suite('Emails refused at a previously used address', () => {
  let db: PGlite
  const day = 86_400_000
  const now = Date.now()
  const ago = (days: number) => new Date(now - days * day).toISOString()

  /** Runs `fn` as the API's restricted role, with the platform admin's mark or as trusted work. */
  async function as<T>(ctx: { admin?: boolean; system?: boolean }, fn: () => Promise<T>) {
    await db.exec('BEGIN')
    try {
      await db.exec('SET LOCAL ROLE ad_app')
      await db.query(
        `SELECT set_config('app.user_id', $1, true), set_config('app.system', $2, true), set_config('app.admin', $3, true)`,
        [ctx.admin ? 'admin-1' : '', ctx.system ? 'on' : '', ctx.admin ? 'on' : '']
      )
      const out = await fn()
      await db.exec('COMMIT')
      return out
    } catch (e) {
      await db.exec('ROLLBACK')
      throw e
    }
  }
  const kept = (id: string, to: string, receivedAt: string, from: string | null = null) =>
    insert(db, 'InboundReceipt', {
      id,
      emailId: `email-${id}`,
      toAddress: `${to}@receipts.example.org`,
      fromAddress: from,
      receivedAt,
      status: 'rejected',
      rejectReason: REJECT.retired,
    })
  const left = async () =>
    (await db.query<{ id: string }>(`SELECT id FROM "InboundReceipt" ORDER BY id`)).rows.map(
      (r) => r.id
    )
  let oldId = ''

  beforeAll(async () => {
    db = await migratedDb()
    await db.exec(`CREATE ROLE ad_app NOLOGIN;\n${appRoleGrantsSql('ad_app').join(';\n')};`)
    await insert(db, 'User', { id: 'admin-1', email: 'admin@example.org' })
    await insert(db, 'Workspace', { id: 'W1', name: 'Riverbend Youth Services' })
    await db.query(`UPDATE "Workspace" SET "receiptsAddress" = 'riv-old' WHERE id = 'W1'`)
    await db.query(`UPDATE "Workspace" SET "receiptsAddress" = 'riv-now' WHERE id = 'W1'`)
    // Removed 90 days ago (the database owner corrects the date, as a script may).
    oldId = (
      await db.query<{ id: string }>(
        `UPDATE "ReceiptsAddress" SET "removedAt" = $1 WHERE address = 'riv-old' RETURNING id`,
        [ago(90)]
      )
    ).rows[0]!.id
    await kept('IR-a-before', 'riv-old', ago(100)) // before it was removed: not counted
    await kept('IR-b-old', 'riv-old', ago(60))
    await kept('IR-c-new', 'riv-old', ago(10))
    await kept('IR-d-sender', 'riv-old', ago(60), 'pat@example.org') // refused by the worker: not one kept
    await kept('IR-e-unheld', 'riv-nobody', ago(60)) // no address held: nothing to count it for
    await insert(db, 'InboundReceipt', {
      id: 'IR-f-unknown',
      emailId: 'email-f',
      toAddress: 'who@receipts.example.org',
      receivedAt: ago(60),
      status: 'rejected',
      rejectReason: REJECT.noAddress,
    })
  })
  afterAll(() => db.close())

  it("counts them since removal in one aggregate the admin's mark reads, never the current address", async () => {
    const q = sinceRemovalSql(null)
    // The last arrival as Postgres keeps it (UTC, as Prisma reads it), not as this machine's clock would show it.
    const rows = await as(
      { admin: true },
      async () =>
        (
          await db.query<{ id: string; received: number; last: string }>(
            `SELECT id, received, to_char(last, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last FROM (${q.text}) s`,
            q.values
          )
        ).rows
    )
    expect(rows).toEqual([{ id: oldId, received: 2, last: ago(10) }])
  })

  it('keeps them past the clean-up while the address is held, and cleans up everything else as before', async () => {
    await as({ system: true }, () =>
      db.query(PURGE_SQL, [new Date(now - UNKNOWN_KEPT_DAYS * day), REJECT.retired])
    )
    expect(await left()).toEqual(['IR-a-before', 'IR-b-old', 'IR-c-new'])
  })

  it('removes them when the address is released, so its count starts at zero', async () => {
    await as({ admin: true }, () =>
      db.query(`UPDATE "ReceiptsAddress" SET "releasedAt" = now() WHERE id = $1`, [oldId])
    )
    expect(await left()).toEqual([])
    const q = sinceRemovalSql(null)
    expect(await as({ admin: true }, async () => (await db.query(q.text, q.values)).rows)).toEqual(
      []
    )
  })
})
