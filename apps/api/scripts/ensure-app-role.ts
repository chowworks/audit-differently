/**
 * Keeps the restricted role the API connects as in step with the API's own settings, on every deploy, right after
 * the migrations (so the functions it may execute exist) and before the API starts:
 *
 *   prisma migrate deploy && npm run role:ensure -w @ad/api && node apps/api/dist/main.js
 *
 * DATABASE_URL names the role and its password; SCHEMA_DATABASE_URL is the owner that sets it up. The password is
 * kept in the service's settings only (`preserve()` in .railway/railway.ts), never in a file. The role is created
 * if it is missing; its password is set (as a SCRAM verifier, never plain text) only when DATABASE_URL cannot log in
 * with it; its limits and grants (src/core/app-role.ts) are applied every time. It takes no host from the command
 * line, only the URLs the service itself is configured with, so it asks for no --confirm-host.
 */
import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import { appRoleFromUrl, appRoleSql, scramVerifier } from '../src/core/app-role'
import { assertBypassesRls } from './lib/db-guard'

const TLS = /[?&]sslmode=(require|verify-ca|verify-full)(&|$)/
const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]', '::1']

function url(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  const host = new URL(value).hostname
  if (!LOOPBACK.includes(host) && !TLS.test(value))
    throw new Error(`${name} reaches ${host} without TLS: add sslmode=require`)
  return value
}

/** Whether DATABASE_URL logs in as it stands. */
async function logsIn(appUrl: string): Promise<boolean> {
  const app = new PrismaClient({ datasourceUrl: appUrl })
  try {
    await app.$queryRaw`SELECT 1`
    return true
  } catch {
    return false
  } finally {
    await app.$disconnect()
  }
}

async function main(): Promise<void> {
  const appUrl = url('DATABASE_URL')
  const { role, password } = appRoleFromUrl(appUrl)
  const owner = new PrismaClient({ datasourceUrl: url('SCHEMA_DATABASE_URL') })
  try {
    await assertBypassesRls(owner)
    const [me] = await owner.$queryRaw<{ current_user: string; db: string }[]>`
      SELECT current_user, current_database() AS db`
    if (me.current_user === role)
      throw new Error(
        `DATABASE_URL connects as ${role}, the database owner: it must name the restricted role (CLAUDE.md, "Tenant isolation")`
      )
    const exists =
      (await owner.$queryRaw<unknown[]>`SELECT 1 FROM pg_roles WHERE rolname = ${role}`).length > 0
    const current = exists && (await logsIn(appUrl))
    for (const sql of appRoleSql(role, me.db, {
      exists,
      verifier: current ? null : scramVerifier(password),
    }))
      await owner.$executeRawUnsafe(sql)
    console.log(
      `Role ${role}: ${!exists ? 'created' : current ? 'password unchanged' : 'password set'}; limits and grants applied.`
    )
  } finally {
    await owner.$disconnect()
  }
}

main().catch((e: Error) => {
  // The message names settings and hosts, never a password.
  console.error(`role:ensure failed: ${e.message}`)
  process.exit(1)
})
