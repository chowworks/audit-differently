/**
 * Gives a person a role in a workspace, or creates the workspace with them as its first owner; the way to
 * make the first owner of a workspace nobody belongs to yet. Run as the database owner:
 *
 *   npx ts-node scripts/grant-role.ts --user <clerk user id> --workspace "<name>" --role owner --confirm-host <host>
 *
 * Creates the User row if it does not exist yet (its email fills in when the person first signs in), and the
 * workspace if no workspace has that name.
 */
import './lib/owner-env'
import { PrismaClient } from '@prisma/client'
import { DEFAULT_FUNDING_SOURCES, ROLES } from '@ad/types'
import { assertBypassesRls, requireHostConfirmation } from './lib/db-guard'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i < 0 ? undefined : process.argv[i + 1]
}

async function main(): Promise<void> {
  requireHostConfirmation()
  const userId = arg('user')
  const name = arg('workspace')
  const role = arg('role')
  if (!userId || !name || !role || !(ROLES as readonly string[]).includes(role))
    throw new Error(`Usage: --user <id> --workspace <name> --role <${ROLES.join('|')}>`)
  const prisma = new PrismaClient()
  try {
    await assertBypassesRls(prisma)
    const workspace =
      (await prisma.workspace.findFirst({ where: { name } })) ??
      (await prisma.workspace.create({ data: { name, fundingSources: DEFAULT_FUNDING_SOURCES } }))
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } })
    const existing = await prisma.membership.findFirst({
      where: { userId, workspaceId: workspace.id },
    })
    if (existing) {
      if (existing.role === role) {
        console.log('Already granted.')
        return
      }
      await prisma.membership.update({ where: { id: existing.id }, data: { role } })
      console.log(`Changed ${userId} to ${role} in ${workspace.name}.`)
      return
    }
    await prisma.membership.create({ data: { userId, workspaceId: workspace.id, role } })
    console.log(`Granted ${role} in ${workspace.name} to ${userId}.`)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
