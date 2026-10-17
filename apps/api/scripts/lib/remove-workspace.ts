import type { PrismaClient } from '@prisma/client'
import type { DocumentStorage } from '../../src/storage/document-storage.interface'

/**
 * Removes a demo workspace with its records and stored files, as deleting a workspace does it (deletion.service.ts):
 * its files, then each engagement's documents, months and the engagement, then the rest of its documents and the
 * workspace, which takes its memberships, lists and emailed receipts. Its access log lines, statistics and deletion
 * records go too: they describe a workspace that no longer exists. As the database owner; for the demo scripts only.
 */
export async function removeWorkspace(
  prisma: PrismaClient,
  store: DocumentStorage,
  id: string
): Promise<void> {
  await store.deleteByPrefix(`${id}/`)
  await prisma.$transaction(async (tx) => {
    for (const e of await tx.engagement.findMany({
      where: { workspaceId: id },
      select: { id: true },
    })) {
      await tx.document.deleteMany({ where: { engagementId: e.id } })
      await tx.monthlyReport.deleteMany({ where: { engagementId: e.id } })
      await tx.engagement.delete({ where: { id: e.id } })
    }
    await tx.document.deleteMany({ where: { workspaceId: id } })
    await tx.dataAccessLog.deleteMany({ where: { workspaceId: id } })
    await tx.matchRunStat.deleteMany({ where: { workspaceId: id } })
    await tx.deletionRecord.deleteMany({ where: { workspaceId: id } })
    await tx.workspace.delete({ where: { id } })
  })
}
