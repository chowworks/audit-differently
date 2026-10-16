import type { LogEntry } from '../access-log.service'

/** Prisma delegate methods that write. */
const WRITES = ['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany']

/**
 * Runs `write` with a transaction client of its own: `tx` holds the same delegates (the spec's mocks) as `db`, but
 * while `write` runs, a write through `db` itself throws. In the real `change`, a write through `this.prisma` would
 * escape the transaction (kept when the line fails, and outside the caller's transaction context).
 */
async function inTransaction<T>(db: unknown, write: (tx: unknown) => Promise<T>): Promise<T> {
  const outer = db as Record<string, unknown>
  const tx: Record<string, unknown> = { ...outer }
  const guarded: [string, unknown][] = []
  for (const [name, delegate] of Object.entries(outer)) {
    if (!delegate || typeof delegate !== 'object') continue
    const d = delegate as Record<string, unknown>
    if (!WRITES.some((m) => typeof d[m] === 'function')) continue
    guarded.push([name, delegate])
    outer[name] = new Proxy(d, {
      get(target, method) {
        if (typeof method === 'string' && WRITES.includes(method))
          return () => {
            throw new Error(
              `${name}.${method} was written through the outer prisma inside change(); use tx`
            )
          }
        return target[method as string]
      },
    })
  }
  try {
    return await write(tx)
  } finally {
    for (const [name, delegate] of guarded) outer[name] = delegate
  }
}

/** The real `change` refuses a line filed in another workspace than the row written; so does the fake. */
function sameWorkspace(result: unknown, entry: LogEntry) {
  const ws =
    result && typeof result === 'object' ? (result as { workspaceId?: unknown }).workspaceId : null
  if (typeof ws === 'string' && ws !== entry.workspaceId)
    throw new Error(`Line for ${entry.workspaceId}, row written in ${ws}`)
}

/**
 * An AccessLogService for the specs: `change` runs the write against a transaction client made from `db` (the
 * spec's Prisma fake; see `inTransaction`) and keeps the line it would write, as `log` does. `trusted` does the same
 * for trusted work. `entries` is every line, in order; `actors` the caller of each line.
 */
export function fakeLog(db: unknown) {
  const entries: LogEntry[] = []
  const actors: unknown[] = []
  return {
    entries,
    actors,
    log: jest.fn(async (caller: unknown, entry: LogEntry) => {
      entries.push(entry)
      actors.push(caller)
    }),
    also: jest.fn(async (_tx: unknown, caller: unknown, entry: LogEntry) => {
      entries.push(entry)
      actors.push(caller)
    }),
    change: jest.fn(
      async (
        caller: unknown,
        write: (tx: unknown) => Promise<unknown>,
        entry: LogEntry | ((result: unknown) => LogEntry)
      ) => {
        const result = await inTransaction(db, write)
        const e = typeof entry === 'function' ? entry(result) : entry
        sameWorkspace(result, e)
        entries.push(e)
        actors.push(caller)
        return result
      }
    ),
    trusted: jest.fn(
      async (
        actor: unknown,
        write: (tx: unknown) => Promise<unknown>,
        lines: (result: unknown) => LogEntry[]
      ) => {
        const result = await inTransaction(db, write)
        for (const e of lines(result)) {
          entries.push(e)
          actors.push(actor)
        }
        return result
      }
    ),
  }
}

/** Fails if any of `values` (a participant's name or number, say) appears anywhere in the lines. */
export function expectNoneOf(entries: LogEntry[], values: string[]) {
  const text = JSON.stringify(entries)
  for (const v of values) expect(text).not.toContain(v)
}
