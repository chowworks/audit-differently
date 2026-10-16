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
 * DEMO_OWNER_EMAIL sets the demo owner's seat (Sam Whitfield). In production it defaults to an .example address nobody
 * can verify, so no account takes the seat; a platform admin seats themself from Admin tools to walk the demo.
 */
import './lib/owner-env'
import { PrismaClient } from '@prisma/client'
import { assertBypassesRls, dbHost, requireHostConfirmation } from './lib/db-guard'
import { disconnect, isProduction, seedDemoWorkspace } from '../prisma/seed'

async function main(): Promise<void> {
  requireHostConfirmation()
  const production = isProduction()
  // In production the files must go to the private bucket: the service's own disk is neither private nor kept.
  if (production && !process.env.R2_DOCUMENTS_BUCKET)
    throw new Error('R2_DOCUMENTS_BUCKET is not set: the demo files would not reach the bucket')
  const prisma = new PrismaClient()
  try {
    await assertBypassesRls(prisma)
  } finally {
    await prisma.$disconnect()
  }
  const ownerEmail =
    process.env.DEMO_OWNER_EMAIL ??
    (production ? 'sam.whitfield@riverbend.example' : 'test@chowworks.com')
  const { workspaceId } = await seedDemoWorkspace({ ownerEmail, logRun: production })
  console.log(
    `Demo workspace ${workspaceId} loaded on ${dbHost()}${production ? ' (production)' : ''}.`
  )
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => disconnect())
