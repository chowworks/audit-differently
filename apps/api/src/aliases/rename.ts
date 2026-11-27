import type { Prisma } from '@prisma/client'
import { aliasKey } from '@ad/types'

/**
 * A budget line renamed (owner's decision, 2026-11-27, #132): the QuickBooks names that point at its old name follow it,
 * in the rename's own transaction. The engagement's own overrides move to the new name. A workspace entry moves too,
 * unless another engagement still has a line of the old name: then it stays for that one, and this engagement gets an
 * override to the new name. An override that ends up saying what the workspace entry says goes (renaming a line back
 * leaves no duplicates). Returns how many names now point at the new name.
 */
export async function carryRename(
  tx: Prisma.TransactionClient,
  input: {
    workspaceId: string
    engagementId: string
    from: string
    to: string
    changedById: string
  }
): Promise<number> {
  const { workspaceId, engagementId, from, to, changedById } = input
  if (aliasKey(from) === aliasKey(to)) return 0
  const pointing = (
    await tx.lineAlias.findMany({
      where: {
        workspaceId,
        list: 'quickbooks',
        unallowable: false,
        OR: [{ engagementId: null }, { engagementId }],
      },
    })
  ).filter((a) => aliasKey(a.budgetLineName ?? '') === aliasKey(from))
  if (!pointing.length) return 0
  const others = await tx.budgetLine.findMany({
    where: { engagement: { workspaceId }, engagementId: { not: engagementId } },
    select: { name: true },
  })
  const sharedOld = others.some((l) => aliasKey(l.name) === aliasKey(from))
  const now = { budgetLineName: to, changedById, changedAt: new Date() }
  let n = 0
  for (const a of pointing) {
    if (a.engagementId === engagementId || !sharedOld) {
      await tx.lineAlias.update({ where: { id: a.id }, data: now })
      n++
      continue
    }
    // Another engagement keeps the old name: this one's own override, unless it has one for the name already.
    // (Any override of the name, wherever it goes: this engagement's own choice wins and stays.)
    if (
      await tx.lineAlias.findFirst({
        where: { workspaceId, list: 'quickbooks', engagementId, key: a.key },
        select: { id: true },
      })
    )
      continue
    await tx.lineAlias.create({
      data: { ...now, workspaceId, engagementId, list: 'quickbooks', name: a.name, key: a.key },
    })
    n++
  }
  // This engagement's overrides of the new name that now say what the workspace entry says are dropped.
  const after = await tx.lineAlias.findMany({
    where: {
      workspaceId,
      list: 'quickbooks',
      unallowable: false,
      OR: [{ engagementId: null }, { engagementId }],
    },
    select: { id: true, engagementId: true, key: true, budgetLineName: true },
  })
  const atNew = (a: { budgetLineName: string | null }) =>
    aliasKey(a.budgetLineName ?? '') === aliasKey(to)
  const everyAtNew = new Set(
    after.filter((a) => a.engagementId === null && atNew(a)).map((a) => a.key)
  )
  const same = after.filter(
    (a) => a.engagementId === engagementId && atNew(a) && everyAtNew.has(a.key)
  )
  if (same.length) await tx.lineAlias.deleteMany({ where: { id: { in: same.map((a) => a.id) } } })
  return n
}
