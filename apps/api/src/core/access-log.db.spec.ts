import type { PGlite } from '@electric-sql/pglite'
import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import { AccessLogService, type LogEntry } from './access-log.service'
import { appRoleGrantsSql } from './app-role-grants'
import type { Caller } from './caller'
import { runAsSystem, withTenantContext } from './tenant-context'
import { dbTestsEnabled, insert, migratedDb } from './testing/tenant-db'

// AccessLogService on real Postgres, through the real PrismaService and its tenant proxy, as the restricted role
// with exactly its privileges. Prisma's own engine cannot reach PGlite, so the client under the proxy is a thin
// stand-in that runs each statement on PGlite: the context statement the proxy sends, and the inserts.
const suite = dbTestsEnabled ? describe : describe.skip

type Row = Record<string, string | number | boolean | null>

suite('AccessLogService on Postgres', () => {
  let db: PGlite
  let prisma: PrismaService
  let log: AccessLogService

  /** A statement as Prisma hands it over: a Prisma.sql object, or a tagged template's parts. */
  const sqlOf = (args: unknown[]): Prisma.Sql => {
    const [first, ...rest] = args
    return Array.isArray(first)
      ? Prisma.sql(first as readonly string[], ...rest)
      : (first as Prisma.Sql)
  }
  const run = async (args: unknown[]) => {
    const q = sqlOf(args)
    return (await db.query(q.text, q.values as never[])).rows
  }
  /**
   * `tx.<model>.create({ data })` as one INSERT ... RETURNING, the way Prisma writes it; `createMany` as a plain INSERT
   * that reads nothing back.
   */
  const client = new Proxy(
    {
      $executeRaw: async (...args: unknown[]) => (await run(args), 1),
      $queryRaw: (...args: unknown[]) => run(args),
    } as Record<string, unknown>,
    {
      get(target, prop) {
        if (typeof prop !== 'string' || prop in target) return target[prop as string]
        const table = prop[0]!.toUpperCase() + prop.slice(1)
        const toRow = (data: Record<string, unknown>) => {
          const row: Row = {}
          for (const [k, v] of Object.entries(data)) {
            if (v === undefined) continue
            row[k] =
              v instanceof Date
                ? v.toISOString()
                : typeof v === 'object' && v !== null
                  ? JSON.stringify(v)
                  : (v as Row[string])
          }
          return row
        }
        return {
          create: ({ data }: { data: Record<string, unknown> }) => insert(db, table, toRow(data)),
          createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
            for (const d of data) {
              const row = { id: randomUUID(), ...toRow(d) }
              const names = Object.keys(row)
              await db.query(
                `INSERT INTO "${table}" (${names.map((n) => `"${n}"`).join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')})`,
                names.map((n) => row[n as keyof typeof row])
              )
            }
            return { count: data.length }
          },
        }
      },
    }
  )

  /** Every statement of the client runs in a transaction as the restricted role, as the API's connection does. */
  async function asApp<T>(fn: () => Promise<T>): Promise<T> {
    await db.exec('BEGIN')
    try {
      await db.exec('SET LOCAL ROLE ad_app')
      const out = await fn()
      await db.exec('COMMIT')
      return out
    } catch (e) {
      await db.exec('ROLLBACK')
      throw e
    }
  }

  const rows = async (sql: string) => (await db.query<Row>(sql)).rows
  const caller = (userId: string, workspaceId: string): Caller => ({
    userId,
    displayName: 'A Display Name',
    email: `${userId}@example.org`,
    memberships: [{ workspaceId, workspaceName: workspaceId, role: 'bookkeeper' }],
    workspaceIds: [workspaceId],
  })
  const suggestion = (workspaceId: string, userId: string, text: string) => ({
    data: { workspaceId, userId, kind: 'list', text },
  })
  const line = (workspaceId: string, description: string): LogEntry => ({
    workspaceId,
    resource: 'workspace',
    action: 'create',
    description,
    changes: [{ field: 'Suggestion' }],
  })

  beforeAll(async () => {
    db = await migratedDb()
    await db.exec(`CREATE ROLE ad_app NOLOGIN;\n${appRoleGrantsSql('ad_app').join(';\n')};`)
    for (const w of ['W1', 'W2']) await insert(db, 'Workspace', { id: w, name: `Team ${w}` })
    for (const [u, w, role] of [
      ['book-W1', 'W1', 'bookkeeper'],
      ['owner-W2', 'W2', 'owner'],
    ]) {
      await insert(db, 'User', { id: u, email: `${u}@example.org` })
      await insert(db, 'Membership', { userId: u, workspaceId: w, role })
    }
    await insert(db, 'User', { id: 'newbie', email: 'newbie@example.org' })
    await insert(db, 'User', { id: 'admin-1', email: 'admin@example.org' })

    prisma = new PrismaService()
    const target = prisma as unknown as Record<string, unknown>
    target.$connect = async () => undefined
    // The real startup check, run as the restricted role: it finds the role binds row-level security.
    target.$queryRawUnsafe = (sql: string, ...values: unknown[]) =>
      asApp(async () => (await db.query(sql, values as never[])).rows)
    target.$transaction = (fn: (tx: unknown) => Promise<unknown>) => asApp(() => fn(client))
    await prisma.onModuleInit()
    log = new AccessLogService(prisma)
  })

  afterAll(() => db.close())

  it('writes the change and its line under the caller’s own context', async () => {
    const who = caller('book-W1', 'W1')
    let seen: Row | undefined
    await withTenantContext(
      () =>
        log.change(
          who,
          async (tx) => {
            ;[seen] =
              (await tx.$queryRaw`SELECT current_user AS role, current_setting('app.user_id', true) AS "userId", current_setting('app.workspace_ids', true) AS workspaces, current_setting('app.system', true) AS system`) as Row[]
            return tx.suggestion.create(suggestion('W1', who.userId, 'A youth fund'))
          },
          (made) => line(made.workspaceId, 'Suggested an addition to the lists')
        ),
      { userId: who.userId }
    )
    expect(seen).toEqual({ role: 'ad_app', userId: 'book-W1', workspaces: 'W1', system: '' })
    expect(
      await rows(`SELECT "workspaceId" FROM "Suggestion" WHERE text = 'A youth fund'`)
    ).toEqual([{ workspaceId: 'W1' }])
    expect(
      await rows(
        `SELECT "workspaceId", "actorId", "actorName", description, changes FROM "DataAccessLog" WHERE description = 'Suggested an addition to the lists'`
      )
    ).toEqual([
      {
        workspaceId: 'W1',
        actorId: 'book-W1',
        actorName: 'book-W1@example.org',
        description: 'Suggested an addition to the lists',
        changes: [{ field: 'Suggestion' }],
      },
    ])
  })

  it('undoes the change when its line is refused', async () => {
    const who = caller('book-W1', 'W1')
    // The row is in W1, the line names W2, where the caller is not a member: the log's policy refuses it.
    await expect(
      withTenantContext(
        () =>
          log.change(
            who,
            async (tx) => (await tx.suggestion.create(suggestion('W1', who.userId, 'Unlogged'))).id,
            line('W2', 'A line in the wrong workspace')
          ),
        { userId: who.userId }
      )
    ).rejects.toThrow(/row-level security/)
    expect(await rows(`SELECT 1 FROM "Suggestion" WHERE text = 'Unlogged'`)).toEqual([])
    expect(
      await rows(
        `SELECT 1 FROM "DataAccessLog" WHERE description = 'A line in the wrong workspace'`
      )
    ).toEqual([])
  })

  it('undoes the change when the line names another workspace than the row written', async () => {
    const who = caller('owner-W2', 'W2')
    // The line's workspace comes from code; the row says W2, so the change is refused before anything is kept.
    await expect(
      withTenantContext(
        () =>
          log.change(
            who,
            (tx) => tx.suggestion.create(suggestion('W2', who.userId, 'Misfiled')),
            line('W1', 'Misfiled line')
          ),
        { userId: who.userId }
      )
    ).rejects.toThrow(/row written is in W2/)
    expect(await rows(`SELECT 1 FROM "Suggestion" WHERE text = 'Misfiled'`)).toEqual([])
  })

  it('refuses a change outside the caller’s workspaces, with no line', async () => {
    const who = caller('owner-W2', 'W2')
    await expect(
      withTenantContext(
        () =>
          log.change(
            who,
            (tx) => tx.suggestion.create(suggestion('W1', who.userId, 'Intruder')),
            line('W1', 'Intruder line')
          ),
        { userId: who.userId }
      )
    ).rejects.toThrow(/row-level security/)
    expect(await rows(`SELECT 1 FROM "Suggestion" WHERE text = 'Intruder'`)).toEqual([])
  })

  describe('trusted', () => {
    const newbie = { userId: 'newbie', email: 'newbie@example.org' }
    const join = (workspaceId: string, lineIn: string) =>
      runAsSystem(() =>
        log.trusted(
          newbie,
          (tx) =>
            tx.membership.create({ data: { userId: 'newbie', workspaceId, role: 'auditor' } }),
          () => [
            {
              workspaceId: lineIn,
              resource: 'member',
              subjectId: 'newbie',
              action: 'create',
              description: `Joined Team ${lineIn} as auditor`,
              changes: [{ field: 'Role', after: 'Auditor' }],
            },
          ]
        )
      )

    it('writes the lines as the person, so a line outside their workspaces undoes the work', async () => {
      // Trusted work could write in W2; the person, a member of W1 only, may not.
      await expect(join('W1', 'W2')).rejects.toThrow(/row-level security/)
      expect(await rows(`SELECT 1 FROM "Membership" WHERE "userId" = 'newbie'`)).toEqual([])
    })

    it('keeps the membership and its line together', async () => {
      await join('W1', 'W1')
      expect(
        await rows(`SELECT "workspaceId", role FROM "Membership" WHERE "userId" = 'newbie'`)
      ).toEqual([{ workspaceId: 'W1', role: 'auditor' }])
      expect(
        await rows(
          `SELECT "workspaceId", "actorId", "actorName" FROM "DataAccessLog" WHERE description = 'Joined Team W1 as auditor'`
        )
      ).toEqual([{ workspaceId: 'W1', actorId: 'newbie', actorName: 'newbie@example.org' }])
    })
  })

  describe('the platform admin', () => {
    const admin = { userId: 'admin-1', email: 'admin@example.org' }
    const asAdmin = <T>(fn: () => Promise<T>) =>
      withTenantContext(fn, { userId: admin.userId, admin: true })

    it('creates a workspace with its first owner and the line in one change, under its own flag', async () => {
      let seen: Row | undefined
      await asAdmin(() =>
        log.change(
          admin,
          async (tx) => {
            ;[seen] =
              (await tx.$queryRaw`SELECT current_setting('app.user_id', true) AS "userId", current_setting('app.system', true) AS system, current_setting('app.admin', true) AS admin`) as Row[]
            const w = await tx.workspace.create({ data: { id: 'W-adm', name: 'Riverbend' } })
            await tx.user.create({ data: { id: 'pending-pat', email: 'pat@example.org' } })
            await tx.membership.create({
              data: { userId: 'pending-pat', workspaceId: 'W-adm', role: 'owner' },
            })
            return w
          },
          (w) => ({
            workspaceId: w.id as string,
            resource: 'workspace',
            subjectId: w.id as string,
            action: 'create',
            description: 'Created the workspace Riverbend with first owner pat@example.org',
          })
        )
      )
      expect(seen).toEqual({ userId: 'admin-1', system: '', admin: 'on' })
      expect(
        await rows(`SELECT "termsVersion", "termsAcceptedById" FROM "Workspace" WHERE id = 'W-adm'`)
      ).toEqual([{ termsVersion: null, termsAcceptedById: null }])
      expect(
        await rows(`SELECT "userId", role FROM "Membership" WHERE "workspaceId" = 'W-adm'`)
      ).toEqual([{ userId: 'pending-pat', role: 'owner' }])
      // The line is in the new workspace, in the admin's name, though the admin may not read it back.
      expect(
        await rows(
          `SELECT "actorId", "actorName", description FROM "DataAccessLog" WHERE "workspaceId" = 'W-adm'`
        )
      ).toEqual([
        {
          actorId: 'admin-1',
          actorName: 'admin@example.org',
          description: 'Created the workspace Riverbend with first owner pat@example.org',
        },
      ])
    })

    it('names itself by its account, and cannot commit a change to people whose line went elsewhere', async () => {
      // The line says W1 while the seat is in W2; the write returns no workspace for `change` to compare, so only the
      // database's commit-time check (Membership_9_admin_logged) stands between this and an unlogged seat.
      await expect(
        asAdmin(() =>
          log.change(
            { userId: admin.userId, email: 'not-me@example.org' },
            async (tx) => {
              await tx.membership.create({
                data: { userId: 'newbie', workspaceId: 'W2', role: 'owner' },
              })
              return { ok: true }
            },
            {
              workspaceId: 'W1',
              resource: 'member',
              action: 'create',
              description: 'A line in the wrong workspace (by a platform admin)',
            }
          )
        )
      ).rejects.toThrow(/without a line in its access log/)
      expect(
        await rows(`SELECT 1 FROM "Membership" WHERE "userId" = 'newbie' AND "workspaceId" = 'W2'`)
      ).toEqual([])
      expect(
        await rows(`SELECT 1 FROM "DataAccessLog" WHERE description LIKE 'A line in the wrong%'`)
      ).toEqual([])
    })

    it('without its flag, the same person creates nothing', async () => {
      await expect(
        withTenantContext(
          () =>
            log.change(
              admin,
              (tx) => tx.workspace.create({ data: { id: 'W-noflag', name: 'x' } }),
              (w) => ({
                workspaceId: w.id as string,
                resource: 'workspace',
                action: 'create',
                description: 'x',
              })
            ),
          { userId: admin.userId }
        )
      ).rejects.toThrow(/row-level security/)
      expect(await rows(`SELECT 1 FROM "Workspace" WHERE id = 'W-noflag'`)).toEqual([])
    })
  })
})
