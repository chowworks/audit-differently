import type { PGlite } from '@electric-sql/pglite'
import { APP_ROLE_FUNCTIONS, appRoleGrantsSql } from './app-role-grants'
import { TENANT_TABLES, touchesTenantTable } from './tenant-tables'
import { dbTestsEnabled, insert, migratedDb } from './testing/tenant-db'

// Tenant isolation on real Postgres, as the restricted role with exactly its privileges: the triggers that set
// a row's workspace, and the policies that keep one workspace from another.
const suite = dbTestsEnabled ? describe : describe.skip

suite('tenant isolation', () => {
  let db: PGlite

  /** Runs `fn` as the restricted API role with the given request context. */
  async function as<T>(
    ctx: { workspaces?: string[]; user?: string; system?: boolean },
    fn: () => Promise<T>
  ): Promise<T> {
    await db.exec('BEGIN')
    try {
      await db.exec('SET LOCAL ROLE ad_app')
      await db.query(
        `SELECT set_config('app.workspace_ids', $1, true), set_config('app.user_id', $2, true), set_config('app.system', $3, true)`,
        [(ctx.workspaces ?? []).join(','), ctx.user ?? '', ctx.system ? 'on' : '']
      )
      return await fn()
    } finally {
      await db.exec('ROLLBACK')
    }
  }
  /** Runs a statement that may be refused, and keeps the surrounding transaction usable. */
  const attempt = async (sql: string): Promise<{ error?: string; rows?: number }> => {
    await db.exec('SAVEPOINT attempt')
    try {
      const r = await db.query(sql)
      await db.exec('RELEASE SAVEPOINT attempt')
      return { rows: r.affectedRows }
    } catch (e) {
      await db.exec('ROLLBACK TO SAVEPOINT attempt')
      return { error: String((e as Error).message) }
    }
  }
  const ids = async (table: string) =>
    (await db.query<{ id: string }>(`SELECT id FROM "${table}" ORDER BY id`)).rows.map((r) => r.id)
  const count = async (table: string) => (await db.query(`SELECT 1 FROM "${table}"`)).rows.length
  const one = async <T extends object>(sql: string) => (await db.query<T>(sql)).rows[0]

  afterAll(() => db.close())

  beforeAll(async () => {
    db = await migratedDb()
    // The restricted role gets exactly what scripts/create-app-role.ts gives it (src/core/app-role-grants.ts).
    await db.exec(`CREATE ROLE ad_app NOLOGIN;\n${appRoleGrantsSql('ad_app').join(';\n')};`)
    // Two workspaces, each with an engagement and everything under it.
    for (const w of ['W1', 'W2']) {
      await insert(db, 'Workspace', { id: w, name: w })
      await insert(db, 'Engagement', {
        id: `E-${w}`,
        workspaceId: w,
        name: `n-${w}`,
        number: `N-${w}`,
      })
      await insert(db, 'BudgetLine', { id: `BL-${w}`, engagementId: `E-${w}`, category: 'wex' })
      await insert(db, 'MonthlyReport', { id: `R-${w}`, engagementId: `E-${w}`, period: '2026-07' })
      await insert(db, 'Expense', {
        id: `X-${w}`,
        engagementId: `E-${w}`,
        monthlyReportId: `R-${w}`,
        itemNumber: '1',
        reportLine: 'program-costs',
      })
      await insert(db, 'Document', { id: `D-${w}`, workspaceId: w, storageKey: `${w}/workspace/k` })
      await insert(db, 'ExpenseDocument', { expenseId: `X-${w}`, documentId: `D-${w}` })
      await insert(db, 'Participant', { id: `P-${w}`, engagementId: `E-${w}`, participantId: '1' })
      await insert(db, 'ParticipantDocument', { participantId: `P-${w}`, documentId: `D-${w}` })
      await insert(db, 'WexPayment', {
        id: `WX-${w}`,
        monthlyReportId: `R-${w}`,
        participantId: `P-${w}`,
      })
      await insert(db, 'WexPaymentDocument', { wexPaymentId: `WX-${w}`, documentId: `D-${w}` })
      await insert(db, 'Check', { id: `K-${w}`, monthlyReportId: `R-${w}` })
      await insert(db, 'DataAccessLog', { id: `L-${w}`, workspaceId: w, actorId: 'x' })
      await insert(db, 'Suggestion', { id: `S-${w}`, workspaceId: w, userId: 'x', text: 't' })
    }
    for (const [u, w, role] of [
      ['owner-W1', 'W1', 'owner'],
      ['book-W1', 'W1', 'bookkeeper'],
      ['aud-W1', 'W1', 'auditor'],
      ['owner-W2', 'W2', 'owner'],
    ]) {
      await insert(db, 'User', { id: u })
      await insert(db, 'Membership', { userId: u, workspaceId: w, role })
    }
    await insert(db, 'User', { id: 'nobody' })
  })

  describe('triggers', () => {
    it('set the workspace from the parent, all the way down', async () => {
      const t = async (table: string, id: string) =>
        one<{ workspaceId: string }>(
          `SELECT "workspaceId" FROM "${table}" WHERE "${table === 'ExpenseDocument' ? 'expenseId' : table === 'ParticipantDocument' ? 'participantId' : table === 'WexPaymentDocument' ? 'wexPaymentId' : 'id'}" = '${id}'`
        )
      for (const [table, id] of [
        ['BudgetLine', 'BL-W1'],
        ['MonthlyReport', 'R-W1'],
        ['Expense', 'X-W1'],
        ['ExpenseDocument', 'X-W1'],
        ['Participant', 'P-W1'],
        ['ParticipantDocument', 'P-W1'],
        ['WexPayment', 'WX-W1'],
        ['WexPaymentDocument', 'WX-W1'],
        ['Check', 'K-W1'],
      ])
        expect([table, await t(table, id)]).toEqual([table, { workspaceId: 'W1' }])
      expect(await t('Expense', 'X-W2')).toEqual({ workspaceId: 'W2' })
    })

    it('refuse a row whose parent does not exist', async () => {
      await expect(
        insert(db, 'Expense', {
          engagementId: 'E-W1',
          monthlyReportId: 'nope',
          itemNumber: '9',
          reportLine: 'wex',
        })
      ).rejects.toThrow(/Expense refers to no MonthlyReport/)
    })

    it('refuse a document that names an engagement of another workspace', async () => {
      await expect(
        insert(db, 'Document', { workspaceId: 'W1', engagementId: 'E-W2', storageKey: 'k-x' })
      ).rejects.toThrow(/another workspace/)
    })

    it('do not let a row be re-pointed at another parent', async () => {
      await expect(
        db.query(`UPDATE "Expense" SET "monthlyReportId" = 'R-W2' WHERE id = 'X-W1'`)
      ).rejects.toThrow(/Expense.monthlyReportId cannot be changed/)
      await expect(
        db.query(`UPDATE "Membership" SET "workspaceId" = 'W2' WHERE "userId" = 'book-W1'`)
      ).rejects.toThrow(/cannot be changed/)
      await expect(
        db.query(`UPDATE "Engagement" SET "workspaceId" = 'W2' WHERE id = 'E-W1'`)
      ).rejects.toThrow(/cannot be changed/)
      // Changing the tenant column directly is a no-op: the trigger recomputes it.
      await db.query(`UPDATE "Expense" SET "workspaceId" = 'W2' WHERE id = 'X-W1'`)
      expect(await one(`SELECT "workspaceId" FROM "Expense" WHERE id = 'X-W1'`)).toEqual({
        workspaceId: 'W1',
      })
    })

    it('keep a document with its own workspace', async () => {
      await expect(
        insert(db, 'ExpenseDocument', { expenseId: 'X-W1', documentId: 'D-W2' })
      ).rejects.toThrow(/does not belong to this workspace/)
      await expect(
        insert(db, 'ParticipantDocument', { participantId: 'P-W1', documentId: 'D-W2' })
      ).rejects.toThrow(/does not belong to this workspace/)
    })
  })

  describe('storage keys', () => {
    it('refuse a document whose object is not under its workspace', async () => {
      await as({ workspaces: ['W1'], user: 'owner-W1' }, async () => {
        expect(
          (
            await attempt(
              `INSERT INTO "Document" ("id","workspaceId","kind","fileName","contentType","size","sha256","storageKey","uploadedById")
               VALUES ('D-bad2','W1','invoice','f','application/pdf',1,'h','W2/workspace/k','owner-W1')`
            )
          ).error
        ).toMatch(/storage key must start with its workspace id/)
        expect(
          (
            await attempt(
              `UPDATE "Document" SET "storageKey" = 'W2/workspace/moved' WHERE id = 'D-W1'`
            )
          ).error
        ).toMatch(/storage key must start with its workspace id/)
        // The engagement segment too: an object of one engagement never files under another.
        expect(
          (
            await attempt(
              `INSERT INTO "Document" ("id","workspaceId","engagementId","kind","fileName","contentType","size","sha256","storageKey","uploadedById")
               VALUES ('D-bad3','W1','E-W1','invoice','f','application/pdf',1,'h','W1/workspace/k','owner-W1')`
            )
          ).error
        ).toMatch(/engagement id/)
        expect(
          (
            await attempt(
              `INSERT INTO "Document" ("id","workspaceId","engagementId","kind","fileName","contentType","size","sha256","storageKey","uploadedById")
               VALUES ('D-ok3','W1','E-W1','invoice','f','application/pdf',1,'h','W1/E-W1/2026-07/k','owner-W1') RETURNING id`
            )
          ).rows
        ).toBe(1)
      })
    })
  })

  describe('reading', () => {
    it('shows a member only their workspace, in every protected table', async () => {
      await as({ workspaces: ['W1'], user: 'book-W1' }, async () => {
        expect(await ids('Workspace')).toEqual(['W1'])
        expect(await ids('Engagement')).toEqual(['E-W1'])
        expect(await ids('BudgetLine')).toEqual(['BL-W1'])
        expect(await ids('MonthlyReport')).toEqual(['R-W1'])
        expect(await ids('Expense')).toEqual(['X-W1'])
        expect(await ids('Document')).toEqual(['D-W1'])
        expect(await ids('Participant')).toEqual(['P-W1'])
        expect(await ids('WexPayment')).toEqual(['WX-W1'])
        expect(await ids('Check')).toEqual(['K-W1'])
        expect(await ids('DataAccessLog')).toEqual(['L-W1'])
        expect(await ids('Suggestion')).toEqual(['S-W1'])
        expect(await ids('User')).toEqual(['aud-W1', 'book-W1', 'owner-W1'])
        for (const t of ['ExpenseDocument', 'ParticipantDocument', 'WexPaymentDocument'])
          expect(await count(t)).toBe(1)
        expect(await count('Membership')).toBe(3)
      })
      await as({ workspaces: ['W2'], user: 'owner-W2' }, async () => {
        expect(await ids('Engagement')).toEqual(['E-W2'])
        expect(await ids('User')).toEqual(['owner-W2'])
      })
    })

    it('shows nothing when there is no context (fails closed)', async () => {
      await as({}, async () => {
        for (const t of TENANT_TABLES) expect([t, await count(t)]).toEqual([t, 0])
      })
    })

    it('shows a person with no workspace only themselves', async () => {
      await as({ user: 'nobody' }, async () => {
        expect(await ids('User')).toEqual(['nobody'])
        expect(await count('Membership')).toBe(0)
      })
    })

    it('does not apply to the database owner (migrations, seeds, scripts)', async () => {
      expect(await ids('Engagement')).toEqual(['E-W1', 'E-W2'])
    })
  })

  describe('writing', () => {
    it('lets a member write in their own workspace and nowhere else', async () => {
      await as({ workspaces: ['W1'], user: 'book-W1' }, async () => {
        const row = await one<{ workspaceId: string }>(
          `INSERT INTO "Expense" ("id","engagementId","monthlyReportId","itemNumber","date","vendor","totalCost","allocatedAmount","reportLine","updatedAt")
           VALUES ('X-new','E-W1','R-W1','2','2026-07-01','v',1,1,'wex',now()) RETURNING "workspaceId"`
        )
        expect(row).toEqual({ workspaceId: 'W1' })
        expect(
          (
            await attempt(
              `INSERT INTO "Expense" ("id","engagementId","monthlyReportId","itemNumber","date","vendor","totalCost","allocatedAmount","reportLine","updatedAt")
               VALUES ('X-bad','E-W2','R-W2','3','2026-07-01','v',1,1,'wex',now())`
            )
          ).error
        ).toMatch(/row-level security/)
        expect((await attempt(`UPDATE "Expense" SET memo = 'x' WHERE id = 'X-W2'`)).rows).toBe(0)
        expect((await attempt(`DELETE FROM "Expense" WHERE id = 'X-W2'`)).rows).toBe(0)
        expect((await attempt(`UPDATE "Expense" SET memo = 'x' WHERE id = 'X-W1'`)).rows).toBe(1)
        expect(
          (
            await attempt(
              `INSERT INTO "Document" ("id","workspaceId","kind","fileName","contentType","size","sha256","storageKey","uploadedById")
               VALUES ('D-new','W1','invoice','f','application/pdf',1,'h','W1/workspace/k-new','book-W1')`
            )
          ).rows
        ).toBe(1)
        expect(
          (
            await attempt(
              `INSERT INTO "Document" ("id","workspaceId","kind","fileName","contentType","size","sha256","storageKey","uploadedById")
               VALUES ('D-bad','W2','invoice','f','application/pdf',1,'h','W2/workspace/k-bad','book-W1')`
            )
          ).error
        ).toMatch(/row-level security/)
        expect(
          (
            await attempt(
              `INSERT INTO "Engagement" ("id","workspaceId","name","updatedAt") VALUES ('E-new','W1','p',now())`
            )
          ).rows
        ).toBe(1)
        expect(
          (
            await attempt(
              `INSERT INTO "Engagement" ("id","workspaceId","name","updatedAt") VALUES ('E-bad','W2','p',now())`
            )
          ).error
        ).toMatch(/row-level security/)
      })
    })

    it('leaves creating a workspace to trusted work, and only owners change one', async () => {
      // The creator could not read it back or give themselves the first seat, so the API makes both as
      // trusted work; a signed-in person inserting one directly is refused.
      await as({ user: 'nobody' }, async () => {
        expect(
          (
            await attempt(
              `INSERT INTO "Workspace" ("id","name","updatedAt") VALUES ('W-new','new',now())`
            )
          ).error
        ).toMatch(/row-level security/)
      })
      await as({}, async () => {
        expect(
          (
            await attempt(
              `INSERT INTO "Workspace" ("id","name","updatedAt") VALUES ('W-anon','new',now())`
            )
          ).error
        ).toMatch(/row-level security/)
      })
      await as({ workspaces: ['W1'], user: 'book-W1' }, async () => {
        expect((await attempt(`UPDATE "Workspace" SET name = 'x' WHERE id = 'W1'`)).rows).toBe(0)
      })
      await as({ workspaces: ['W1'], user: 'owner-W1' }, async () => {
        expect((await attempt(`UPDATE "Workspace" SET name = 'x' WHERE id = 'W1'`)).rows).toBe(1)
        expect((await attempt(`UPDATE "Workspace" SET name = 'x' WHERE id = 'W2'`)).rows).toBe(0)
      })
    })

    it('keeps invitations in the owner hands: nobody invites themselves', async () => {
      await as({ user: 'nobody' }, async () => {
        expect(
          (
            await attempt(
              `INSERT INTO "Membership" ("id","userId","workspaceId","role") VALUES ('g1','nobody','W1','owner')`
            )
          ).error
        ).toMatch(/row-level security/)
      })
      await as({ workspaces: ['W1'], user: 'book-W1' }, async () => {
        expect(
          (
            await attempt(
              `INSERT INTO "Membership" ("id","userId","workspaceId","role") VALUES ('g2','nobody','W1','bookkeeper')`
            )
          ).error
        ).toMatch(/row-level security/)
        expect(
          (await attempt(`UPDATE "Membership" SET role = 'owner' WHERE "userId" = 'book-W1'`)).rows
        ).toBe(0)
      })
      await as({ workspaces: ['W1'], user: 'owner-W1' }, async () => {
        expect(
          (
            await attempt(
              `INSERT INTO "Membership" ("id","userId","workspaceId","role") VALUES ('g3','nobody','W1','bookkeeper')`
            )
          ).rows
        ).toBe(1)
        expect(
          (
            await attempt(
              `INSERT INTO "Membership" ("id","userId","workspaceId","role") VALUES ('g4','nobody','W2','bookkeeper')`
            )
          ).error
        ).toMatch(/row-level security/)
        expect((await attempt(`DELETE FROM "Membership" WHERE "userId" = 'owner-W2'`)).rows).toBe(0)
      })
    })

    it('lets trusted work make a person and give the first membership, and nobody else', async () => {
      // A signed-in person writes only their own row; a member cannot make a colleague's.
      await as({ workspaces: ['W1'], user: 'owner-W1' }, async () => {
        expect(
          (await attempt(`INSERT INTO "User" ("id","updatedAt") VALUES ('invited', now())`)).error
        ).toMatch(/row-level security/)
        expect((await attempt(`DELETE FROM "User" WHERE id = 'nobody'`)).rows).toBe(0)
      })
      // Trusted work (the creator of a workspace made its owner, an invitation's placeholder, its claim on
      // first sign-in): every workspace, no person, app.system on.
      await as({ workspaces: ['W1', 'W2'], system: true }, async () => {
        // RETURNING, as Prisma writes it: the row must also pass the read policy.
        expect(
          (
            await attempt(
              `INSERT INTO "User" ("id","updatedAt") VALUES ('pending-x', now()) RETURNING id`
            )
          ).rows
        ).toBe(1)
        expect(
          (
            await attempt(
              `INSERT INTO "Workspace" ("id","name","updatedAt") VALUES ('W-sys','new',now()) RETURNING id`
            )
          ).rows
        ).toBe(1)
        expect(
          (
            await attempt(
              `INSERT INTO "Membership" ("id","userId","workspaceId","role") VALUES ('sys1','pending-x','W2','bookkeeper')`
            )
          ).rows
        ).toBe(1)
        expect((await attempt(`DELETE FROM "User" WHERE id = 'pending-x'`)).rows).toBe(1)
        // Trusted work removes placeholders only.
        expect((await attempt(`DELETE FROM "User" WHERE id = 'nobody'`)).rows).toBe(0)
      })
      // Seeing every workspace is not enough on its own: without the mark, the old refusals hold.
      await as({ workspaces: ['W1', 'W2'] }, async () => {
        expect(
          (await attempt(`INSERT INTO "User" ("id","updatedAt") VALUES ('pending-y', now())`)).error
        ).toMatch(/row-level security/)
        expect(
          (
            await attempt(
              `INSERT INTO "Membership" ("id","userId","workspaceId","role") VALUES ('sys2','nobody','W2','bookkeeper')`
            )
          ).error
        ).toMatch(/row-level security/)
      })
    })

    it('works out a person workspaces from their memberships', async () => {
      const r = await one<{ a: string[]; b: string[]; n: string[] }>(
        `SELECT "workspaces_of_user"('owner-W1') AS a, "workspaces_of_user"('owner-W2') AS b, "workspaces_of_user"('nobody') AS n`
      )
      expect(r).toEqual({ a: ['W1'], b: ['W2'], n: [] })
    })

    it('lets whoever acts write the access log, lets the workspace read it, and nobody change it', async () => {
      await as({ workspaces: ['W1'], user: 'book-W1' }, async () => {
        expect(
          (
            await attempt(
              `INSERT INTO "DataAccessLog" ("id","workspaceId","actorId","actorName","resource","action") VALUES ('L-new','W1','book-W1','n','document','read')`
            )
          ).rows
        ).toBe(1)
        expect(
          (
            await attempt(
              `INSERT INTO "DataAccessLog" ("id","workspaceId","actorId","actorName","resource","action") VALUES ('L-bad','W2','book-W1','n','document','read')`
            )
          ).error
        ).toMatch(/row-level security/)
        expect(await ids('DataAccessLog')).toEqual(['L-W1', 'L-new'])
        expect((await attempt(`UPDATE "DataAccessLog" SET detail = 'x'`)).rows).toBe(0)
        expect((await attempt(`DELETE FROM "DataAccessLog"`)).rows).toBe(0)
      })
    })

    it('lets a member suggest in their own workspace, and nobody change a suggestion', async () => {
      await as({ workspaces: ['W1'], user: 'book-W1' }, async () => {
        expect(
          (
            await attempt(
              `INSERT INTO "Suggestion" ("id","workspaceId","userId","kind","text") VALUES ('S-new','W1','book-W1','list','a fund')`
            )
          ).rows
        ).toBe(1)
        expect(
          (
            await attempt(
              `INSERT INTO "Suggestion" ("id","workspaceId","userId","kind","text") VALUES ('S-bad','W2','book-W1','list','a fund')`
            )
          ).error
        ).toMatch(/row-level security/)
        expect((await attempt(`UPDATE "Suggestion" SET text = 'x'`)).rows).toBe(0)
        expect((await attempt(`DELETE FROM "Suggestion"`)).rows).toBe(0)
      })
    })
  })

  describe('deleting', () => {
    /** Runs `fn` with the database owner's privileges (to set up rows), then goes back to the restricted role. */
    const asOwner = async <T>(fn: () => Promise<T>): Promise<T> => {
      await db.exec('RESET ROLE')
      try {
        return await fn()
      } finally {
        await db.exec('SET LOCAL ROLE ad_app')
      }
    }
    const record = (id: string, ws: string, extra = '') =>
      `INSERT INTO "DeletionRecord" ("id","workspaceId","engagementId","subjectName","deletedById","deletedByName","exportKey","expiresAt"${extra ? ',"status"' : ''})
       VALUES ('${id}','${ws}','E-${ws}','n','owner-${ws}','The owner','retained/${ws}/E-${ws}-x.zip', now() + interval '30 days'${extra ? `,'${extra}'` : ''})`

    it('lets only an owner write a deletion record of their own workspace, and nobody delete one', async () => {
      await as({ workspaces: ['W1'], user: 'book-W1' }, async () => {
        expect((await attempt(record('R1', 'W1'))).error).toMatch(/row-level security/)
        expect(await count('DeletionRecord')).toBe(0)
      })
      await as({ workspaces: ['W1'], user: 'owner-W1' }, async () => {
        expect((await attempt(record('R1', 'W1'))).rows).toBe(1)
        expect((await attempt(record('R-bad', 'W2'))).error).toMatch(/row-level security/)
        expect(await ids('DeletionRecord')).toEqual(['R1'])
        expect(
          (await attempt(`UPDATE "DeletionRecord" SET status = 'downloaded' WHERE id = 'R1'`)).rows
        ).toBe(1)
        expect((await attempt(`DELETE FROM "DeletionRecord"`)).rows).toBe(0)
      })
      await asOwner(async () => {
        await db.exec(record('R-W2', 'W2'))
      })
      await as({ workspaces: ['W1'], user: 'owner-W1' }, async () => {
        expect(await ids('DeletionRecord')).toEqual([])
        expect(
          (await attempt(`UPDATE "DeletionRecord" SET status = 'downloaded' WHERE id = 'R-W2'`))
            .rows
        ).toBe(0)
      })
      await as({ workspaces: ['W1', 'W2'], user: 'aud-W1' }, async () => {
        expect(await count('DeletionRecord')).toBe(0)
      })
    })

    it('moves a deletion record forward only, and never re-points it', async () => {
      await as({ workspaces: ['W1'], user: 'owner-W1' }, async () => {
        await db.exec(record('R1', 'W1'))
        expect(
          (await attempt(`UPDATE "DeletionRecord" SET status = 'deleted' WHERE id = 'R1'`)).error
        ).toMatch(/cannot go from exported to deleted/)
        expect(
          (await attempt(`UPDATE "DeletionRecord" SET status = 'downloaded' WHERE id = 'R1'`)).rows
        ).toBe(1)
        expect(
          (await attempt(`UPDATE "DeletionRecord" SET status = 'exported' WHERE id = 'R1'`)).error
        ).toMatch(/cannot go from downloaded to exported/)
        expect(
          (await attempt(`UPDATE "DeletionRecord" SET status = 'deleted' WHERE id = 'R1'`)).rows
        ).toBe(1)
        expect(
          (await attempt(`UPDATE "DeletionRecord" SET "workspaceId" = 'W2' WHERE id = 'R1'`)).error
        ).toBeDefined()
        expect(
          (await attempt(`UPDATE "DeletionRecord" SET "exportKey" = 'x' WHERE id = 'R1'`)).error
        ).toMatch(/cannot be changed/)
        expect(
          (await attempt(`UPDATE "DeletionRecord" SET status = 'sold' WHERE id = 'R1'`)).error
        ).toBeDefined()
      })
    })

    it('lets trusted work delete a workspace and nobody else, and keeps the record and the access log', async () => {
      // One transaction (rolled back), so the context changes in place of nesting `as`.
      const switchTo = (workspaces: string[], user: string, system: boolean) =>
        db.query(
          `SELECT set_config('app.workspace_ids', $1, true), set_config('app.user_id', $2, true), set_config('app.system', $3, true)`,
          [workspaces.join(','), user, system ? 'on' : '']
        )
      await as({}, async () => {
        await asOwner(async () => {
          await insert(db, 'Workspace', { id: 'W-del', name: 'gone' })
          await insert(db, 'User', { id: 'owner-del' })
          await insert(db, 'Membership', {
            userId: 'owner-del',
            workspaceId: 'W-del',
            role: 'owner',
          })
          await insert(db, 'Suggestion', { workspaceId: 'W-del', userId: 'owner-del', text: 't' })
          await insert(db, 'Document', {
            id: 'D-del',
            workspaceId: 'W-del',
            storageKey: 'W-del/workspace/k',
          })
          await insert(db, 'DataAccessLog', { id: 'L-del', workspaceId: 'W-del', actorId: 'x' })
          await db.exec(record('R-del', 'W-del'))
        })
        // An owner of the workspace, signed in, cannot delete it; neither can a caller that sees every workspace
        // without the trusted-work mark.
        await switchTo(['W-del'], 'owner-del', false)
        expect((await attempt(`DELETE FROM "Workspace" WHERE id = 'W-del'`)).rows).toBe(0)
        await switchTo(['W-del', 'W1', 'W2'], '', false)
        expect((await attempt(`DELETE FROM "Workspace" WHERE id = 'W-del'`)).rows).toBe(0)

        await switchTo(['W-del', 'W1', 'W2'], '', true)
        // Its document still stands in the way: the API removes documents first.
        expect((await attempt(`DELETE FROM "Workspace" WHERE id = 'W-del'`)).error).toMatch(
          /foreign key|violates/
        )
        expect((await attempt(`DELETE FROM "Document" WHERE "workspaceId" = 'W-del'`)).rows).toBe(1)
        expect((await attempt(`DELETE FROM "Workspace" WHERE id = 'W-del'`)).rows).toBe(1)
        await asOwner(async () => {
          expect(await ids('Workspace')).toEqual(['W1', 'W2'])
          const left = async (t: string) =>
            (await db.query(`SELECT 1 FROM "${t}" WHERE "workspaceId" = 'W-del'`)).rows.length
          expect([await left('Membership'), await left('Suggestion')]).toEqual([0, 0])
          // They outlive the workspace: the record of the deletion and the line that says who did it.
          expect([await left('DeletionRecord'), await left('DataAccessLog')]).toEqual([1, 1])
        })
      })
    })

    it('deletes an engagement with everything under it, once its documents are gone', async () => {
      await as({ workspaces: ['W1'], user: 'owner-W1' }, async () => {
        await asOwner(async () => {
          await insert(db, 'Engagement', { id: 'E-del', workspaceId: 'W1', name: 'x', number: 'D' })
          await insert(db, 'BudgetLine', { engagementId: 'E-del', category: 'wex' })
          await insert(db, 'MonthlyReport', {
            id: 'R-del',
            engagementId: 'E-del',
            period: '2026-08',
          })
          await insert(db, 'Expense', {
            id: 'X-del',
            engagementId: 'E-del',
            monthlyReportId: 'R-del',
            itemNumber: '1',
            reportLine: 'wex',
          })
          await insert(db, 'Participant', {
            id: 'P-del',
            engagementId: 'E-del',
            participantId: '9',
          })
          await insert(db, 'WexPayment', {
            id: 'WX-del',
            monthlyReportId: 'R-del',
            participantId: 'P-del',
          })
          await insert(db, 'Check', { monthlyReportId: 'R-del', wexPaymentId: 'WX-del' })
          await insert(db, 'Document', {
            id: 'D-del',
            workspaceId: 'W1',
            engagementId: 'E-del',
            storageKey: 'W1/E-del/general/k',
          })
          await insert(db, 'ExpenseDocument', { expenseId: 'X-del', documentId: 'D-del' })
          await insert(db, 'ParticipantDocument', { participantId: 'P-del', documentId: 'D-del' })
          await insert(db, 'WexPaymentDocument', { wexPaymentId: 'WX-del', documentId: 'D-del' })
        })
        // Left to the foreign keys alone, the document is un-linked from the engagement first, and the
        // storage-key trigger refuses that. This is why the API deletes the documents before the engagement.
        expect((await attempt(`DELETE FROM "Engagement" WHERE id = 'E-del'`)).error).toMatch(
          /storage key must start with/
        )
        // The order the API uses: documents, then months (their payments), then the engagement.
        expect((await attempt(`DELETE FROM "Document" WHERE "engagementId" = 'E-del'`)).rows).toBe(
          1
        )
        expect(
          (await attempt(`DELETE FROM "MonthlyReport" WHERE "engagementId" = 'E-del'`)).rows
        ).toBe(1)
        expect((await attempt(`DELETE FROM "Engagement" WHERE id = 'E-del'`)).rows).toBe(1)
        await asOwner(async () => {
          for (const [t, left] of [
            ['BudgetLine', ['BL-W1', 'BL-W2']],
            ['MonthlyReport', ['R-W1', 'R-W2']],
            ['Expense', ['X-W1', 'X-W2']],
            ['WexPayment', ['WX-W1', 'WX-W2']],
            ['Check', ['K-W1', 'K-W2']],
          ] as const)
            expect([t, await ids(t)]).toEqual([t, left])
          for (const t of ['ExpenseDocument', 'ParticipantDocument', 'WexPaymentDocument'])
            expect([t, await count(t)]).toEqual([t, 2])
          expect(await ids('Engagement')).toEqual(['E-W1', 'E-W2'])
          expect(await ids('Participant')).toEqual(['P-W1', 'P-W2'])
          expect(await ids('Document')).toEqual(['D-W1', 'D-W2'])
        })
      })
    })
  })

  describe('the restricted role', () => {
    it('may execute only the functions the API needs', async () => {
      const r = await db.query<{ f: string }>(
        `SELECT p.oid::regprocedure::text AS f FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND has_function_privilege('ad_app', p.oid, 'EXECUTE') ORDER BY 1`
      )
      expect(r.rows.map((x) => x.f)).toEqual([...APP_ROLE_FUNCTIONS].sort())
    })

    it('cannot shadow a table with one it creates itself', async () => {
      await as({ workspaces: ['W1'] }, async () => {
        expect((await attempt(`CREATE TEMP TABLE "Engagement" (id text)`)).error).toMatch(
          /permission denied/
        )
      })
    })
  })

  it('lists exactly the tables that have a policy', async () => {
    const r = await db.query<{ tablename: string }>(
      `SELECT DISTINCT tablename FROM pg_policies WHERE policyname = 'tenant_read' ORDER BY 1`
    )
    expect(r.rows.map((x) => x.tablename)).toEqual([...TENANT_TABLES].sort())
  })
})

describe('touchesTenantTable', () => {
  it('is true for a tenant table and for a query that reaches one through a relation', () => {
    expect(touchesTenantTable('Engagement', {})).toBe(true)
    expect(touchesTenantTable('Workspace', { include: { engagements: true } })).toBe(true)
  })
  it('says yes for a model it does not know, which only costs speed', () => {
    expect(touchesTenantTable('Nope', undefined)).toBe(true)
  })
})
