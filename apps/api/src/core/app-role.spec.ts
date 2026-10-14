import type { PGlite } from '@electric-sql/pglite'
import { APP_ROLE_FUNCTIONS } from './app-role-grants'
import { appRoleFromUrl, appRoleSql, scramVerifier } from './app-role'
import { dbTestsEnabled, migratedDb } from './testing/tenant-db'

const PASSWORD = 'Ab3dEf6hIj9kLm2nOp5qRs8t'

describe('appRoleFromUrl', () => {
  it('reads the role and the password, decoded', () => {
    expect(
      appRoleFromUrl(
        `postgresql://ad_app:${encodeURIComponent(PASSWORD + '#!')}@postgres.railway.internal:5432/railway?sslmode=require`
      )
    ).toEqual({ role: 'ad_app', password: PASSWORD + '#!' })
  })

  it('refuses a role that is not a plain name, and a short or non-ASCII password', () => {
    expect(() => appRoleFromUrl(`postgresql://ad%3Bapp:${PASSWORD}@h/db`)).toThrow('plain role')
    expect(() => appRoleFromUrl('postgresql://ad_app:short@h/db')).toThrow('24 or more')
    expect(() =>
      appRoleFromUrl(`postgresql://ad_app:${encodeURIComponent(PASSWORD + 'é')}@h/db`)
    ).toThrow('24 or more')
  })
})

describe('scramVerifier', () => {
  it('matches an independent SCRAM-SHA-256 computation (Python hashlib)', () => {
    expect(scramVerifier('pencil', Buffer.from([...Array(16).keys()]), 4096)).toBe(
      'SCRAM-SHA-256$4096:AAECAwQFBgcICQoLDA0ODw==$zHCdol2044/ZyWzPLi7oxApCkamKw9Z+E4U/QApd/5Y=:dd5peBOitVnLNFu7VmwP+HiDaaw4OUCv396eVCWhYiE='
    )
  })

  it('never contains the password, and salts each time', () => {
    const a = scramVerifier(PASSWORD)
    expect(a).not.toContain(PASSWORD)
    expect(a).not.toBe(scramVerifier(PASSWORD))
  })
})

describe('appRoleSql', () => {
  it('refuses what it would splice into SQL unchecked', () => {
    const verifier = scramVerifier(PASSWORD)
    expect(() => appRoleSql('ad;app', 'db', { exists: false, verifier })).toThrow()
    expect(() => appRoleSql('ad_app', 'db"x', { exists: false, verifier })).toThrow()
    expect(() => appRoleSql('ad_app', 'db', { exists: false, verifier: "x'; DROP" })).toThrow()
    expect(() => appRoleSql('ad_app', 'db', { exists: false, verifier: null })).toThrow()
  })

  it('leaves the password alone when given none', () => {
    const sql = appRoleSql('ad_app', 'db', { exists: true, verifier: null })
    expect(sql.some((s) => s.includes('PASSWORD'))).toBe(false)
  })
})

const db = dbTestsEnabled ? describe : describe.skip

db('appRoleSql on Postgres', () => {
  let pg: PGlite
  const run = async (sql: string[]) => {
    for (const s of sql) await pg.exec(s)
  }
  const stored = async () =>
    (
      await pg.query<{ rolpassword: string }>(
        `SELECT rolpassword FROM pg_authid WHERE rolname = 'ad_app'`
      )
    ).rows[0]?.rolpassword

  beforeAll(async () => {
    pg = await migratedDb()
  })
  afterAll(async () => {
    await pg.close()
  })

  it('creates a login that cannot bypass row-level security, storing the verifier as given', async () => {
    const verifier = scramVerifier(PASSWORD)
    await run(appRoleSql('ad_app', 'postgres', { exists: false, verifier }))
    const role = (
      await pg.query<Record<string, boolean>>(
        `SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = 'ad_app'`
      )
    ).rows[0]
    expect(role).toEqual({
      rolcanlogin: true,
      rolsuper: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
    })
    // Postgres keeps a valid verifier as it is; a malformed one would have been hashed again as a password.
    expect(await stored()).toBe(verifier)
  })

  it('grants exactly the listed functions and the tables, and converges when run again', async () => {
    const before = await stored()
    await run(appRoleSql('ad_app', 'postgres', { exists: true, verifier: null }))
    expect(await stored()).toBe(before)
    for (const fn of APP_ROLE_FUNCTIONS) {
      const ok = await pg.query<{ ok: boolean }>(
        `SELECT has_function_privilege('ad_app', $1, 'EXECUTE') AS ok`,
        [fn]
      )
      expect([fn, ok.rows[0].ok]).toEqual([fn, true])
    }
    const others = await pg.query<{ fn: string }>(
      `SELECT p.oid::regprocedure::text AS fn FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND has_function_privilege('ad_app', p.oid, 'EXECUTE')`
    )
    expect(others.rows.map((r) => r.fn).sort()).toEqual([...APP_ROLE_FUNCTIONS].sort())
    const table = await pg.query<{ ok: boolean }>(
      `SELECT has_table_privilege('ad_app', '"Workspace"', 'SELECT,INSERT,UPDATE,DELETE') AS ok`
    )
    expect(table.rows[0].ok).toBe(true)
  })

  it('sets a new password when given one', async () => {
    const verifier = scramVerifier(PASSWORD)
    await run(appRoleSql('ad_app', 'postgres', { exists: true, verifier }))
    expect(await stored()).toBe(verifier)
  })
})
