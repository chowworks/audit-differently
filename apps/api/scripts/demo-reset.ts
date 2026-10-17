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
      // As deleting a workspace does it (deletion.service.ts): its files, then each engagement's documents, months
      // and the engagement, then the rest of its documents and the workspace, which takes its memberships, lists and
      // emailed receipts. Its access log lines and statistics go too: they describe a workspace that no longer exists.
      await store.deleteByPrefix(`${w.id}/`)
      await prisma.$transaction(async (tx) => {
        for (const e of await tx.engagement.findMany({
          where: { workspaceId: w.id },
          select: { id: true },
        })) {
          await tx.document.deleteMany({ where: { engagementId: e.id } })
          await tx.monthlyReport.deleteMany({ where: { engagementId: e.id } })
          await tx.engagement.delete({ where: { id: e.id } })
        }
        await tx.document.deleteMany({ where: { workspaceId: w.id } })
        await tx.dataAccessLog.deleteMany({ where: { workspaceId: w.id } })
        await tx.matchRunStat.deleteMany({ where: { workspaceId: w.id } })
        await tx.deletionRecord.deleteMany({ where: { workspaceId: w.id } })
        await tx.workspace.delete({ where: { id: w.id } })
      })
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
