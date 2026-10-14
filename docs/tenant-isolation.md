# Tenant isolation: one workspace never sees another's data

Audit Differently serves teams, each in a workspace. A workspace's people see its engagements, months,
documents and participants; they see nothing of the workspace next door. Two layers enforce it, and they do
different jobs. Same design as Interview Differently (`interview-differently/docs/tenant-isolation.md`), with
one line (the workspace) instead of two, because the funder does not sign in.

| Layer                             | Responsibility                                                                                                                    |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Database** (row-level security) | The workspace line. Whatever the application asks for, Postgres returns only rows of the caller's workspaces.                     |
| **Application** (roles)           | What a person may do inside that line: an owner runs the workspace and signs, a bookkeeper records and submits, an auditor reads. |

A mistake in the application's access logic can then expose data only inside one workspace, never across.

## What this protects against, and what it does not

Row-level security is a second wall behind the application's own checks. It protects against **logic mistakes**:
a query that forgets its filter, a route that looks something up by id without checking whose it is, a role
check that is wrong.

It does not protect against **SQL injection**. The caller's context is a set of settings the API puts on its
own connection, so SQL an attacker controls could set them too. Every query is parameterized, and raw SQL never
interpolates a request value. Treat a raw query that builds SQL from input as a defect.

It also cannot check things only the application knows (who may submit a month, which role may open a
personal document). Those stay in the API.

## The model

- **The tenant is the workspace.** An engagement belongs to exactly one workspace, and so does everything
  under it.
- **Every tenant row carries `workspaceId`.** An engagement and a document name it themselves (a real foreign
  key). Everything under an engagement, a report, an expense, a participant or a work-experience payment
  copies it from its parent through a trigger (`<Table>_1_set_tenant`): the value is always the parent's,
  whatever the caller passed, a row whose parent is missing is refused, and the column is NOT NULL.
- **A document stays with its workspace.** A document that names an engagement must be of that engagement's
  workspace, and attaching a document to an expense, a participant or a payment of another workspace is
  refused by a trigger (`_2_document_workspace`), because foreign-key checks are not subject to the policies.
- **What a row belongs to cannot change** (`_3_keep`): an expense cannot move to another report, a membership
  cannot move to another person or workspace, an engagement cannot move to another workspace.
- **Memberships are invitations.** A person's workspaces are the workspaces of their memberships. Only an
  owner gives, changes or removes a membership, and only in a workspace they own; a person with none can give
  none, so nobody invites themselves. Two trusted steps run as system: the creator of a workspace is made its
  owner, and an invited person who has not signed in gets a placeholder User row. The first owner of a
  workspace nobody belongs to is made by `scripts/grant-role.ts`, as the database owner.
- **Everything the workspace accounts for is its members' to read and write.** Who may submit, record the
  funder's decision or open a personal document is the application's rule. The access log is written by
  whoever acts, read inside the workspace, and never changed or deleted through the API.

- **A deletion record outlives what it describes.** `DeletionRecord` (who exported and deleted which engagement
  or workspace, and where our retained copy is) has no foreign keys, so deleting the engagement or the workspace
  leaves it. Only an owner of its workspace reads, inserts or updates it; nobody deletes it through the API. Its
  `workspaceId` is named by the row (there is no parent to copy it from, so no `_1_set_tenant`), the policy ties
  it to a workspace the writer owns, `_3_keep` stops it being re-pointed, and its status only moves forward
  (exported, downloaded, deleted).

## How a request works

1. `TenantMiddleware` opens an empty context (`src/core/tenant-context.ts`) for the request.
2. The guard that verifies the caller calls `identifyCaller` before anything else touches the database.
3. `PrismaService` (`src/prisma/prisma.service.ts`) sets two transaction-local settings on every query that
   can reach a tenant table: who the caller is and their workspaces, which the database works out from their
   memberships. Inside `$transaction` the queries join the caller's transaction.
4. Policies (`prisma/migrations/20261011000100_tenant_rls`) compare the row's `workspaceId` with those
   settings. With no settings the caller sees nothing. Reading, inserting, updating and deleting have separate
   policies: being able to see a row never means being able to change it.

**Trusted paths** (`runAsSystem`) act for every workspace with no signed-in person: the connection carries
`app.workspace_ids` = every workspace and `app.system = on`. Only the `User` and `Membership` write policies
admit the mark (so a workspace's creator can be made its owner, an invitation can leave a placeholder, and a
first sign-in can take it over); every other policy treats trusted work like any member of every workspace.
Keep the list short and reviewed. Trusted work is also the only writer of a `Workspace` row (the creator's
first membership comes with it), the only deleter of a `Workspace` row (migration `20261012000100`; the API
checks first that the caller owns an empty workspace; memberships and suggestions go by foreign key, the access
log has no foreign key and stays), and it deletes `pending-` users only. Prisma reads back every row it inserts
(`RETURNING`), and Postgres applies the read policy to those rows too, which is why trusted work may read
`User` and `Workspace`; the database spec inserts with `RETURNING` to keep that true.

**Storage keys.** A `Document` row's `storageKey` is `<workspaceId>/<engagementId or workspace>/<period or
general>/<uuid>.<ext>`; a trigger refuses a key whose first two segments disagree with the row, on insert or
update, and the API refuses to serve, read or delete an object from a row
whose key says otherwise. The bucket itself has one credential; this is what keeps objects per workspace. In an
interactive `$transaction(async (tx) => ...)` use `tx` for every query inside the callback.

## Switching it on

Row-level security applies whenever the API connects as a restricted role, in every environment, local
development included.

- **`DATABASE_URL`** is the API's connection: the restricted role (`ad_app`), which the policies bind.
- **`SCHEMA_DATABASE_URL`** is the database owner, for anything that changes or reads the schema: Prisma's CLI
  (`directUrl` in `schema.prisma`), the seed and the scripts (`scripts/lib/owner-env.ts`).

At startup the API checks which role it connected as and turns the per-query context on only for the
restricted role. Connected as the owner or a superuser (tests, tooling) it is the plain client and says so in
the log. `REQUIRE_TENANT_RLS=on` makes startup fail instead of running without it; every environment sets it. There is
no local database: a laptop connects to the `dev` database on Railway (`docs/dev-api.md`), set up with the steps
below, over TLS. The role may execute only the functions listed in `src/core/app-role-grants.ts`;
`scripts/create-app-role.ts` creates it, grants exactly that, and prints the URL.

## Setting up a database (in order)

Every script that writes needs `--confirm-host <host>`.

1. Point `DATABASE_URL` and `SCHEMA_DATABASE_URL` at the owner. Run `npm run db:migrate`, then `npm run db:seed`
   if it is a development database.
2. Create the restricted role: `APP_ROLE_PASSWORD=... npm run role:create -- --confirm-host <host>`. Set
   `DATABASE_URL` to the URL it prints; `SCHEMA_DATABASE_URL` stays the owner. On Railway this step is automatic:
   set `DATABASE_URL` to the role's URL with a password you choose, and every deploy runs
   `npm run role:ensure` after the migrations (`scripts/ensure-app-role.ts`), which creates the role if it is
   missing, sets its password from `DATABASE_URL` when that cannot log in, and re-applies its limits and grants.
3. Make the first owner: `npm run role:grant -- --user <clerk user id> --workspace "<name>" --role owner --confirm-host <host>`.
4. Set `REQUIRE_TENANT_RLS=on` (every environment), `sslmode=require` on both URLs, and turn point-in-time
   recovery on before the first real row (`.railway/railway.ts` declares the volume backups and the PITR bucket).

## Adding a table that holds tenant data

1. Add `workspaceId String?` ("set by trigger") with an index.
2. In the migration: the `_1_set_tenant` trigger from the parent, the `_3_keep` trigger for its parent
   columns, `SET NOT NULL`, and `create_tenant_policies` (copy the helper from the first migration into the
   new one, or inline the four policies).
3. Add the table to `src/core/tenant-tables.ts`, and cases to `src/core/tenant-rls.spec.ts`.

## Tests

`src/core/tenant-rls.spec.ts` runs the real migrations on Postgres (PGlite), as the restricted role with exactly
its real privileges: triggers, isolation between workspaces, fail-closed behaviour, the writes a member may and
may not make, invitations, the access log, and that the role can execute nothing it should not. It runs with
`npm test`, which sets the Node flag it needs; in CI a run without the flag fails instead of skipping.

## Cost

With the restricted role, a query that can reach a tenant table runs in its own short transaction: begin, set
the context, query, commit, which is four round trips instead of one. Every table here is a tenant table, so
that is every query; the cost is large over a slow connection and small on the platform's own network.
