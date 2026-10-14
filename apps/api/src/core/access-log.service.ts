import { Injectable } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import type { LoggedChange } from '@ad/types'
import { PrismaService } from '../prisma/prisma.service'
import { staffName, type Caller } from './caller'
import { tenantContext } from './tenant-context'

/** One line of the access log. */
export interface LogEntry {
  workspaceId: string
  resource:
    | 'workspace'
    | 'engagement'
    | 'document'
    | 'expense'
    | 'report'
    | 'participant'
    | 'export'
    | 'member'
  subjectId?: string | null
  action:
    'read' | 'list' | 'download' | 'create' | 'update' | 'delete' | 'export' | 'submit' | 'review'
  /** What the person did, in the words of the screen they did it on. Never a personal value. */
  description: string
  /** The fields a change touched, from `changesOf` (src/core/changes.ts), which keeps personal values out. */
  changes?: LoggedChange[]
}

/** Who a line names: the person's account and their email (`staffName`). */
export type Actor = Pick<Caller, 'userId' | 'email'>

/**
 * The access log: every read, list, download and export of a document or participant row (`log`), and every
 * change to the workspace's data (`change`, or `trusted` for the few changes made as trusted work).
 */
@Injectable()
export class AccessLogService {
  constructor(private readonly prisma: PrismaService) {}

  async log(caller: Caller, entry: LogEntry): Promise<void> {
    await this.prisma.dataAccessLog.create({ data: row(caller, entry) })
  }

  /**
   * Makes a change and logs it in one transaction, under the caller's own row-level security: a change that fails
   * leaves no line, and a line that cannot be written undoes the change. `write` must use the `tx` it is given for
   * every write. `entry` may be worked out from what `write` returned (a new row's id, its workspaceId). When the
   * result is a row with a `workspaceId` that is not the entry's, nothing is kept: the line would be filed in the
   * wrong workspace.
   */
  async change<T>(
    caller: Caller,
    write: (tx: Prisma.TransactionClient) => Promise<T>,
    entry: LogEntry | ((result: T) => LogEntry)
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      const result = await write(tx)
      const e = typeof entry === 'function' ? entry(result) : entry
      sameWorkspace(result, e)
      await tx.dataAccessLog.create({ data: row(caller, e) })
      return result
    })
  }

  /**
   * Trusted work and the lines it leaves, in one transaction: both are kept, or neither. Call it inside
   * `runAsSystem`. `write` runs as trusted work; `refresh` re-reads the system context so a workspace `write` has
   * just made counts for the statements after it. The lines are then written as `actor` themself: the transaction
   * drops the system mark and takes the actor's own workspaces (memberships `write` gave them included), so the
   * log's own policy decides, as it does for `change`. Trusted work never writes a line in its own name.
   */
  async trusted<T>(
    actor: Actor,
    write: (tx: Prisma.TransactionClient, refresh: () => Promise<void>) => Promise<T>,
    entries: (result: T) => LogEntry[]
  ): Promise<T> {
    const ctx = tenantContext()
    if (!ctx?.allWorkspaces || ctx.userId)
      throw new Error('AccessLogService.trusted runs inside runAsSystem only')
    return this.prisma.$transaction(async (tx) => {
      const result = await write(tx, () => actAs(tx, null))
      const lines = entries(result)
      if (lines.length) {
        await actAs(tx, actor.userId)
        for (const e of lines) await tx.dataAccessLog.create({ data: row(actor, e) })
      }
      return result
    })
  }
}

/** Refuses a line whose workspace is not the one the written row belongs to. */
function sameWorkspace(result: unknown, entry: LogEntry) {
  const ws =
    result && typeof result === 'object' ? (result as { workspaceId?: unknown }).workspaceId : null
  if (typeof ws === 'string' && ws !== entry.workspaceId)
    throw new Error(
      `Access log line for workspace ${entry.workspaceId}, but the row written is in ${ws}`
    )
}

/**
 * Sets who the rest of this transaction acts as, the way PrismaService sets a query's context: `userId` for that
 * person in their own workspaces (worked out now, so memberships written earlier in the transaction count), or null
 * for trusted work (every workspace, the app.system mark). Parameterized; the values are never spliced into SQL.
 */
async function actAs(tx: Prisma.TransactionClient, userId: string | null) {
  if (userId)
    await tx.$executeRaw`SELECT set_config('app.workspace_ids', array_to_string("workspaces_of_user"(${userId}), ','), true), set_config('app.user_id', ${userId}, true), set_config('app.system', '', true)`
  else
    await tx.$executeRaw`SELECT set_config('app.workspace_ids', array_to_string("all_workspace_ids"(), ','), true), set_config('app.user_id', '', true), set_config('app.system', 'on', true)`
}

function row(actor: Actor, entry: LogEntry): Prisma.DataAccessLogUncheckedCreateInput {
  return {
    workspaceId: entry.workspaceId,
    actorId: actor.userId,
    // The column keeps its name; since 2026-10-13 it holds the person's email (staffName), never a display name.
    actorName: staffName(actor),
    resource: entry.resource,
    subjectId: entry.subjectId ?? null,
    action: entry.action,
    description: entry.description,
    changes: entry.changes?.length
      ? (entry.changes as unknown as Prisma.InputJsonValue)
      : undefined,
  }
}
