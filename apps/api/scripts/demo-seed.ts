/**
 * Loads (or puts back) the fictional demo workspace, Riverbend Youth Services with its engagement DEMO-26IS-RYS, in the
 * environment it runs in, production included. It creates or updates that one workspace and nothing else: it never
 * empties a table, never touches another workspace's rows, and refuses (changing nothing) when the name or receipts
 * address it uses belongs to a workspace that is not plainly the demo (prisma/seed.ts, `demoWorkspace`). Its files go to
 * the environment's private bucket under the demo workspace's own prefix. Like every writing script it needs
 * --confirm-host, and in production it needs the owner's yes at the time (CLAUDE.md, "Database"); docs/dev-api.md has
 * how to run it there.
 *
 *   npm run demo:seed -w @ad/api -- --confirm-host <host of SCHEMA_DATABASE_URL>
 *
 * Where it runs is never guessed from the shell's variables (a laptop holding production's SCHEMA_DATABASE_URL looks
 * like dev): it behaves the same everywhere. Its files go to R2_DOCUMENTS_BUCKET, which it refuses to run without
 * unless the database is on this machine; the owner's seat (Sam Whitfield) is an .example address nobody can verify
 * unless DEMO_OWNER_EMAIL names one, so no account takes it by accident (a platform admin seats themself from Admin
 * tools to walk the demo); and every run writes its access-log line.
 */
import './lib/owner-env'
import { PrismaClient } from '@prisma/client'
import { assertBypassesRls, dbHost, requireHostConfirmation } from './lib/db-guard'
import { disconnect, seedDemoWorkspace } from '../prisma/seed'

/** A database on this machine: the one case whose files may stay on this disk. */
const onThisMachine = (host: string) =>
  ['localhost', '127.0.0.1', '[::1]'].includes(host.replace(/:\d+$/, ''))

async function main(): Promise<void> {
  requireHostConfirmation()
  // The files must go to the environment's private bucket: a laptop's or a service's own disk is neither.
  if (!process.env.R2_DOCUMENTS_BUCKET && !onThisMachine(dbHost()))
    throw new Error(
      `R2_DOCUMENTS_BUCKET is not set: the demo files for ${dbHost()} would not reach its bucket`
    )
  const prisma = new PrismaClient()
  try {
    await assertBypassesRls(prisma)
  } finally {
    await prisma.$disconnect()
  }
  const ownerEmail = process.env.DEMO_OWNER_EMAIL || 'sam.whitfield@riverbend.example'
  const { workspaceId } = await seedDemoWorkspace({ ownerEmail, logRun: true })
  console.log(`Demo workspace ${workspaceId} loaded on ${dbHost()}, owner seat ${ownerEmail}.`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => disconnect())
