/**
 * Puts the demo database back to its starting state: every table emptied, then the seed. It is for the dev
 * database (fictional data only) and refuses to run in production; like every writing script it needs
 * --confirm-host, and the dev database is shared, so say what will change and get a yes first (CLAUDE.md).
 *
 *   npm run demo:reset -w @ad/api -- --confirm-host <host of SCHEMA_DATABASE_URL>
 */
import './lib/owner-env'
import { PrismaClient } from '@prisma/client'
import { rm } from 'node:fs/promises'
import * as path from 'node:path'
import { assertBypassesRls, dbHost, requireHostConfirmation } from './lib/db-guard'
import { seed } from '../prisma/seed'

async function main(): Promise<void> {
  requireHostConfirmation()
  if (
    process.env.NODE_ENV === 'production' ||
    process.env.RAILWAY_ENVIRONMENT_NAME === 'production'
  )
    throw new Error(`demo:reset never runs against production (${dbHost()})`)
  const prisma = new PrismaClient()
  try {
    await assertBypassesRls(prisma)
    const tables = await prisma.$queryRawUnsafe<{ tablename: string }[]>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`
    )
    await prisma.$executeRawUnsafe(
      `TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} CASCADE`
    )
    console.log(`Emptied ${tables.length} tables.`)
  } finally {
    await prisma.$disconnect()
  }
  await rm(path.resolve(process.cwd(), 'storage'), { recursive: true, force: true })
  await seed()
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
