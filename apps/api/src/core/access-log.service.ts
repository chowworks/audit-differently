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
    await writeLine(this.prisma, caller, entry)
  }

  /**
   * One more line inside a `change`, on the `tx` its `write` was given: for a change that also changes other rows,
   * each with a line of its own (a budget change sends back the closed months). Kept with the change, or neither.
   */
  async also(tx: Prisma.TransactionClient, caller: Actor, entry: LogEntry): Promise<void> {
    await writeLine(tx, caller, entry)
  }

  /**
   * Makes a change and logs it in one transaction, under the caller's own row-level security: a change that fails
   * leaves no line, and a line that cannot be written undoes the change. `write` must use the `tx` it is given for
   * every write. `entry` may be worked out from what `write` returned (a new row's id, its workspaceId). When the
   * result is a row with a `workspaceId` that is not the entry's, nothing is kept: the line would be filed in the
   * wrong workspace. `timeout` lets a long change (a payroll match saving many files) run past Prisma's 5 seconds.
   * `lineFirst` writes the line before the change, for a change the database admits only once its
   * line is there (the admin's rerun of an emailed receipt, migration 20261016000100); `entry` is then fixed.
   */
  async change<T>(
    caller: Actor,
    write: (tx: Prisma.TransactionClient) => Promise<T>,
    entry: LogEntry | ((result: T) => LogEntry),
    options: { lineFirst?: boolean; timeout?: number } = {}
  ): Promise<T> {
    return this.prisma.$transaction(
      async (tx) => {
        if (options.lineFirst) {
          if (typeof entry === 'function') throw new Error('lineFirst needs a fixed entry')
          await writeLine(tx, caller, entry)
          return write(tx)
        }
        const result = await write(tx)
        const e = typeof entry === 'function' ? entry(result) : entry
        sameWorkspace(result, e)
        await writeLine(tx, caller, e)
        return result
      },
      options.timeout ? { timeout: options.timeout } : undefined
    )
  }

  /**
   * Trusted work and the lines it leaves, in one transaction: both are kept, or neither. Call it inside
   * `runAsSystem`. `write` runs as trusted work. The lines are then written as `actor` themself: the transaction
   * drops the system mark (and any admin mark) and takes the actor's own workspaces (memberships `write` gave them
   * included), so the log's own policy decides, as it does for `change`. Trusted work never writes a line in its own
   * name.
   */
  async trusted<T>(
    actor: Actor,
    write: (tx: Prisma.TransactionClient) => Promise<T>,
    entries: (result: T) => LogEntry[]
  ): Promise<T> {
    const ctx = tenantContext()
    if (!ctx?.allWorkspaces || ctx.userId)
      throw new Error('AccessLogService.trusted runs inside runAsSystem only')
    return this.prisma.$transaction(async (tx) => {
      const result = await write(tx)
      const lines = entries(result)
      if (lines.length) {
        await actAs(tx, actor.userId)
        for (const e of lines) await tx.dataAccessLog.create({ data: row(actor, e) })
      }
      return result
    })
  }
}

/**
 * Writes one line. Prisma's `create` reads the row back (RETURNING), and Postgres applies the read policy to it; the
 * platform admin may write a line in any workspace but read none (migration 20261013000200), so its lines go in with
 * `createMany`, which reads nothing back.
 */
async function writeLine(db: Prisma.TransactionClient, actor: Actor, entry: LogEntry) {
  if (tenantContext()?.admin) await db.dataAccessLog.createMany({ data: [row(actor, entry)] })
  else await db.dataAccessLog.create({ data: row(actor, entry) })
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
 * Sets who the rest of this transaction acts as, the way PrismaService sets a query's context: that person in their
 * own workspaces (worked out now, so memberships written earlier in the transaction count), never the system or the
 * admin mark. Parameterized; the values are never spliced into SQL.
 */
async function actAs(tx: Prisma.TransactionClient, userId: string) {
  await tx.$executeRaw`SELECT set_config('app.workspace_ids', array_to_string("workspaces_of_user"(${userId}), ','), true), set_config('app.user_id', ${userId}, true), set_config('app.system', '', true), set_config('app.admin', '', true)`
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
