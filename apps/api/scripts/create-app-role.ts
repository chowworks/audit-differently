/**
 * Creates (or updates) the restricted database role the API connects as, so row-level security binds it.
 * PostgreSQL superusers and roles with BYPASSRLS skip every policy, so the API must never connect as one.
 * Run by hand as the database owner:
 *
 *   APP_ROLE_PASSWORD=... npx ts-node scripts/create-app-role.ts --confirm-host <host>
 *
 * The password is sent as its SCRAM verifier (src/core/app-role.ts), never in plain text. Deploys keep the role in step
 * on their own (scripts/ensure-app-role.ts); this script is for a database set up by hand.
 *
 * The role may read and write the tables but cannot change the schema, and may execute only the functions listed
 * in src/core/app-role-grants.ts. Tables made later by migrations (run as the owner) get table grants through
 * default privileges; functions never do. Prints the connection string to use as DATABASE_URL for the API (the
 * owner then moves to SCHEMA_DATABASE_URL), with the password hidden.
 */
import './lib/owner-env'
import { PrismaClient } from '@prisma/client'
import { assertBypassesRls, requireHostConfirmation } from './lib/db-guard'
import { appRoleSql, scramVerifier } from '../src/core/app-role'

const ROLE = process.env.APP_ROLE_NAME ?? 'ad_app'

async function main(): Promise<void> {
  requireHostConfirmation()
  const password = process.env.APP_ROLE_PASSWORD
  if (!password || password.length < 24) throw new Error('Set APP_ROLE_PASSWORD (24+ characters)')
  if (!/^[a-z_][a-z0-9_]*$/.test(ROLE)) throw new Error('APP_ROLE_NAME must be a plain identifier')
  const prisma = new PrismaClient()
  try {
    await assertBypassesRls(prisma)
    const [me] = await prisma.$queryRawUnsafe<{ current_user: string; db: string }[]>(
      `SELECT current_user, current_database() AS db`
    )
    const exists = await prisma.$queryRaw<unknown[]>`SELECT 1 FROM pg_roles WHERE rolname = ${ROLE}`
    const keep = exists.length > 0 && !process.argv.includes('--rotate')
    if (keep)
      console.log(
        `Role ${ROLE} already exists: its password is left alone (pass --rotate to set APP_ROLE_PASSWORD, which changes what a running API must connect with). Privileges are refreshed.`
      )
    for (const sql of appRoleSql(ROLE, me.db, {
      exists: exists.length > 0,
      verifier: keep ? null : scramVerifier(password),
    }))
      await prisma.$executeRawUnsafe(sql)
    const url = new URL(process.env.DATABASE_URL as string)
    url.username = ROLE
    url.password = '***'
    console.log(
      `Role ${ROLE} ${exists.length ? 'updated' : 'created'} in ${me.db} (as ${me.current_user}).`
    )
    console.log(
      `Use this as DATABASE_URL for the API (keep the owner as SCHEMA_DATABASE_URL): ${url.toString().replace('%2A%2A%2A', '<password>')}`
    )
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
