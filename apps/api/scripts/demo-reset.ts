/**
 * Puts the demo back to its starting state on the dev database: the demo workspaces (the full demo, and the seed's
 * Harbor Tech) are removed with their records and stored files, then the seed loads them again. Everything else stays:
 * every person, their Terms acceptances, platform admins and any other workspace, so dev keeps behaving as production
 * does (production reloads its demo with demo:seed, which empties nothing). It is for the dev database (fictional data
 * only) and refuses to run in production; like every writing script it needs --confirm-host, and the dev database is
 * shared, so say what will change and get a yes first (CLAUDE.md).
 *
 *   npm run demo:reset -w @ad/api -- --confirm-host <host of SCHEMA_DATABASE_URL>
 */
import './lib/owner-env'
import { PrismaClient } from '@prisma/client'
import { assertBypassesRls, dbHost, requireHostConfirmation } from './lib/db-guard'
import { removeWorkspace } from './lib/remove-workspace'
import { seed } from '../prisma/seed'
import { LocalDiskStorage } from '../src/storage/local-disk-storage'
import { R2DocumentStorage } from '../src/storage/r2-storage'

/** The dev seed's second workspace; the full demo is found by its mark (`featuredDemo`). */
const SEED_WORKSPACES = ['Harbor Tech Collective']

async function main(): Promise<void> {
  requireHostConfirmation()
  if (
    process.env.NODE_ENV === 'production' ||
    process.env.RAILWAY_ENVIRONMENT_NAME === 'production'
  )
    throw new Error(`demo:reset never runs against production (${dbHost()})`)
  const prisma = new PrismaClient()
  const store = process.env.R2_DOCUMENTS_BUCKET ? new R2DocumentStorage() : new LocalDiskStorage()
  try {
    await assertBypassesRls(prisma)
    const demo = await prisma.workspace.findMany({
      where: { OR: [{ featuredDemo: true }, { name: { in: SEED_WORKSPACES } }] },
      select: { id: true, name: true },
    })
    for (const w of demo) {
      await removeWorkspace(prisma, store, w.id)
      console.log(`Removed the demo workspace ${w.name}.`)
    }
  } finally {
    await prisma.$disconnect()
  }
  await seed()
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
