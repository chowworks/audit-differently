import type { Role } from '@ad/types'
import type { Caller } from '../caller'

/**
 * Callers and scoped Prisma fakes for the specs that prove a route's gate: who may call it, what a member of
 * another workspace gets (404, never the row), and what each role may change.
 */

/** The workspace a spec's fixtures live in, and another one those rows are foreign to. */
export const W = 'ws-1'
export const OTHER = 'ws-2'

/** A member of `workspaceId` in one role. */
export const member = (role: Role, workspaceId = W): Caller => ({
  userId: `u-${role}-${workspaceId}`,
  displayName: `The ${role}`,
  memberships: [{ workspaceId, workspaceName: workspaceId, role }],
  workspaceIds: [workspaceId],
})

/** An owner of the other workspace: every row in W is foreign to them. */
export const stranger = (): Caller => member('owner', OTHER)

type Where = {
  id?: string
  workspaceId?: string | { in: string[] }
  AND?: Where[]
  [key: string]: unknown
}

const matches = (row: { id?: string; workspaceId?: string | null }, where: Where): boolean => {
  if (where.AND && !where.AND.every((w) => matches(row, w))) return false
  if (where.id !== undefined && row.id !== where.id) return false
  const ws = where.workspaceId
  if (typeof ws === 'string' && row.workspaceId !== ws) return false
  if (ws && typeof ws === 'object' && !ws.in.includes(row.workspaceId ?? '')) return false
  return true
}

/**
 * Prisma `findFirst` and `findMany` over fixed rows that honour `where.id` and the workspace filter
 * (`tenantWhere`, or a plain `workspaceId`) the way row-level security does: a row of another workspace is
 * not there. Other conditions are ignored.
 */
export function scoped<T extends { id?: string; workspaceId?: string | null }>(...rows: T[]) {
  const pick = (args?: { where?: Where }) => rows.filter((r) => matches(r, args?.where ?? {}))
  return {
    findFirst: jest.fn(async (args?: { where?: Where }) => pick(args)[0] ?? null),
    findMany: jest.fn(async (args?: { where?: Where }) => pick(args)),
  }
}
