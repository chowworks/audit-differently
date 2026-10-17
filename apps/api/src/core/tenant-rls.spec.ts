import type { PGlite } from '@electric-sql/pglite'
import { APP_ROLE_FUNCTIONS, appRoleGrantsSql } from './app-role-grants'
import { TENANT_TABLES, touchesTenantTable } from './tenant-tables'
import { CLAIM_SQL, EXPIRE_SQL, MAX_ATTEMPTS } from '../inbound/inbound.service'
import { MAX_READ_ATTEMPTS, READ_CLAIM_SQL } from '../payroll/payroll-match.worker'
import { dbTestsEnabled, insert, migratedDb } from './testing/tenant-db'

// Tenant isolation on real Postgres, as the restricted role with exactly its privileges: the triggers that set
// a row's workspace, and the policies that keep one workspace from another.
const suite = dbTestsEnabled ? describe : describe.skip

suite('tenant isolation', () => {
  let db: PGlite

  /** Runs `fn` as the restricted API role with the given request context. */
  async function as<T>(
    ctx: { workspaces?: string[]; user?: string; system?: boolean; admin?: boolean },
    fn: () => Promise<T>
  ): Promise<T> {
    await db.exec('BEGIN')
    try {
      await db.exec('SET LOCAL ROLE ad_app')
      await db.query(
        `SELECT set_config('app.workspace_ids', $1, true), set_config('app.user_id', $2, true), set_config('app.system', $3, true), set_config('app.admin', $4, true)`,
        [
          (ctx.workspaces ?? []).join(','),
          ctx.user ?? '',
          ctx.system ? 'on' : '',
          ctx.admin ? 'on' : '',
        ]
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
      await insert(db, 'ReportReopening', {
        id: `RO-${w}`,
        monthlyReportId: `R-${w}`,
        reopenedById: `owner-${w}`,
      })
      await insert(db, 'DataAccessLog', { id: `L-${w}`, workspaceId: w, actorId: 'x' })
      await insert(db, 'Suggestion', { id: `S-${w}`, workspaceId: w, userId: 'x', text: 't' })
      await insert(db, 'ImportMapping', {
        id: `IM-${w}`,
        workspaceId: w,
        name: 'QuickBooks mapping',
      })
      await insert(db, 'InboundReceipt', {
        id: `IR-${w}`,
        emailId: `email-${w}`,
        workspaceId: w,
        fromAddress: `book@${w}.example.org`,
        toAddress: `${w.toLowerCase()}@receipts.example.org`,
        receivedAt: '2026-09-15T12:00:00Z',
      })
      // So that "sees no row" of these means something: each workspace has a deletion record and its owner an
      // acceptance of the Terms.
      await insert(db, 'DeletionRecord', {
        id: `DR-${w}`,
        workspaceId: w,
        engagementId: `E-${w}`,
        exportKey: `retained/${w}/E-${w}-fixture.zip`,
      })
      await insert(db, 'TermsAcceptance', {
        id: `TA-${w}`,
        userId: `owner-${w}`,
        fingerprint: 'v0',
      })
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
    // An emailed receipt whose address is not known yet: trusted work's alone.
    await insert(db, 'InboundReceipt', {
      id: 'IR-none',
      emailId: 'email-none',
      toAddress: 'nobody-here@receipts.example.org',
      receivedAt: '2026-09-15T12:00:00Z',
    })
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
        ['ReportReopening', 'RO-W1'],
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
        expect(await ids('ReportReopening')).toEqual(['RO-W1'])
        expect(await ids('DataAccessLog')).toEqual(['L-W1'])
        expect(await ids('Suggestion')).toEqual(['S-W1'])
        expect(await ids('ImportMapping')).toEqual(['IM-W1'])
        expect(await ids('InboundReceipt')).toEqual(['IR-W1'])
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
        // Tags (migration 20261015000500) ride the same line: another workspace's records are not there.
        expect(
          (await attempt(`UPDATE "Expense" SET tags = '{site:north}' WHERE id = 'X-W2'`)).rows
        ).toBe(0)
        expect(
          (await attempt(`UPDATE "Expense" SET tags = '{site:north}' WHERE id = 'X-W1'`)).rows
        ).toBe(1)
        expect(
          (
            await attempt(
              `UPDATE "Participant" SET tags = '{age-group:under-18}' WHERE "workspaceId" = 'W2'`
            )
          ).rows
        ).toBe(0)
        expect(
          (
            await attempt(
              `UPDATE "WexPayment" SET tags = '{age-group:under-18}' WHERE "workspaceId" = 'W2'`
            )
          ).rows
        ).toBe(0)
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

    it('leaves creating a workspace to the platform admin, and only owners change one', async () => {
      // A signed-in person inserting one directly is refused, and so is trusted work (migration 20261013000200).
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

    it("keeps the first owner's Terms record once it is on file, and lets the owner rename around it", async () => {
      const terms = (id: string, by: string) =>
        `UPDATE "Workspace" SET "termsVersion" = 'v1', "termsAcceptedAt" = now(), "termsAcceptedById" = '${by}' WHERE id = '${id}'`
      await as({ workspaces: ['W1'], user: 'owner-W1' }, async () => {
        // The first acceptance is recorded (MeController), then kept.
        expect((await attempt(terms('W1', 'owner-W1'))).rows).toBe(1)
        expect((await attempt(terms('W1', 'book-W1'))).error).toMatch(
          /Terms accepted by the first owner/
        )
        expect(
          (await attempt(`UPDATE "Workspace" SET "termsAcceptedById" = NULL WHERE id = 'W1'`)).error
        ).toMatch(/Terms accepted by the first owner/)
        expect(
          (await attempt(`UPDATE "Workspace" SET "termsVersion" = 'v2' WHERE id = 'W1'`)).error
        ).toMatch(/Terms accepted by the first owner/)
        // A rename touches none of it.
        expect(
          (await attempt(`UPDATE "Workspace" SET name = 'Riverbend' WHERE id = 'W1' RETURNING id`))
            .rows
        ).toBe(1)
        // The database owner (migrations, scripts) may still correct it.
        await db.exec('RESET ROLE')
        expect((await attempt(terms('W1', 'book-W1'))).rows).toBe(1)
        await db.exec('SET LOCAL ROLE ad_app')
      })
    })

    it('leaves the full demo mark to the demo seed: no owner or admin sets or clears it (migration 20261016001700)', async () => {
      await as({ workspaces: ['W1'], user: 'owner-W1' }, async () => {
        expect(
          (await attempt(`UPDATE "Workspace" SET "featuredDemo" = true WHERE id = 'W1'`)).error
        ).toMatch(/Only the demo seed/)
        // The owner's other changes go through.
        expect(
          (await attempt(`UPDATE "Workspace" SET name = 'W1 renamed' WHERE id = 'W1'`)).rows
        ).toBe(1)
      })
      await as({ user: 'admin-1', admin: true }, async () => {
        expect(
          (
            await attempt(
              `INSERT INTO "Workspace" ("id","name","updatedAt","featuredDemo") VALUES ('W-demo','Demo',now(),true)`
            )
          ).error
        ).toMatch(/Only the demo seed/)
        expect(
          (
            await attempt(
              `INSERT INTO "Workspace" ("id","name","updatedAt") VALUES ('W-new','New',now())`
            )
          ).rows
        ).toBe(1)
      })
      // The database owner (the seed) sets and clears it.
      await db.exec(`UPDATE "Workspace" SET "featuredDemo" = true WHERE id = 'W2'`)
      await as({ workspaces: ['W2'], user: 'owner-W2' }, async () => {
        expect(
          (await attempt(`UPDATE "Workspace" SET "featuredDemo" = false WHERE id = 'W2'`)).error
        ).toMatch(/Only the demo seed/)
        expect(
          (await attempt(`UPDATE "Workspace" SET name = 'W2 again' WHERE id = 'W2'`)).rows
        ).toBe(1)
      })
      await db.exec(`UPDATE "Workspace" SET "featuredDemo" = false WHERE id = 'W2'`)
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
        // Trusted work no longer creates a workspace: the platform admin does (migration 20261013000200).
        expect(
          (
            await attempt(
              `INSERT INTO "Workspace" ("id","name","updatedAt") VALUES ('W-sys','new',now()) RETURNING id`
            )
          ).error
        ).toMatch(/row-level security/)
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
        // A change's line: what was done, and the fields it touched (migration 20261013000100); just as fixed.
        expect(
          (
            await attempt(
              `INSERT INTO "DataAccessLog" ("id","workspaceId","actorId","actorName","resource","action","description","changes") VALUES ('L-change','W1','book-W1','n','expense','update','Changed ledger line RYS-1','[{"field":"Total cost","before":"100.00","after":"120.00"},{"field":"Vendor"}]')`
            )
          ).rows
        ).toBe(1)
        expect(
          (await attempt(`UPDATE "DataAccessLog" SET changes = '[]', description = 'x'`)).rows
        ).toBe(0)
        expect(
          await one<{ n: number }>(
            `SELECT jsonb_array_length(changes) AS n FROM "DataAccessLog" WHERE id = 'L-change'`
          )
        ).toEqual({ n: 2 })
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

  describe('importing transactions (migration 20261015000600)', () => {
    it('lets a member save and change a mapping in their own workspace, and nobody remove one', async () => {
      await as({ workspaces: ['W1'], user: 'book-W1' }, async () => {
        expect(
          (
            await attempt(
              `INSERT INTO "ImportMapping" ("id","workspaceId","name","updatedAt") VALUES ('IM-new','W1','Bank download',now()) RETURNING id`
            )
          ).rows
        ).toBe(1)
        expect(
          (
            await attempt(
              `INSERT INTO "ImportMapping" ("id","workspaceId","name","updatedAt") VALUES ('IM-bad','W2','Bank download',now())`
            )
          ).error
        ).toMatch(/row-level security/)
        expect(
          (await attempt(`UPDATE "ImportMapping" SET "headers" = '{Date}' WHERE id = 'IM-W2'`)).rows
        ).toBe(0)
        expect(
          (await attempt(`UPDATE "ImportMapping" SET "headers" = '{Date}' WHERE id = 'IM-W1'`)).rows
        ).toBe(1)
        expect((await attempt(`DELETE FROM "ImportMapping"`)).rows).toBe(0)
        expect(
          (await attempt(`UPDATE "ImportMapping" SET "columns" = '[]' WHERE id = 'IM-W1'`)).error
        ).toMatch(/columns_check/)
      })
      await expect(
        db.query(`UPDATE "ImportMapping" SET "workspaceId" = 'W2' WHERE id = 'IM-W1'`)
      ).rejects.toThrow(/ImportMapping.workspaceId cannot be changed/)
    })

    it('makes an imported row once per engagement: the fingerprint is unique', async () => {
      await as({ workspaces: ['W1'], user: 'book-W1' }, async () => {
        const row = (id: string, item: string) =>
          `INSERT INTO "Expense" ("id","engagementId","monthlyReportId","itemNumber","date","vendor","totalCost","allocatedAmount","reportLine","importFingerprint","updatedAt")
           VALUES ('${id}','E-W1','R-W1','${item}','2026-07-01','v',1,1,'program-costs','fp-1',now())`
        expect((await attempt(row('X-imp1', 'IMP-1'))).rows).toBe(1)
        expect((await attempt(row('X-imp2', 'IMP-2'))).error).toMatch(/importFingerprint/)
      })
    })
  })

  describe('budget lines (migration 20261017000200)', () => {
    it("ties an expense to its own engagement's budget line, whose form line it takes", async () => {
      await as({ workspaces: ['W1'], user: 'owner-W1' }, async () => {
        await insert(db, 'BudgetLine', {
          id: 'BL-sup',
          engagementId: 'E-W1',
          name: 'Supplies',
          reportLine: 'program-costs',
        })
        await insert(db, 'BudgetLine', {
          id: 'BL-sal',
          engagementId: 'E-W1',
          name: 'Personnel',
          reportLine: 'staff-salaries',
        })
        // Names are the engagement's own, once each, whatever the case.
        expect(
          (
            await attempt(
              `INSERT INTO "BudgetLine" ("id","engagementId","name","reportLine","amount") VALUES ('BL-dup','E-W1',' supplies ','program-costs',0)`
            )
          ).error
        ).toMatch(/BudgetLine_engagementId_name_key/)
        await db.query(`UPDATE "Expense" SET "budgetLineId" = 'BL-sal' WHERE id = 'X-W1'`)
        expect(await one(`SELECT "reportLine" FROM "Expense" WHERE id = 'X-W1'`)).toEqual({
          reportLine: 'staff-salaries',
        })
        // Another engagement's line is refused (and, here, not even visible).
        expect(
          (await attempt(`UPDATE "Expense" SET "budgetLineId" = 'BL-W2' WHERE id = 'X-W1'`)).error
        ).toMatch(/its own engagement/)
        // A line with spending keeps its form line and is not removed; one without spending changes freely.
        expect(
          (await attempt(`UPDATE "BudgetLine" SET "reportLine" = 'wex' WHERE id = 'BL-sal'`)).error
        ).toMatch(/keeps the report line/)
        expect(
          (await attempt(`UPDATE "BudgetLine" SET "reportLine" = 'wex' WHERE id = 'BL-sup'`)).rows
        ).toBe(1)
        expect((await attempt(`DELETE FROM "BudgetLine" WHERE id = 'BL-sal'`)).error).toMatch(
          /Expense_budgetLineId_fkey/
        )
        // Deleting the month takes its expenses, and then the line can go.
        await db.query(`DELETE FROM "MonthlyReport" WHERE id = 'R-W1'`)
        expect((await attempt(`DELETE FROM "BudgetLine" WHERE id = 'BL-sal'`)).rows).toBe(1)
      })
    })
  })

  describe('emailed receipts (migration 20261015001000)', () => {
    const queued = (id: string, ws = 'NULL') =>
      `INSERT INTO "InboundReceipt" ("id","emailId","workspaceId","toAddress","receivedAt") VALUES ('${id}','email-${id}',${ws},'${id.toLowerCase()}@receipts.example.org',now()) RETURNING id`

    it('keeps a row with no workspace to trusted work: members never see, write or claim it', async () => {
      for (const ctx of [
        { workspaces: ['W1'], user: 'owner-W1' },
        { workspaces: ['W1'], user: 'book-W1' },
        { workspaces: ['W2'], user: 'owner-W2' },
        {},
      ]) {
        await as(ctx, async () => {
          expect(await ids('InboundReceipt')).not.toContain('IR-none')
          expect((await attempt(queued('IR-m'))).error).toMatch(/row-level security/)
          expect((await attempt(queued('IR-m2', "'W1'"))).error).toMatch(/row-level security/)
          expect(
            (await attempt(`UPDATE "InboundReceipt" SET status = 'failed' WHERE id = 'IR-none'`))
              .rows
          ).toBe(0)
          expect((await attempt(`DELETE FROM "InboundReceipt"`)).rows).toBe(0)
        })
      }
    })

    it('lets trusted work queue a row, say once whose it is, and claim what is due', async () => {
      await as({ workspaces: ['W1', 'W2'], system: true }, async () => {
        expect((await attempt(queued('IR-sys'))).rows).toBe(1)
        // The webhook's idempotency: one row per provider email id.
        expect(
          (
            await attempt(
              `INSERT INTO "InboundReceipt" ("id","emailId","receivedAt") VALUES ('IR-dup','email-IR-sys',now())`
            )
          ).error
        ).toMatch(/emailId/)
        // Only a row with no workspace may be inserted, even by trusted work.
        expect((await attempt(queued('IR-sys2', "'W1'"))).error).toMatch(/row-level security/)
        // Whose it is: the workspace only together with its verified sender (migration 20261015001200).
        expect(
          (await attempt(`UPDATE "InboundReceipt" SET "workspaceId" = 'W1' WHERE id = 'IR-sys'`))
            .error
        ).toMatch(/only with its verified sender/)
        expect(
          (
            await attempt(
              `UPDATE "InboundReceipt" SET "workspaceId" = 'W1', "senderUserId" = 'book-W1' WHERE id = 'IR-sys'`
            )
          ).rows
        ).toBe(1)
        expect(
          (await attempt(`UPDATE "InboundReceipt" SET "workspaceId" = 'W2' WHERE id = 'IR-sys'`))
            .error
        ).toMatch(/workspaceId cannot be changed/)
        expect(
          (await attempt(`UPDATE "InboundReceipt" SET "subject" = 'x' WHERE id = 'IR-sys'`)).error
        ).toMatch(/cannot be changed/)
        // An API set up for another receipts domain (a second laptop on the shared dev database) claims none of them.
        expect(
          (await db.query(CLAIM_SQL, [10, MAX_ATTEMPTS, 'other.example.org'])).rows
        ).toHaveLength(0)
        // The worker's claim: parameterized, SKIP LOCKED, counts the attempt and leases the row.
        const claimed = await db.query<{ id: string; status: string; attempts: number }>(
          CLAIM_SQL,
          [10, MAX_ATTEMPTS, 'receipts.example.org']
        )
        expect(claimed.rows.map((r) => r.id).sort()).toEqual([
          'IR-W1',
          'IR-W2',
          'IR-none',
          'IR-sys',
        ])
        expect(claimed.rows.every((r) => r.status === 'processing' && r.attempts === 1)).toBe(true)
        // Leased: nothing more is due.
        expect(
          (await db.query(CLAIM_SQL, [10, MAX_ATTEMPTS, 'receipts.example.org'])).rows
        ).toHaveLength(0)
        // Only a row with no workspace, or one refused or failed for good, may be removed.
        expect((await attempt(`DELETE FROM "InboundReceipt" WHERE id = 'IR-W1'`)).rows).toBe(0)
        expect((await attempt(`DELETE FROM "InboundReceipt" WHERE id = 'IR-none'`)).rows).toBe(1)
        await db.query(`UPDATE "InboundReceipt" SET status = 'rejected' WHERE id = 'IR-W1'`)
        await db.query(`UPDATE "InboundReceipt" SET status = 'failed' WHERE id = 'IR-W2'`)
        expect((await attempt(`DELETE FROM "InboundReceipt" WHERE id = 'IR-W1'`)).rows).toBe(1)
        expect((await attempt(`DELETE FROM "InboundReceipt" WHERE id = 'IR-W2'`)).rows).toBe(1)
      })
    })

    it('dismisses only a receipt that needs filing, and keeps it dismissed (migration 20261017000100)', async () => {
      await as({ workspaces: ['W1'], user: 'owner-W1' }, async () => {
        await db.query(`UPDATE "InboundReceipt" SET status = 'failed' WHERE id = 'IR-W1'`)
        expect(
          (await attempt(`UPDATE "InboundReceipt" SET status = 'dismissed' WHERE id = 'IR-W1'`))
            .error
        ).toMatch(/needs filing/)
        await db.query(`UPDATE "InboundReceipt" SET status = 'unmatched' WHERE id = 'IR-W1'`)
        expect(
          (await attempt(`UPDATE "InboundReceipt" SET status = 'dismissed' WHERE id = 'IR-W1'`))
            .rows
        ).toBe(1)
        expect(
          (await attempt(`UPDATE "InboundReceipt" SET status = 'received' WHERE id = 'IR-W1'`))
            .error
        ).toMatch(/stays dismissed/)
      })
      // The clean-up removes it, as it does a refused one.
      await as({ workspaces: ['W1', 'W2'], system: true }, async () => {
        await db.query(`UPDATE "InboundReceipt" SET status = 'unmatched' WHERE id = 'IR-W1'`)
        await db.query(`UPDATE "InboundReceipt" SET status = 'dismissed' WHERE id = 'IR-W1'`)
        expect((await attempt(`DELETE FROM "InboundReceipt" WHERE id = 'IR-W1'`)).rows).toBe(1)
      })
    })

    it('never claims a row past its last attempt, fails one a crash left behind, and never claims a hand filing', async () => {
      await as({ workspaces: ['W1', 'W2'], system: true }, async () => {
        await db.query(
          `UPDATE "InboundReceipt" SET status = 'processing', attempts = $1, "nextAttemptAt" = (now() AT TIME ZONE 'UTC') - interval '1 hour' WHERE id = 'IR-W1'`,
          [MAX_ATTEMPTS]
        )
        await db.query(
          `UPDATE "InboundReceipt" SET status = 'filing', "nextAttemptAt" = (now() AT TIME ZONE 'UTC') + interval '1 hour' WHERE id = 'IR-W2'`
        )
        await db.query(`UPDATE "InboundReceipt" SET status = 'filed' WHERE id = 'IR-none'`)
        expect(
          (await db.query(CLAIM_SQL, [10, MAX_ATTEMPTS, 'receipts.example.org'])).rows
        ).toHaveLength(0)
        await db.query(EXPIRE_SQL, [MAX_ATTEMPTS, 'stopped', 'no address'])
        expect(await one(`SELECT status, error FROM "InboundReceipt" WHERE id = 'IR-W1'`)).toEqual({
          status: 'failed',
          error: 'stopped',
        })
        // A hand filing is the person's until its lease runs out; then it goes back to them.
        expect(await one(`SELECT status FROM "InboundReceipt" WHERE id = 'IR-W2'`)).toEqual({
          status: 'filing',
        })
        await db.query(
          `UPDATE "InboundReceipt" SET "nextAttemptAt" = (now() AT TIME ZONE 'UTC') - interval '1 minute' WHERE id = 'IR-W2'`
        )
        await db.query(EXPIRE_SQL, [MAX_ATTEMPTS, 'stopped', 'no address'])
        expect(await one(`SELECT status FROM "InboundReceipt" WHERE id = 'IR-W2'`)).toEqual({
          status: 'unmatched',
        })
        expect(
          (await db.query(CLAIM_SQL, [10, MAX_ATTEMPTS, 'receipts.example.org'])).rows
        ).toHaveLength(0)
      })
    })

    it('ends a row queued with no receipts address after a day, and leaves one for another domain', async () => {
      await insert(db, 'InboundReceipt', {
        id: 'IR-noto',
        emailId: 'email-noto',
        receivedAt: '2026-09-15T12:00:00Z',
        createdAt: '2026-09-15T12:00:00Z',
      })
      await insert(db, 'InboundReceipt', {
        id: 'IR-noto-new',
        emailId: 'email-noto-new',
        receivedAt: '2026-09-15T12:00:00Z',
      })
      await insert(db, 'InboundReceipt', {
        id: 'IR-other',
        emailId: 'email-other',
        toAddress: 'w9@other.example.org',
        receivedAt: '2026-09-15T12:00:00Z',
        createdAt: '2026-09-15T12:00:00Z',
      })
      try {
        await as({ workspaces: ['W1', 'W2'], system: true }, async () => {
          await db.query(EXPIRE_SQL, [MAX_ATTEMPTS, 'stopped', 'no address'])
          expect(
            (
              await db.query(
                `SELECT id, status, error FROM "InboundReceipt" WHERE id IN ('IR-noto', 'IR-noto-new', 'IR-other') ORDER BY id`
              )
            ).rows
          ).toEqual([
            { id: 'IR-noto', status: 'failed', error: 'no address' },
            { id: 'IR-noto-new', status: 'received', error: null },
            { id: 'IR-other', status: 'received', error: null },
          ])
        })
      } finally {
        await db.exec(
          `DELETE FROM "InboundReceipt" WHERE id IN ('IR-noto', 'IR-noto-new', 'IR-other')`
        )
      }
    })

    it('shows a workspace its own rows, and lets a member change what became of one, never whose it is', async () => {
      await as({ workspaces: ['W1'], user: 'book-W1' }, async () => {
        expect(await ids('InboundReceipt')).toEqual(['IR-W1'])
        expect(
          (await attempt(`UPDATE "InboundReceipt" SET status = 'received' WHERE id = 'IR-W2'`)).rows
        ).toBe(0)
        expect(
          (
            await attempt(
              `UPDATE "InboundReceipt" SET status = 'received', "engagementId" = 'E-W1' WHERE id = 'IR-W1'`
            )
          ).rows
        ).toBe(1)
        expect(
          (
            await attempt(
              `UPDATE "InboundReceipt" SET "senderUserId" = 'book-W1' WHERE id = 'IR-W1'`
            )
          ).error
        ).toMatch(/Only trusted work/)
        expect(
          (
            await attempt(
              `UPDATE "InboundReceipt" SET "fromAddress" = 'x@y.org' WHERE id = 'IR-W1'`
            )
          ).error
        ).toMatch(/cannot be changed/)
        expect(
          (await attempt(`UPDATE "InboundReceipt" SET status = 'lost' WHERE id = 'IR-W1'`)).error
        ).toMatch(/status_check/)
        expect((await attempt(`DELETE FROM "InboundReceipt" WHERE id = 'IR-W1'`)).rows).toBe(0)
        // Nor one refused for good: removing rows is trusted work's purge.
        await attempt(`UPDATE "InboundReceipt" SET status = 'rejected' WHERE id = 'IR-W1'`)
        expect((await attempt(`DELETE FROM "InboundReceipt" WHERE id = 'IR-W1'`)).rows).toBe(0)
        // The engagement it names is one of its own workspace, whatever the caller may write.
        expect(
          (await attempt(`UPDATE "InboundReceipt" SET "engagementId" = 'E-W2' WHERE id = 'IR-W1'`))
            .error
        ).toMatch(/engagement of its workspace/)
        expect(
          (
            await attempt(
              `UPDATE "InboundReceipt" SET "engagementId" = 'E-none' WHERE id = 'IR-W1'`
            )
          ).error
        ).toMatch(/engagement of its workspace/)
      })
      await as({ workspaces: ['W1', 'W2'], system: true }, async () => {
        expect(
          (await attempt(`UPDATE "InboundReceipt" SET "engagementId" = 'E-W2' WHERE id = 'IR-W1'`))
            .error
        ).toMatch(/engagement of its workspace/)
        expect(
          (
            await attempt(
              `UPDATE "InboundReceipt" SET "engagementId" = 'E-W1' WHERE id = 'IR-none'`
            )
          ).error
        ).toMatch(/engagement of its workspace/)
      })
    })

    it('clears the engagement and the documents of a row when its engagement is deleted', async () => {
      await insert(db, 'Engagement', {
        id: 'E-W1del',
        workspaceId: 'W1',
        name: 'del',
        number: 'N-del',
      })
      await insert(db, 'InboundReceipt', {
        id: 'IR-del',
        emailId: 'email-del',
        workspaceId: 'W1',
        senderUserId: 'book-W1',
        engagementId: 'E-W1del',
        documentIds: '{D-gone}',
        status: 'filed',
        receivedAt: '2026-09-15T12:00:00Z',
      })
      try {
        await as({ workspaces: ['W1'], user: 'owner-W1' }, async () => {
          expect((await attempt(`DELETE FROM "Engagement" WHERE id = 'E-W1del'`)).rows).toBe(1)
          expect(
            await one(
              `SELECT "engagementId", "documentIds", status FROM "InboundReceipt" WHERE id = 'IR-del'`
            )
          ).toEqual({ engagementId: null, documentIds: [], status: 'filed' })
        })
      } finally {
        await db.query(`DELETE FROM "InboundReceipt" WHERE id = 'IR-del'`)
        await db.query(`DELETE FROM "Engagement" WHERE id = 'E-W1del'`)
      }
    })

    it('keeps a receipts address unique and well formed, and an engagement code unique in its workspace', async () => {
      await db.query(`UPDATE "Workspace" SET "receiptsAddress" = 'bright-path' WHERE id = 'W1'`)
      await db.query(`UPDATE "Engagement" SET "code" = 'CP26' WHERE id = 'E-W1'`)
      try {
        await as({ workspaces: ['W1'], user: 'owner-W1' }, async () => {
          // Set once, then kept: never moved to another address or cleared through the API.
          for (const to of [`'bright-path-2'`, 'NULL'])
            expect(
              (await attempt(`UPDATE "Workspace" SET "receiptsAddress" = ${to} WHERE id = 'W1'`))
                .error
            ).toMatch(/once set, is kept/)
          expect(
            (await attempt(`UPDATE "Engagement" SET "code" = 'cp26' WHERE id = 'E-W1'`)).error
          ).toMatch(/code_check/)
          expect(
            (
              await attempt(
                `INSERT INTO "Engagement" ("id","workspaceId","name","code","updatedAt") VALUES ('E-W1b','W1','b','CP26',now())`
              )
            ).error
          ).toMatch(/code/)
        })
        await as({ workspaces: ['W2'], user: 'owner-W2' }, async () => {
          expect(
            (
              await attempt(
                `UPDATE "Workspace" SET "receiptsAddress" = 'Bright Path' WHERE id = 'W2'`
              )
            ).error
          ).toMatch(/receiptsAddress_check/)
          expect(
            (
              await attempt(
                `UPDATE "Workspace" SET "receiptsAddress" = 'bright-path' WHERE id = 'W2'`
              )
            ).error
          ).toMatch(/receiptsAddress_key/)
          expect(
            (await attempt(`UPDATE "Engagement" SET "code" = 'CP26' WHERE id = 'E-W2'`)).rows
          ).toBe(1)
        })
      } finally {
        await db.query(`UPDATE "Workspace" SET "receiptsAddress" = NULL WHERE id = 'W1'`)
        await db.query(`UPDATE "Engagement" SET "code" = NULL WHERE id = 'E-W1'`)
      }
    })
  })

  describe('payroll proof marks (migration 20261015000800)', () => {
    it('keeps a mark only on a payroll proof link, on a payroll file, with a page and a box', async () => {
      const was = await one<{ kind: string; sensitivity: string }>(
        `SELECT kind, sensitivity FROM "Document" WHERE id = 'D-W1'`
      )
      await db.exec(
        `UPDATE "Document" SET kind = 'bank-statement', sensitivity = 'financial' WHERE id = 'D-W1'`
      )
      await insert(db, 'Document', {
        id: 'D-stub-W1',
        workspaceId: 'W1',
        kind: 'paystub',
        sensitivity: 'personal',
        storageKey: 'W1/workspace/stub',
      })
      await insert(db, 'Document', {
        id: 'D-elig-W1',
        workspaceId: 'W1',
        kind: 'eligibility-record',
        sensitivity: 'personal',
        storageKey: 'W1/workspace/elig',
      })
      const mark = (m: object) => `'${JSON.stringify(m)}'::jsonb`
      const box = { page: 2, x: 48, y: 677, width: 520, height: 14.4, text: 'PAYPEOPLE' }
      try {
        await as({ workspaces: ['W1'], user: 'book-W1' }, async () => {
          const set = (table: string, key: string, m: string, purpose = 'payment') =>
            attempt(
              `UPDATE "${table}" SET purpose = '${purpose}', mark = ${m} WHERE "${key}" LIKE '%-W1' AND "documentId" = 'D-W1'`
            )
          expect((await set('ExpenseDocument', 'expenseId', mark(box))).rows).toBe(1)
          expect((await set('WexPaymentDocument', 'wexPaymentId', mark(box))).rows).toBe(1)
          expect((await set('ExpenseDocument', 'expenseId', mark(box), 'invoice')).error).toMatch(
            /mark_check/
          )
          for (const bad of [
            { ...box, page: 0 },
            { ...box, page: 1.5 },
            { ...box, width: 0 },
            { ...box, height: -1 },
            { page: 1, x: 1 },
            { ...box, text: 'x'.repeat(301) },
          ])
            expect((await set('ExpenseDocument', 'expenseId', mark(bad))).error).toMatch(
              /mark_check|invalid input/
            )
          // Migrations 20261016001100 and ..1200: a timesheet or register link carries its line too, and so does a
          // pay stub, text and all; an eligibility record is never marked.
          expect((await set('ExpenseDocument', 'expenseId', mark(box), 'timesheet')).rows).toBe(1)
          expect(
            (await set('WexPaymentDocument', 'wexPaymentId', mark(box), 'register')).rows
          ).toBe(1)
          const markOn = (doc: string) =>
            attempt(
              `INSERT INTO "ExpenseDocument" ("expenseId","documentId","purpose","mark") VALUES ('X-W1','${doc}','payment',${mark(box)})`
            )
          expect((await markOn('D-stub-W1')).rows).toBe(1)
          expect((await markOn('D-elig-W1')).error).toMatch(/payroll file only/)
        })
      } finally {
        // The marks were written in a transaction `as` rolls back; the documents are put back as they were.
        await db.exec(`DELETE FROM "Document" WHERE id IN ('D-stub-W1', 'D-elig-W1')`)
        await db.query(`UPDATE "Document" SET kind = $1, sensitivity = $2 WHERE id = 'D-W1'`, [
          was!.kind,
          was!.sensitivity,
        ])
      }
    })
  })

  describe('month lock (migration 20261015001100)', () => {
    /** `insert`, refused or not, keeping the surrounding transaction usable. */
    const tryInsert = async (table: string, values: Record<string, string>) => {
      await db.exec('SAVEPOINT attempt')
      try {
        await insert(db, table, values)
        await db.exec('RELEASE SAVEPOINT attempt')
        return {}
      } catch (e) {
        await db.exec('ROLLBACK TO SAVEPOINT attempt')
        return { error: String((e as Error).message) }
      }
    }

    for (const status of ['closed', 'submitted'])
      it(`adds, changes and removes no line, payroll item or proof in a ${status} month (migration 20261016001700)`, async () => {
        await as({ workspaces: ['W1'], user: 'book-W1' }, async () => {
          await db.exec(`UPDATE "MonthlyReport" SET status = '${status}' WHERE id = 'R-W1'`)
          for (const sql of [
            `UPDATE "Expense" SET vendor = 'v2' WHERE id = 'X-W1'`,
            `UPDATE "ExpenseDocument" SET purpose = 'invoice' WHERE "expenseId" = 'X-W1'`,
            `UPDATE "WexPayment" SET tags = ARRAY['t'] WHERE id = 'WX-W1'`,
            `UPDATE "WexPaymentDocument" SET purpose = 'register' WHERE "wexPaymentId" = 'WX-W1'`,
          ])
            expect((await attempt(sql)).error).toMatch(/month_locked/)
          // Removing is a change too (migration 20261016001700).
          for (const sql of [
            `DELETE FROM "ExpenseDocument" WHERE "expenseId" = 'X-W1'`,
            `DELETE FROM "WexPaymentDocument" WHERE "wexPaymentId" = 'WX-W1'`,
            `DELETE FROM "Expense" WHERE id = 'X-W1'`,
            `DELETE FROM "WexPayment" WHERE id = 'WX-W1'`,
          ])
            expect((await attempt(sql)).error).toMatch(/month_locked/)
          expect(
            (await tryInsert('ExpenseDocument', { expenseId: 'X-W1', documentId: 'D-W1' })).error
          ).toMatch(/month_locked/)
          expect(
            (await tryInsert('WexPaymentDocument', { wexPaymentId: 'WX-W1', documentId: 'D-W1' }))
              .error
          ).toMatch(/month_locked/)
          const line = {
            engagementId: 'E-W1',
            monthlyReportId: 'R-W1',
            itemNumber: '2',
            reportLine: 'program-costs',
          }
          expect((await tryInsert('Expense', line)).error).toMatch(/month_locked/)
          expect(
            (await tryInsert('WexPayment', { monthlyReportId: 'R-W1', participantId: 'P-W1' }))
              .error
          ).toMatch(/month_locked/)
          // A draft again (sent back): the same lines go in, and come out.
          await db.exec(`UPDATE "MonthlyReport" SET status = 'draft' WHERE id = 'R-W1'`)
          expect((await tryInsert('Expense', line)).error).toBeUndefined()
          expect(
            (await tryInsert('WexPayment', { monthlyReportId: 'R-W1', participantId: 'P-W1' }))
              .error
          ).toBeUndefined()
          expect(
            (await attempt(`DELETE FROM "ExpenseDocument" WHERE "expenseId" = 'X-W1'`)).rows
          ).toBe(1)
          expect((await attempt(`DELETE FROM "WexPayment" WHERE id = 'WX-W1'`)).rows).toBe(1)
          expect((await attempt(`DELETE FROM "Expense" WHERE id = 'X-W1'`)).rows).toBe(1)
        })
      })

    it('removes the links of a document deleted in a submitted month, and a submitted month with its lines', async () => {
      await as({ workspaces: ['W1'], user: 'owner-W1' }, async () => {
        await db.exec(`UPDATE "MonthlyReport" SET status = 'submitted' WHERE id = 'R-W1'`)
        // The document's own delete takes its links with it (the API refuses it in a locked month first).
        expect((await attempt(`DELETE FROM "Document" WHERE id = 'D-W1'`)).rows).toBe(1)
        expect(await count('ExpenseDocument')).toBe(0)
        expect(await count('WexPaymentDocument')).toBe(0)
        // The month's own delete takes its lines and payroll items with it.
        expect((await attempt(`DELETE FROM "MonthlyReport" WHERE id = 'R-W1'`)).rows).toBe(1)
        expect(await ids('Expense')).toEqual([])
        expect(await ids('WexPayment')).toEqual([])
      })
    })

    it('changes a line in a draft month', async () => {
      await as({ workspaces: ['W1'], user: 'book-W1' }, async () => {
        expect((await attempt(`UPDATE "Expense" SET vendor = 'v2' WHERE id = 'X-W1'`)).rows).toBe(1)
        expect(
          (
            await attempt(
              `UPDATE "WexPaymentDocument" SET purpose = 'register' WHERE "wexPaymentId" = 'WX-W1'`
            )
          ).rows
        ).toBe(1)
      })
    })

    it('takes lines again in a submitted month once it is reopened (migration 20261015001400)', async () => {
      await as({ workspaces: ['W1'], user: 'book-W1' }, async () => {
        await db.exec(
          `UPDATE "MonthlyReport" SET status = 'submitted', "submittedAt" = now() WHERE id = 'R-W1'`
        )
        const line = {
          engagementId: 'E-W1',
          monthlyReportId: 'R-W1',
          itemNumber: '3',
          reportLine: 'program-costs',
        }
        expect((await tryInsert('Expense', line)).error).toMatch(/month_locked/)
        // The row change `ReportsService.reopen` makes, as the restricted role.
        expect(
          (
            await attempt(
              `UPDATE "MonthlyReport" SET status = 'draft', "submittedAt" = NULL, "authorizedByName" = NULL,
                 "authorizedAt" = NULL, "closingNote" = NULL WHERE id = 'R-W1'`
            )
          ).rows
        ).toBe(1)
        expect((await tryInsert('Expense', line)).error).toBeUndefined()
        expect((await attempt(`UPDATE "Expense" SET vendor = 'v3' WHERE id = 'X-W1'`)).rows).toBe(1)
      })
    })
  })

  describe('reopening history (migration 20261015001500)', () => {
    const reopening = (id: string, month: string, by: string) =>
      `INSERT INTO "ReportReopening" ("id","monthlyReportId","reopenedById","reopenedByEmail","reason","submittedAt")
       VALUES ('${id}','${month}','${by}','${by}@example.org','Typo in a vendor', now())`

    it('lets a member add a reopening of their own workspace, in their own name only', async () => {
      await as({ workspaces: ['W1'], user: 'book-W1' }, async () => {
        expect((await attempt(reopening('RO-new', 'R-W1', 'book-W1'))).rows).toBe(1)
        expect(
          await one(`SELECT "workspaceId" FROM "ReportReopening" WHERE id = 'RO-new'`)
        ).toEqual({ workspaceId: 'W1' })
        // In someone else's name, or on another workspace's month: refused.
        expect((await attempt(reopening('RO-x', 'R-W1', 'owner-W1'))).error).toMatch(
          /row-level security/
        )
        expect((await attempt(reopening('RO-y', 'R-W2', 'book-W1'))).error).toMatch(
          /row-level security/
        )
        expect((await attempt(reopening('RO-z', 'nope', 'book-W1'))).error).toMatch(
          /refers to no MonthlyReport/
        )
      })
    })

    it('shows the history to every member, auditors too, and to no other workspace', async () => {
      await as({ workspaces: ['W1'], user: 'aud-W1' }, async () => {
        expect(await ids('ReportReopening')).toEqual(['RO-W1'])
      })
      await as({ workspaces: ['W2'], user: 'owner-W2' }, async () => {
        expect(await ids('ReportReopening')).toEqual(['RO-W2'])
        expect((await attempt(`UPDATE "ReportReopening" SET reason = 'x'`)).rows).toBe(0)
      })
    })

    it('lets nobody change or remove a reopening, not even an owner of its workspace', async () => {
      await as({ workspaces: ['W1'], user: 'owner-W1' }, async () => {
        expect(
          (await attempt(`UPDATE "ReportReopening" SET reason = 'Changed' WHERE id = 'RO-W1'`)).rows
        ).toBe(0)
        expect(
          (
            await attempt(
              `UPDATE "ReportReopening" SET "signedDocumentId" = NULL WHERE id = 'RO-W1'`
            )
          ).rows
        ).toBe(0)
        expect((await attempt(`DELETE FROM "ReportReopening" WHERE id = 'RO-W1'`)).rows).toBe(0)
      })
      await as({ system: true }, async () => {
        expect((await attempt(`DELETE FROM "ReportReopening"`)).rows).toBe(0)
      })
      expect(await one(`SELECT reason FROM "ReportReopening" WHERE id = 'RO-W1'`)).toEqual({
        reason: 'x',
      })
      // Even the database owner cannot move one to another month.
      await expect(
        db.query(`UPDATE "ReportReopening" SET "monthlyReportId" = 'R-W2' WHERE id = 'RO-W1'`)
      ).rejects.toThrow(/ReportReopening.monthlyReportId cannot be changed/)
    })

    it('keeps a reason of 1 to 500 characters', async () => {
      await as({ workspaces: ['W1'], user: 'book-W1' }, async () => {
        for (const reason of ['', 'x'.repeat(501)])
          expect(
            (
              await attempt(
                `INSERT INTO "ReportReopening" ("id","monthlyReportId","reopenedById","reopenedByEmail","reason","submittedAt")
                 VALUES ('RO-bad','R-W1','book-W1','b@example.org','${reason}', now())`
              )
            ).error
          ).toMatch(/ReportReopening_reason_check/)
      })
    })
  })

  describe('payroll match runs (migration 20261016001000)', () => {
    const run = (id: string, month: string, by: string) =>
      `INSERT INTO "PayrollMatchRun" ("id","monthlyReportId","createdById") VALUES ('${id}','${month}','${by}')`
    const file = (
      id: string,
      runId: string,
      key: string,
      kind = 'paystub',
      sensitivity = 'personal'
    ) =>
      `INSERT INTO "PayrollMatchFile" ("id","runId","kind","sensitivity","fileName","contentType","size","sha256","storageKey")
       VALUES ('${id}','${runId}','${kind}','${sensitivity}','a.pdf','application/pdf',1,'h','${key}')`

    it("starts a run in the caller's own name, on their own workspace's month only", async () => {
      await as({ workspaces: ['W1'], user: 'book-W1' }, async () => {
        expect((await attempt(run('PR-1', 'R-W1', 'book-W1'))).rows).toBe(1)
        expect(await one(`SELECT "workspaceId" FROM "PayrollMatchRun" WHERE id = 'PR-1'`)).toEqual({
          workspaceId: 'W1',
        })
        expect((await attempt(run('PR-x', 'R-W1', 'owner-W1'))).error).toMatch(/row-level security/)
        expect((await attempt(run('PR-y', 'R-W2', 'book-W1'))).error).toMatch(/row-level security/)
        expect((await attempt(file('PF-1', 'PR-1', 'W1/E-W1/2026-07/a.pdf'))).rows).toBe(1)
        expect(await one(`SELECT "workspaceId" FROM "PayrollMatchFile" WHERE id = 'PF-1'`)).toEqual(
          {
            workspaceId: 'W1',
          }
        )
        // A staged object outside the workspace's own keys: refused.
        expect((await attempt(file('PF-x', 'PR-1', 'W2/E-W2/2026-07/a.pdf'))).error).toMatch(
          /PayrollMatchFile_key_check|in its month's folder/
        )
        // Or outside its run's month folder (migration 20261016001700): another engagement, another month, a
        // folder below it, or no name at all.
        for (const key of [
          'W1/E-W2/2026-07/a.pdf',
          'W1/E-W1/2026-08/a.pdf',
          'W1/E-W1/2026-07/x/a.pdf',
          'W1/E-W1/2026-07/',
          'W1/workspace/2026-07/a.pdf',
        ])
          expect([key, (await attempt(file('PF-k', 'PR-1', key))).error]).toEqual([
            key,
            expect.stringMatching(/in its month's folder/),
          ])
        // A pay stub is personal and every other payroll file financial, as its document will be.
        expect(
          (await attempt(file('PF-s1', 'PR-1', 'W1/E-W1/2026-07/b.pdf', 'paystub', 'financial')))
            .error
        ).toMatch(/sensitivity_check/)
        expect(
          (await attempt(file('PF-s2', 'PR-1', 'W1/E-W1/2026-07/c.pdf', 'timesheet', 'personal')))
            .error
        ).toMatch(/sensitivity_check/)
        expect(
          (await attempt(file('PF-s3', 'PR-1', 'W1/E-W1/2026-07/d.pdf', 'timesheet', 'financial')))
            .rows
        ).toBe(1)
        expect(
          (await attempt(file('PF-s4', 'PR-1', 'W1/E-W1/2026-07/e.pdf', 'w2-form', 'financial')))
            .error
        ).toMatch(/kind_check/)
        expect((await attempt(`UPDATE "PayrollMatchFile" SET "fileName" = 'b.pdf'`)).rows).toBe(0)
      })
    })

    it('shows a run and its files to their workspace alone, and lets a member remove them', async () => {
      await insert(db, 'PayrollMatchRun', {
        id: 'PR-1',
        monthlyReportId: 'R-W1',
        createdById: 'book-W1',
      })
      await insert(db, 'PayrollMatchFile', {
        id: 'PF-1',
        runId: 'PR-1',
        kind: 'paystub',
        sensitivity: 'personal',
        storageKey: 'W1/E-W1/2026-07/a.pdf',
      })
      await as({ workspaces: ['W2'], user: 'owner-W2' }, async () => {
        expect(await ids('PayrollMatchRun')).toEqual([])
        expect(await ids('PayrollMatchFile')).toEqual([])
        expect((await attempt(`DELETE FROM "PayrollMatchRun"`)).rows).toBe(0)
        // Another workspace's run is out of sight, so the file cannot hang off it.
        expect((await attempt(file('PF-z', 'PR-1', 'W2/E-W2/2026-07/a.pdf'))).error).toMatch(
          /row-level security|refers to no PayrollMatchRun/
        )
      })
      await as({ workspaces: ['W1'], user: 'aud-W1' }, async () => {
        expect(await ids('PayrollMatchFile')).toEqual(['PF-1'])
      })
      await as({ workspaces: ['W1'], user: 'owner-W1' }, async () => {
        expect((await attempt(`DELETE FROM "PayrollMatchRun" WHERE id = 'PR-1'`)).rows).toBe(1)
        expect(await ids('PayrollMatchFile')).toEqual([])
      })
      await db.exec(`DELETE FROM "PayrollMatchRun"`)
    })
  })

  describe('payroll match job (migration 20261016001300)', () => {
    it('claims only the files of its own storage, and those staged before files said which (migration 20261016001700)', async () => {
      await insert(db, 'PayrollMatchRun', {
        id: 'PR-C',
        monthlyReportId: 'R-W1',
        createdById: 'book-W1',
      })
      for (const [id, storage] of [
        ['PF-mine', 'r2:mine'],
        ['PF-theirs', 'r2:theirs'],
        ['PF-old', null],
      ] as const)
        await insert(db, 'PayrollMatchFile', {
          id,
          runId: 'PR-C',
          kind: 'timesheet',
          sensitivity: 'financial',
          storageKey: `W1/E-W1/2026-07/${id}.pdf`,
          storage,
        })
      try {
        await as({ system: true, workspaces: ['W1', 'W2'] }, async () => {
          const claimed = await db.query<{ id: string }>(READ_CLAIM_SQL, [
            10,
            MAX_READ_ATTEMPTS,
            'r2:mine',
          ])
          expect(claimed.rows.map((r) => r.id).sort()).toEqual(['PF-mine', 'PF-old'])
          // The job never moves a file to another storage.
          expect(
            (
              await attempt(
                `UPDATE "PayrollMatchFile" SET storage = 'r2:mine' WHERE id = 'PF-theirs'`
              )
            ).error
          ).toMatch(/changes only what was read/)
        })
      } finally {
        await db.exec(`DELETE FROM "PayrollMatchRun" WHERE id = 'PR-C'`)
      }
    })

    it('lets trusted work fill in what it read, and change nothing else; members change nothing', async () => {
      await insert(db, 'PayrollMatchRun', {
        id: 'PR-J',
        monthlyReportId: 'R-W1',
        createdById: 'book-W1',
      })
      await insert(db, 'PayrollMatchFile', {
        id: 'PF-J',
        runId: 'PR-J',
        kind: 'timesheet',
        sensitivity: 'financial',
        storageKey: 'W1/E-W1/2026-07/t.pdf',
      })
      try {
        expect(await one(`SELECT status FROM "PayrollMatchFile" WHERE id = 'PF-J'`)).toEqual({
          status: 'waiting',
        })
        await as({ workspaces: ['W1'], user: 'owner-W1' }, async () => {
          expect((await attempt(`UPDATE "PayrollMatchFile" SET status = 'read'`)).rows).toBe(0)
        })
        // Trusted work sees every workspace, as runAsSystem sets it.
        await as({ system: true, workspaces: ['W1', 'W2'] }, async () => {
          expect(
            (
              await attempt(
                `UPDATE "PayrollMatchFile" SET status = 'read', attempts = 1, pages = 2, lines = '[]' WHERE id = 'PF-J'`
              )
            ).rows
          ).toBe(1)
          expect(
            (await attempt(`UPDATE "PayrollMatchFile" SET "fileName" = 'x.pdf' WHERE id = 'PF-J'`))
              .error
          ).toMatch(/changes only what was read/)
          expect(
            (await attempt(`UPDATE "PayrollMatchFile" SET status = 'done' WHERE id = 'PF-J'`)).error
          ).toMatch(/status_check/)
        })
      } finally {
        await db.exec(`DELETE FROM "PayrollMatchRun" WHERE id = 'PR-J'`)
      }
    })
  })

  describe('payroll highlights (migration 20261016001400)', () => {
    it("keeps a proof link's highlights to up to 20 well-formed boxes, on a payroll file", async () => {
      const was = await one<{ kind: string; sensitivity: string }>(
        `SELECT kind, sensitivity FROM "Document" WHERE id = 'D-W1'`
      )
      await db.exec(
        `UPDATE "Document" SET kind = 'timesheet', sensitivity = 'financial' WHERE id = 'D-W1'`
      )
      const box = { page: 1, x: 10, y: 20, width: 30, height: 12, text: 'Jordan Sample' }
      const set = (marks: unknown, purpose = 'timesheet') =>
        attempt(
          `UPDATE "ExpenseDocument" SET purpose = '${purpose}', marks = '${JSON.stringify(marks)}'::jsonb WHERE "expenseId" = 'X-W1'`
        )
      try {
        await as({ workspaces: ['W1'], user: 'book-W1' }, async () => {
          expect((await set([box, { ...box, x: 50 }])).rows).toBe(1)
          // A box with no words, and one with 300 characters, are fine.
          expect((await set([{ page: 2, x: 0, y: 0, width: 1, height: 1 }])).rows).toBe(1)
          expect((await set([{ ...box, text: 'x'.repeat(300) }])).rows).toBe(1)
          expect((await set([box], 'invoice')).error).toMatch(/marks_check/)
          for (const bad of [
            [{ ...box, page: 0 }],
            [{ ...box, width: 0 }],
            [{ page: 1, x: 1 }],
            [{ ...box, text: 'x'.repeat(301) }],
            // Strict about each element (migration 20261016001700): not a nested array, and text only a string.
            [[{ page: 1, x: 0, y: 0, width: 1, height: 1 }]],
            [{ ...box, text: ['Jordan Sample'] }],
            [{ ...box, page: '1' }],
            [5],
            Array.from({ length: 21 }, () => box),
            { not: 'an array' },
          ])
            expect((await set(bad)).error).toMatch(/marks_check|non-array/)
        })
        await db.exec(
          `UPDATE "Document" SET kind = 'eligibility-record', sensitivity = 'personal' WHERE id = 'D-W1'`
        )
        await as({ workspaces: ['W1'], user: 'book-W1' }, async () => {
          expect((await set([box], 'payment')).error).toMatch(/payroll file only/)
        })
      } finally {
        await db.query(`UPDATE "Document" SET kind = $1, sensitivity = $2 WHERE id = 'D-W1'`, [
          was!.kind,
          was!.sensitivity,
        ])
      }
    })

    it('lets only a platform admin add a highlight setting, in their own name, and nobody change one', async () => {
      const add = (by: string, fields = "ARRAY['name','amount']") =>
        attempt(
          `INSERT INTO "HighlightSetting" ("id","kind","fields","changedById") VALUES (gen_random_uuid()::text,'paystub',${fields},'${by}')`
        )
      await as({ workspaces: ['W1'], user: 'owner-W1' }, async () => {
        expect((await add('owner-W1')).error).toMatch(/row-level security/)
      })
      await as({ user: 'admin-1', admin: true }, async () => {
        expect((await add('admin-1')).rows).toBe(1)
        expect((await add('owner-W1')).error).toMatch(/row-level security/)
        expect((await add('admin-1', "ARRAY['nope']")).error).toMatch(/fields_check/)
        expect((await attempt(`UPDATE "HighlightSetting" SET fields = ARRAY['row']`)).rows).toBe(0)
        expect((await attempt(`DELETE FROM "HighlightSetting"`)).rows).toBe(0)
      })
      await as({ workspaces: ['W1'], user: 'book-W1' }, async () => {
        // Rolled back with the admin's transaction: a member reads the table, empty here.
        expect((await db.query(`SELECT count(*)::int AS n FROM "HighlightSetting"`)).rows).toEqual([
          { n: 0 },
        ])
      })
    })
  })

  describe('matching statistics (migration 20261016001500)', () => {
    const stat = (id: string, ws: string, feature = 'payroll', outcome = 'saved', by = 'book-W1') =>
      `INSERT INTO "MatchRunStat" ("id","workspaceId","feature","startedById","startedByEmail","startedAt","outcome")
       VALUES ('${id}','${ws}','${feature}','${by}','book@example.org',now(),'${outcome}')`

    it('lets a member write a row of their own workspace only, and read none back unless an owner', async () => {
      await as({ workspaces: ['W1'], user: 'book-W1' }, async () => {
        expect((await attempt(stat('MS-1', 'W1'))).rows).toBe(1)
        expect((await attempt(stat('MS-x', 'W2'))).error).toMatch(/row-level security/)
        // A bookkeeper writes it and does not read it.
        expect(await count('MatchRunStat')).toBe(0)
        expect((await attempt(stat('MS-2', 'W1', 'payroll', 'done'))).error).toMatch(
          /outcome_check/
        )
        expect((await attempt(stat('MS-3', 'W1', 'timesheets', 'done'))).error).toMatch(
          /feature_check/
        )
        expect((await attempt(stat('MS-4', 'W1', 'emailed-receipts', 'failed'))).rows).toBe(1)
      })
    })

    it("takes a row in the writer's own name, from an owner or bookkeeper only (migration 20261016001700)", async () => {
      await as({ workspaces: ['W1'], user: 'book-W1' }, async () => {
        // Naming someone else: refused, except a payroll run past its day swept by the next member to start one.
        expect((await attempt(stat('MS-o', 'W1', 'receipts', 'done', 'owner-W1'))).error).toMatch(
          /row-level security/
        )
        expect(
          (await attempt(stat('MS-d', 'W1', 'payroll', 'discarded', 'owner-W1'))).error
        ).toMatch(/row-level security/)
        expect((await attempt(stat('MS-e', 'W1', 'payroll', 'expired', 'owner-W1'))).rows).toBe(1)
        // ...and then only someone of the caller's workspaces.
        expect((await attempt(stat('MS-f', 'W1', 'payroll', 'expired', 'owner-W2'))).error).toMatch(
          /row-level security/
        )
      })
      await as({ workspaces: ['W1'], user: 'owner-W1' }, async () => {
        expect((await attempt(stat('MS-w', 'W1', 'receipts', 'done', 'owner-W1'))).rows).toBe(1)
      })
      // The sweeper's trusted work, with no caller: an expired payroll run only.
      await as({ workspaces: ['W1', 'W2'], system: true }, async () => {
        expect((await attempt(stat('MS-s', 'W1', 'payroll', 'expired', 'owner-W1'))).rows).toBe(1)
        expect(
          (await attempt(stat('MS-t', 'W1', 'payroll', 'discarded', 'owner-W1'))).error
        ).toMatch(/row-level security/)
      })
      // An auditor changes nothing, statistics included, even in their own name.
      await as({ workspaces: ['W1'], user: 'aud-W1' }, async () => {
        expect((await attempt(stat('MS-a', 'W1', 'receipts', 'done', 'aud-W1'))).error).toMatch(
          /row-level security/
        )
      })
    })

    it("shows a workspace's rows to its owners and to the platform admin, and lets nobody change or remove one", async () => {
      await insert(db, 'MatchRunStat', {
        id: 'MS-W1',
        workspaceId: 'W1',
        feature: 'receipts',
        outcome: 'done',
        startedAt: '2026-10-16T12:00:00Z',
      })
      await insert(db, 'MatchRunStat', {
        id: 'MS-W2',
        workspaceId: 'W2',
        feature: 'payroll',
        outcome: 'expired',
        startedAt: '2026-10-16T12:00:00Z',
      })
      try {
        await as({ workspaces: ['W1'], user: 'owner-W1' }, async () => {
          expect(await ids('MatchRunStat')).toEqual(['MS-W1'])
          expect((await attempt(`UPDATE "MatchRunStat" SET "matched" = 9`)).rows).toBe(0)
          expect((await attempt(`DELETE FROM "MatchRunStat"`)).rows).toBe(0)
        })
        await as({ workspaces: ['W1'], user: 'aud-W1' }, async () => {
          expect(await count('MatchRunStat')).toBe(0)
        })
        await as({ user: 'admin', workspaces: [], admin: true }, async () => {
          expect(await ids('MatchRunStat')).toEqual(['MS-W1', 'MS-W2'])
          expect((await attempt(stat('MS-adm', 'W1'))).error).toMatch(/row-level security/)
          expect((await attempt(`UPDATE "MatchRunStat" SET "matched" = 9`)).rows).toBe(0)
          expect((await attempt(`DELETE FROM "MatchRunStat"`)).rows).toBe(0)
        })
        // Trusted work is not admitted either: the row is written as the member.
        await as({ system: true, workspaces: [] }, async () => {
          expect(await count('MatchRunStat')).toBe(0)
        })
        // Even the database owner cannot move a row to another workspace.
        await expect(
          db.query(`UPDATE "MatchRunStat" SET "workspaceId" = 'W2' WHERE id = 'MS-W1'`)
        ).rejects.toThrow(/cannot be changed/)
      } finally {
        await db.exec(`DELETE FROM "MatchRunStat"`)
      }
    })

    it('lets the job record how long a payroll file took to read', async () => {
      await insert(db, 'PayrollMatchRun', {
        id: 'PR-S',
        monthlyReportId: 'R-W1',
        createdById: 'book-W1',
      })
      await insert(db, 'PayrollMatchFile', {
        id: 'PF-S',
        runId: 'PR-S',
        kind: 'timesheet',
        sensitivity: 'financial',
        storageKey: 'W1/E-W1/2026-07/s.pdf',
      })
      try {
        await as({ system: true, workspaces: ['W1', 'W2'] }, async () => {
          expect(
            (
              await attempt(
                `UPDATE "PayrollMatchFile" SET status = 'read', "readMs" = 850 WHERE id = 'PF-S'`
              )
            ).rows
          ).toBe(1)
        })
      } finally {
        await db.exec(`DELETE FROM "PayrollMatchRun" WHERE id = 'PR-S'`)
      }
    })
  })

  describe('the platform admin (app.admin)', () => {
    /** Runs `fn` with the database owner's privileges (to set up rows), then goes back to the restricted role. */
    const asOwner = async <T>(fn: () => Promise<T>): Promise<T> => {
      await db.exec('RESET ROLE')
      try {
        return await fn()
      } finally {
        await db.exec('SET LOCAL ROLE ad_app')
      }
    }
    // As PrismaService sets it: the admin's own id and memberships (none here), and the flag.
    const admin = { user: 'admin', workspaces: [] as string[], admin: true }
    /** Every table below the workspace, and the ones the admin is given no read of. */
    const RECORD_TABLES = [
      'Engagement',
      'BudgetLine',
      'MonthlyReport',
      'Expense',
      'Document',
      'ExpenseDocument',
      'Participant',
      'ParticipantDocument',
      'WexPayment',
      'WexPaymentDocument',
      'Check',
      'DataAccessLog',
      'DeletionRecord',
      'TermsAcceptance',
      'ImportMapping',
      'InboundReceipt',
      'ReportReopening',
    ]
    const line = (id: string, ws: string, actor = 'admin', returning = '') =>
      `INSERT INTO "DataAccessLog" ("id","workspaceId","actorId","actorName","resource","action","description") VALUES ('${id}','${ws}','${actor}','admin@example.org','member','create','Invited sam@example.org as bookkeeper')${returning}`

    it('sees every workspace, its people and its suggestions', async () => {
      await as(admin, async () => {
        expect(await ids('Workspace')).toEqual(['W1', 'W2'])
        expect(await count('Membership')).toBe(4)
        expect(await ids('User')).toEqual(['aud-W1', 'book-W1', 'nobody', 'owner-W1', 'owner-W2'])
        expect(await ids('Suggestion')).toEqual(['S-W1', 'S-W2'])
      })
    })

    it('creates a workspace, leaves a placeholder, and gives, changes and takes away memberships anywhere', async () => {
      await as(admin, async () => {
        // RETURNING, as Prisma writes it: each row must pass the read policy too.
        expect(
          (
            await attempt(
              `INSERT INTO "Workspace" ("id","name","updatedAt") VALUES ('W-adm','new',now()) RETURNING id`
            )
          ).rows
        ).toBe(1)
        expect(
          (
            await attempt(
              `INSERT INTO "User" ("id","email","updatedAt") VALUES ('pending-adm','pat@example.org',now()) RETURNING id`
            )
          ).rows
        ).toBe(1)
        expect(
          (
            await attempt(
              `INSERT INTO "Membership" ("id","userId","workspaceId","role") VALUES ('a1','pending-adm','W-adm','owner') RETURNING id`
            )
          ).rows
        ).toBe(1)
        expect(
          (
            await attempt(
              `INSERT INTO "Membership" ("id","userId","workspaceId","role") VALUES ('a2','nobody','W2','bookkeeper') RETURNING id`
            )
          ).rows
        ).toBe(1)
        expect(
          (await attempt(`UPDATE "Membership" SET role = 'auditor' WHERE id = 'a2' RETURNING id`))
            .rows
        ).toBe(1)
        expect((await attempt(`DELETE FROM "Membership" WHERE id = 'a2'`)).rows).toBe(1)
        // A placeholder only: never a real account, and no person's row changed or removed.
        expect(
          (await attempt(`INSERT INTO "User" ("id","updatedAt") VALUES ('user_x', now())`)).error
        ).toMatch(/row-level security/)
        expect((await attempt(`UPDATE "User" SET email = 'x' WHERE id = 'nobody'`)).rows).toBe(0)
        expect((await attempt(`DELETE FROM "User" WHERE id = 'pending-adm'`)).rows).toBe(0)
      })
    })

    it("changes a workspace's name and lists and nothing else of it, and deletes none", async () => {
      await as(admin, async () => {
        expect(
          (
            await attempt(
              `UPDATE "Workspace" SET "name" = 'Harbor Tech Partners', "updatedAt" = now() WHERE id = 'W2'`
            )
          ).rows
        ).toBe(1)
        expect(
          (
            await attempt(
              `UPDATE "Workspace" SET "budgetItems" = '[{"key":"travel","label":"Travel","reportLine":"program-costs"}]' WHERE id = 'W2' RETURNING id`
            )
          ).rows
        ).toBe(1)
        expect(
          (
            await attempt(
              `UPDATE "Workspace" SET "tagTypes" = '[{"key":"age-group","label":"Age group","appliesTo":["participant"],"values":[{"key":"under-18","label":"Under 18"}]}]' WHERE id = 'W2' RETURNING id`
            )
          ).rows
        ).toBe(1)
        expect(
          (await attempt(`UPDATE "Workspace" SET "tagTypes" = '{}' WHERE id = 'W2'`)).error
        ).toMatch(/tagTypes_check/)
        // The receipts address is the owners' alone (migration 20261015001200).
        expect(
          (
            await attempt(
              `UPDATE "Workspace" SET "receiptsAddress" = 'harbor-tech' WHERE id = 'W2' RETURNING id`
            )
          ).error
        ).toMatch(/Only the owners of a workspace set its receipts address/)
        // So is reading emailed receipts with AI, and a workspace the admin makes starts with it off (20261016000400).
        expect(
          (
            await attempt(
              `UPDATE "Workspace" SET "readEmailedReceiptsWithAi" = true WHERE id = 'W2'`
            )
          ).error
        ).toMatch(/changes only the name and lists/)
        expect(
          (
            await attempt(
              `INSERT INTO "Workspace" ("id","name","updatedAt","readEmailedReceiptsWithAi") VALUES ('W-ai','new',now(),true)`
            )
          ).error
        ).toMatch(/Only the owners of a workspace turn on reading emailed receipts with AI/)
        expect(
          (
            await attempt(
              `UPDATE "Workspace" SET name = 'Harbor Tech' WHERE id = 'W2' RETURNING id`
            )
          ).rows
        ).toBe(1)
        expect(
          (await attempt(`UPDATE "Workspace" SET "termsAcceptedById" = 'admin' WHERE id = 'W2'`))
            .error
        ).toMatch(/changes only the name and lists/)
        expect(
          (await attempt(`UPDATE "Workspace" SET "createdAt" = now() WHERE id = 'W2'`)).error
        ).toMatch(/changes only the name and lists/)
        expect((await attempt(`DELETE FROM "Workspace" WHERE id = 'W2'`)).rows).toBe(0)
        expect(
          (
            await attempt(
              `INSERT INTO "Suggestion" ("id","workspaceId","userId","kind","text") VALUES ('S-adm','W1','admin','list','x')`
            )
          ).error
        ).toMatch(/row-level security/)
      })
    })

    it('sees no row of any table below the workspace, and changes none', async () => {
      await as(admin, async () => {
        // Emailed receipts: only those that went nowhere or were refused or failed (below).
        for (const t of RECORD_TABLES.filter((x) => x !== 'InboundReceipt'))
          expect([t, await count(t)]).toEqual([t, 0])
        expect(await ids('InboundReceipt')).toEqual(['IR-none'])
        for (const sql of [
          `UPDATE "Engagement" SET name = 'x'`,
          `DELETE FROM "Expense"`,
          `UPDATE "Document" SET "fileName" = 'x'`,
          `DELETE FROM "Participant"`,
          `UPDATE "Check" SET message = 'x'`,
          `UPDATE "DataAccessLog" SET description = 'x'`,
        ])
          expect([sql, (await attempt(sql)).rows]).toEqual([sql, 0])
      })
    })

    describe('emailed receipts (migration 20261016000100)', () => {
      /** W1's receipt refused, W2's failed, and W1 rows waiting, needing filing and filed. */
      const receipts = () =>
        asOwner(async () => {
          await db.query(`UPDATE "InboundReceipt" SET status = 'rejected' WHERE id = 'IR-W1'`)
          await db.query(`UPDATE "InboundReceipt" SET status = 'failed' WHERE id = 'IR-W2'`)
          for (const [id, status] of [
            ['IR-W1-unm', 'unmatched'],
            ['IR-W1-filed', 'filed'],
            ['IR-W1-wait', 'received'],
          ])
            await insert(db, 'InboundReceipt', {
              id,
              emailId: `email-${id}`,
              workspaceId: 'W1',
              senderUserId: 'book-W1',
              status,
              receivedAt: '2026-09-16T12:00:00Z',
            })
        })
      /** A rerun: back in the queue, attempts afresh, error and reason cleared. */
      const rerun = (id: string) =>
        `UPDATE "InboundReceipt" SET status = 'received', attempts = 0, "nextAttemptAt" = now(), error = NULL, "rejectReason" = NULL, "updatedAt" = now() WHERE id = '${id}'`
      /** The admin's line for a rerun, as the API writes it (createMany: nothing read back). */
      const logged = (line: string, id: string, ws: string) =>
        `INSERT INTO "DataAccessLog" ("id","workspaceId","actorId","actorName","resource","subjectId","action","description") VALUES ('${line}','${ws}','admin','admin@example.org','document','${id}','update','Ran an emailed receipt again (by a platform admin)')`

      it('sees those that went nowhere or were refused or failed, never one of a workspace waiting, needing filing or filed', async () => {
        await as(admin, async () => {
          await receipts()
          expect(await ids('InboundReceipt')).toEqual(['IR-W1', 'IR-W2', 'IR-none'])
        })
      })

      it('runs again one that went nowhere, changing only what a rerun changes, and adds or removes none', async () => {
        await as(admin, async () => {
          await receipts()
          expect((await attempt(rerun('IR-none'))).rows).toBe(1)
          for (const set of [
            `subject = 'x'`,
            `"workspaceId" = 'W1', "senderUserId" = 'book-W1'`,
            `"senderUserId" = 'book-W1'`,
            `"documentIds" = '{D-W1}'`,
            `"filedAttachments" = '{a1}'`,
            `"createdAt" = now()`,
          ])
            expect([
              set,
              (await attempt(`UPDATE "InboundReceipt" SET ${set} WHERE id = 'IR-none'`)).error,
            ]).toEqual([set, expect.stringMatching(/cannot be changed|trusted work|only runs/)])
          expect(
            (
              await attempt(
                `UPDATE "InboundReceipt" SET "documentIds" = '{D-W1}' WHERE id = 'IR-W2'`
              )
            ).error
          ).toMatch(/only runs an emailed receipt again/)
          expect(
            (await attempt(`UPDATE "InboundReceipt" SET status = 'filed' WHERE id = 'IR-W2'`)).error
          ).toMatch(/row-level security/)
          expect((await attempt(`DELETE FROM "InboundReceipt"`)).rows).toBe(0)
          expect(
            (
              await attempt(
                `INSERT INTO "InboundReceipt" ("id","emailId","receivedAt") VALUES ('IR-adm','email-IR-adm',now())`
              )
            ).error
          ).toMatch(/row-level security/)
        })
      })

      it("runs again a workspace's refused one only after writing its line in that workspace's log, in the same transaction", async () => {
        // No line.
        await as(admin, async () => {
          await receipts()
          expect((await attempt(rerun('IR-W1'))).error).toMatch(/row-level security/)
        })
        // A line in another workspace, or one inside a savepoint, does not count.
        await as(admin, async () => {
          await receipts()
          await db.query(logged('L-w2', 'IR-W1', 'W2'))
          expect((await attempt(rerun('IR-W1'))).error).toMatch(/row-level security/)
        })
        await as(admin, async () => {
          await receipts()
          expect((await attempt(logged('L-sp', 'IR-W1', 'W1'))).rows).toBe(1)
          expect((await attempt(rerun('IR-W1'))).error).toMatch(/row-level security/)
        })
        // Its line, first: the rerun is kept. Lines open no row that is waiting, needing filing or filed.
        await as(admin, async () => {
          await receipts()
          await db.query(logged('L-w1', 'IR-W1', 'W1'))
          for (const id of ['IR-W1-unm', 'IR-W1-filed', 'IR-W1-wait'])
            await db.query(logged(`L-${id}`, id, 'W1'))
          expect(await attempt(rerun('IR-W1'))).toEqual({ rows: 1 })
          for (const id of ['IR-W1-unm', 'IR-W1-filed', 'IR-W1-wait'])
            expect([id, (await attempt(rerun(id))).rows]).toEqual([id, 0])
        })
      })

      it("does not read a workspace's row back in the queue outside the rerun's transaction", async () => {
        await as(admin, async () => {
          await asOwner(async () => {
            await db.query(
              `UPDATE "InboundReceipt" SET status = 'received', attempts = 0 WHERE id = 'IR-W1'`
            )
          })
          expect(await ids('InboundReceipt')).toEqual(['IR-none'])
        })
      })

      it('leaves a member, without the mark, to their own workspace', async () => {
        await as({ workspaces: ['W2'], user: 'owner-W2' }, async () => {
          await receipts()
          expect(await ids('InboundReceipt')).toEqual(['IR-W2'])
          expect((await attempt(rerun('IR-none'))).rows).toBe(0)
          expect((await attempt(rerun('IR-W1'))).rows).toBe(0)
        })
      })
    })

    it('inserts no row in any table below the workspace', async () => {
      // A row of W1 for each, with real parents; the joins name rows that exist, so only the policy can refuse.
      const rows: Record<string, Record<string, string>> = {
        Engagement: { workspaceId: 'W1', name: 'p', number: 'N-adm' },
        BudgetLine: { engagementId: 'E-W1', category: 'wex' },
        MonthlyReport: { engagementId: 'E-W1', period: '2026-09' },
        Expense: {
          engagementId: 'E-W1',
          monthlyReportId: 'R-W1',
          itemNumber: '9',
          reportLine: 'wex',
        },
        Document: { workspaceId: 'W1', storageKey: 'W1/workspace/adm' },
        ExpenseDocument: { expenseId: 'X-W1', documentId: 'D-W1' },
        Participant: { engagementId: 'E-W1', participantId: '99' },
        ParticipantDocument: { participantId: 'P-W1', documentId: 'D-W1' },
        WexPayment: { monthlyReportId: 'R-W1', participantId: 'P-W1' },
        WexPaymentDocument: { wexPaymentId: 'WX-W1', documentId: 'D-W1' },
        Check: { monthlyReportId: 'R-W1' },
        // A line in its own name is allowed (below); in anyone else's, not.
        DataAccessLog: { workspaceId: 'W1', actorId: 'owner-W1' },
        DeletionRecord: { workspaceId: 'W1', exportKey: 'retained/W1/adm.zip' },
        TermsAcceptance: { userId: 'owner-W1', fingerprint: 'v9' },
        ImportMapping: { workspaceId: 'W1', name: 'adm' },
        InboundReceipt: { workspaceId: 'W1', emailId: 'email-adm' },
        ReportReopening: { monthlyReportId: 'R-W1', reopenedById: 'admin' },
      }
      expect(Object.keys(rows).sort()).toEqual([...RECORD_TABLES].sort())
      await as(admin, async () => {
        for (const [t, values] of Object.entries(rows)) {
          await db.exec('SAVEPOINT attempt')
          const error = await insert(db, t, values).then(
            () => 'inserted',
            (e: Error) => e.message
          )
          await db.exec('ROLLBACK TO SAVEPOINT attempt')
          expect([t, error]).toEqual([t, expect.stringMatching(/row-level security/)])
        }
      })
    })

    it('writes an access-log line in any workspace, in its own name, and reads none back', async () => {
      await as(admin, async () => {
        expect((await attempt(line('L-adm', 'W2'))).rows).toBe(1)
        expect(await count('DataAccessLog')).toBe(0)
        // Reading back what it wrote (Prisma's create) is a read, and refused.
        expect((await attempt(line('L-adm2', 'W2', 'admin', ' RETURNING id'))).error).toMatch(
          /row-level security/
        )
        // A line in someone else's name is refused.
        expect((await attempt(line('L-adm3', 'W2', 'owner-W2'))).error).toMatch(
          /row-level security/
        )
        await asOwner(async () => {
          expect(await ids('DataAccessLog')).toContain('L-adm')
        })
      })
    })

    it("names the admin in its lines by its own account's email, whatever the API passed", async () => {
      await as(admin, async () => {
        await asOwner(async () => {
          await insert(db, 'User', { id: 'admin', email: 'admin@example.org' })
        })
        await db.exec(
          `INSERT INTO "DataAccessLog" ("id","workspaceId","actorId","actorName","resource","action") VALUES ('L-pin','W2','admin','someone-else@example.org','member','create')`
        )
        await asOwner(async () => {
          expect(await one(`SELECT "actorName" FROM "DataAccessLog" WHERE id = 'L-pin'`)).toEqual({
            actorName: 'admin@example.org',
          })
        })
      })
      // Without the mark the name is the API's, as before.
      await as({ workspaces: ['W1'], user: 'book-W1' }, async () => {
        await db.exec(
          `INSERT INTO "DataAccessLog" ("id","workspaceId","actorId","actorName","resource","action") VALUES ('L-own','W1','book-W1','book@example.org','document','read')`
        )
        expect(await one(`SELECT "actorName" FROM "DataAccessLog" WHERE id = 'L-own'`)).toEqual({
          actorName: 'book@example.org',
        })
      })
    })

    describe('membership changes need their line, at commit', () => {
      /** One real transaction as `ctx`, committed: the error COMMIT gives, or null. */
      const committed = async (
        ctx: { workspaces?: string[]; user?: string; admin?: boolean },
        statements: string[]
      ): Promise<string | null> => {
        await db.exec('BEGIN')
        try {
          await db.exec('SET LOCAL ROLE ad_app')
          await db.query(
            `SELECT set_config('app.workspace_ids', $1, true), set_config('app.user_id', $2, true), set_config('app.admin', $3, true)`,
            [(ctx.workspaces ?? []).join(','), ctx.user ?? '', ctx.admin ? 'on' : '']
          )
          for (const sql of statements) await db.exec(sql)
          await db.exec('COMMIT')
          return null
        } catch (e) {
          await db.exec('ROLLBACK')
          return (e as Error).message
        }
      }
      const seat = (id: string, ws = 'W1') =>
        `INSERT INTO "Membership" ("id","userId","workspaceId","role") VALUES ('${id}','nobody','${ws}','auditor')`
      const seats = async () =>
        (
          await db.query<{ id: string }>(
            `SELECT id FROM "Membership" WHERE "userId" = 'nobody' ORDER BY id`
          )
        ).rows.map((r) => r.id)
      afterEach(async () => {
        await db.exec(`DELETE FROM "Membership" WHERE "userId" = 'nobody'`)
        await db.exec(`DELETE FROM "DataAccessLog" WHERE id LIKE 'L-bk%'`)
      })

      it('refuses an admin membership insert with no line', async () => {
        expect(await committed(admin, [seat('bk1')])).toMatch(/without a line in its access log/)
        expect(await seats()).toEqual([])
      })

      it('keeps one written with its line', async () => {
        expect(await committed(admin, [seat('bk2'), line('L-bk2', 'W1')])).toBeNull()
        expect(await seats()).toEqual(['bk2'])
      })

      it('does not count a line in another workspace, or one written by an earlier transaction', async () => {
        expect(await committed(admin, [seat('bk3'), line('L-bk3', 'W2')])).toMatch(/without a line/)
        expect(await committed(admin, [line('L-bk4', 'W1')])).toBeNull()
        expect(await committed(admin, [seat('bk4')])).toMatch(/without a line/)
        expect(await seats()).toEqual([])
      })

      it('holds for a change and a removal too', async () => {
        expect(await committed(admin, [seat('bk5'), line('L-bk5', 'W1')])).toBeNull()
        expect(
          await committed(admin, [`UPDATE "Membership" SET role = 'owner' WHERE id = 'bk5'`])
        ).toMatch(/without a line/)
        expect(await committed(admin, [`DELETE FROM "Membership" WHERE id = 'bk5'`])).toMatch(
          /without a line/
        )
        expect(
          await committed(admin, [`DELETE FROM "Membership" WHERE id = 'bk5'`, line('L-bk6', 'W1')])
        ).toBeNull()
        expect(await seats()).toEqual([])
      })

      it('leaves an owner, without the mark, to the policies alone', async () => {
        expect(await committed({ workspaces: ['W1'], user: 'owner-W1' }, [seat('bk7')])).toBeNull()
        expect(await seats()).toEqual(['bk7'])
      })
    })

    it('keeps the platform role changes: the mark adds and reads them, in its own name; nobody alters one', async () => {
      const change = (id: string, actor = 'admin') =>
        `INSERT INTO "PlatformRoleChange" ("id","actorId","actorEmail","targetId","targetEmail","oldRole","newRole","outcome") VALUES ('${id}','${actor}','admin@example.org','user_pat','pat@example.org',NULL,'admin','done')`
      await as(admin, async () => {
        expect((await attempt(`${change('PRC-1')} RETURNING id`)).rows).toBe(1)
        expect(await ids('PlatformRoleChange')).toEqual(['PRC-1'])
        expect((await attempt(change('PRC-2', 'owner-W1'))).error).toMatch(/row-level security/)
        expect(
          (
            await attempt(
              `INSERT INTO "PlatformRoleChange" ("id","actorId","targetId","outcome") VALUES ('PRC-3','admin','user_pat','maybe')`
            )
          ).error
        ).toMatch(/outcome_check/)
        expect((await attempt(`UPDATE "PlatformRoleChange" SET outcome = 'failed'`)).rows).toBe(0)
        expect((await attempt(`DELETE FROM "PlatformRoleChange"`)).rows).toBe(0)
        await asOwner(async () => {
          expect(await ids('PlatformRoleChange')).toEqual(['PRC-1'])
        })
      })
      await as({ user: 'admin' }, async () => {
        await asOwner(async () => {
          await db.exec(change('PRC-4'))
        })
        expect(await count('PlatformRoleChange')).toBe(0)
        expect((await attempt(change('PRC-5'))).error).toMatch(/row-level security/)
      })
      await as({ workspaces: ['W1', 'W2'], system: true }, async () => {
        expect((await attempt(change('PRC-6'))).error).toMatch(/row-level security/)
      })
    })

    it('without the flag, the same person is nobody special', async () => {
      await as({ user: 'admin' }, async () => {
        expect(await count('Workspace')).toBe(0)
        expect(await count('Membership')).toBe(0)
        expect(await count('Suggestion')).toBe(0)
        for (const sql of [
          `INSERT INTO "Workspace" ("id","name","updatedAt") VALUES ('W-x','new',now())`,
          `INSERT INTO "Membership" ("id","userId","workspaceId","role") VALUES ('x1','nobody','W2','owner')`,
          `INSERT INTO "User" ("id","updatedAt") VALUES ('pending-x2', now())`,
          line('L-x', 'W2'),
        ])
          expect((await attempt(sql)).error).toMatch(/row-level security/)
        expect(
          (await attempt(`UPDATE "Workspace" SET "tagTypes" = '[]' WHERE id = 'W2'`)).rows
        ).toBe(0)
      })
      // A flag with no person is nothing either: it never stands in for trusted work.
      await as({ admin: true }, async () => {
        expect(await count('Workspace')).toBe(0)
        expect(
          (await attempt(`INSERT INTO "User" ("id","updatedAt") VALUES ('pending-x3', now())`))
            .error
        ).toMatch(/row-level security/)
      })
    })

    it('leaves an admin who is a member of a workspace exactly its member rights there', async () => {
      await as({ user: 'adm-W1', workspaces: ['W1'], admin: true }, async () => {
        await asOwner(async () => {
          await insert(db, 'User', { id: 'adm-W1' })
          await insert(db, 'Membership', { userId: 'adm-W1', workspaceId: 'W1', role: 'auditor' })
        })
        // Its own workspace's records, through its membership; none of the workspace next door.
        expect(await ids('Engagement')).toEqual(['E-W1'])
        expect(await ids('Document')).toEqual(['D-W1'])
        expect(await ids('Participant')).toEqual(['P-W1'])
        expect(await ids('DataAccessLog')).toEqual(['L-W1'])
        expect(await count('DeletionRecord')).toBe(0)
        // It is an auditor there, not an owner: the flag lets it change the name and lists only.
        expect(
          (await attempt(`UPDATE "Workspace" SET "termsVersion" = 'x' WHERE id = 'W1'`)).error
        ).toMatch(/changes only the name and lists/)
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
        expect(await ids('DeletionRecord')).toEqual(['DR-W1', 'R1'])
        expect(
          (await attempt(`UPDATE "DeletionRecord" SET status = 'downloaded' WHERE id = 'R1'`)).rows
        ).toBe(1)
        expect((await attempt(`DELETE FROM "DeletionRecord"`)).rows).toBe(0)
      })
      await asOwner(async () => {
        await db.exec(record('R-W2', 'W2'))
      })
      await as({ workspaces: ['W1'], user: 'owner-W1' }, async () => {
        expect(await ids('DeletionRecord')).toEqual(['DR-W1'])
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

    for (const status of ['draft', 'submitted'])
      it(`deletes an engagement with everything under it, once its documents are gone (a ${status} month)`, async () => {
        await as({ workspaces: ['W1'], user: 'owner-W1' }, async () => {
          await asOwner(async () => {
            await insert(db, 'Engagement', {
              id: 'E-del',
              workspaceId: 'W1',
              name: 'x',
              number: 'D',
            })
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
            // A reopening goes with its month, though nobody may delete one directly.
            await insert(db, 'ReportReopening', {
              id: 'RO-del',
              monthlyReportId: 'R-del',
              reopenedById: 'owner-W1',
            })
            await insert(db, 'Document', {
              id: 'D-del',
              workspaceId: 'W1',
              engagementId: 'E-del',
              storageKey: 'W1/E-del/general/k',
            })
            await insert(db, 'ExpenseDocument', { expenseId: 'X-del', documentId: 'D-del' })
            await insert(db, 'ParticipantDocument', { participantId: 'P-del', documentId: 'D-del' })
            await insert(db, 'WexPaymentDocument', { wexPaymentId: 'WX-del', documentId: 'D-del' })
            // A locked month goes with its engagement all the same (migration 20261016001700).
            await db.query(`UPDATE "MonthlyReport" SET status = $1 WHERE id = 'R-del'`, [status])
          })
          // Left to the foreign keys alone, the document is un-linked from the engagement first, and the
          // storage-key trigger refuses that. This is why the API deletes the documents before the engagement.
          expect((await attempt(`DELETE FROM "Engagement" WHERE id = 'E-del'`)).error).toMatch(
            /storage key must start with/
          )
          // The order the API uses: documents, then months (their payments), then the engagement.
          expect(
            (await attempt(`DELETE FROM "Document" WHERE "engagementId" = 'E-del'`)).rows
          ).toBe(1)
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
              ['ReportReopening', ['RO-W1', 'RO-W2']],
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

  describe('terms acceptance', () => {
    const accept = (user: string, version = 'v1') =>
      `INSERT INTO "TermsAcceptance" ("id","userId","fingerprint") VALUES ('${user}-${version}','${user}','${version}')`

    it('lets a person record their own acceptance, once per version, and read it back', async () => {
      await as({ user: 'nobody' }, async () => {
        expect((await attempt(accept('nobody'))).rows).toBe(1)
        expect((await attempt(accept('nobody'))).error).toMatch(/duplicate key|unique/)
        expect((await attempt(accept('nobody', 'v2'))).rows).toBe(1)
        expect(await ids('TermsAcceptance')).toEqual(['nobody-v1', 'nobody-v2'])
      })
    })

    it('refuses an acceptance written for someone else, and with no signed-in person', async () => {
      await as({ user: 'nobody' }, async () => {
        expect((await attempt(accept('owner-W1'))).error).toMatch(/row-level security/)
      })
      await as({}, async () => {
        expect((await attempt(accept('nobody'))).error).toMatch(/row-level security/)
      })
      await as({ system: true }, async () => {
        expect((await attempt(accept('nobody'))).error).toMatch(/row-level security/)
      })
    })

    it("shows nobody else's acceptance", async () => {
      await as({ user: 'owner-W1' }, async () => {
        expect((await attempt(accept('owner-W1'))).rows).toBe(1)
        await db.exec('RESET ROLE')
        await db.exec(accept('book-W1'))
        await db.exec('SET LOCAL ROLE ad_app')
        expect(await ids('TermsAcceptance')).toEqual(['TA-W1', 'owner-W1-v1'])
      })
      await as({ user: 'nobody', workspaces: ['W1', 'W2'] }, async () => {
        expect(await count('TermsAcceptance')).toBe(0)
      })
    })

    it('cannot be changed or removed, by the person or by trusted work', async () => {
      for (const ctx of [{ user: 'owner-W1' }, { system: true }])
        await as(ctx, async () => {
          await db.exec('RESET ROLE')
          await db.exec(accept('owner-W1'))
          await db.exec('SET LOCAL ROLE ad_app')
          if (!ctx.system) {
            expect((await attempt(`UPDATE "TermsAcceptance" SET fingerprint = 'v9'`)).rows).toBe(0)
            expect((await attempt(`DELETE FROM "TermsAcceptance"`)).rows).toBe(0)
            expect(await count('TermsAcceptance')).toBe(2)
          } else {
            expect((await attempt(`UPDATE "TermsAcceptance" SET fingerprint = 'v9'`)).rows).toBe(0)
            expect((await attempt(`DELETE FROM "TermsAcceptance"`)).rows).toBe(0)
          }
          await db.exec('RESET ROLE')
          expect(
            (await db.query(`SELECT 1 FROM "TermsAcceptance" WHERE fingerprint = 'v1'`)).rows
          ).toHaveLength(1)
        })
    })

    it('outlives the person: no foreign key to User', async () => {
      await as({}, async () => {
        await db.exec('RESET ROLE')
        await db.exec(accept('gone'))
        await db.exec(`DELETE FROM "User" WHERE id = 'gone'`)
        expect(
          (await db.query(`SELECT 1 FROM "TermsAcceptance" WHERE "userId" = 'gone'`)).rows
        ).toHaveLength(1)
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
