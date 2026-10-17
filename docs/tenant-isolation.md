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
  none, so nobody invites themselves. A workspace and its first owner are made by the platform admin (below);
  an owner's invitation of a person who has not signed in leaves a placeholder User row as trusted work. The first owner of a
  workspace nobody belongs to is made by `scripts/grant-role.ts`, as the database owner.
- **Everything the workspace accounts for is its members' to read and write.** Who may submit, record the
  month-end closing or open a personal document is the application's rule. The access log is written by
  whoever acts, read inside the workspace, and never changed or deleted through the API.

- **A deletion record outlives what it describes.** `DeletionRecord` (who exported and deleted which engagement
  or workspace, and where our retained copy is) has no foreign keys, so deleting the engagement or the workspace
  leaves it. Only an owner of its workspace reads, inserts or updates it; nobody deletes it through the API. Its
  `workspaceId` is named by the row (there is no parent to copy it from, so no `_1_set_tenant`), the policy ties
  it to a workspace the writer owns, `_3_keep` stops it being re-pointed, and its status only moves forward
  (exported, downloaded, deleted).
- **A saved import mapping is the workspace's** (`ImportMapping`, migration `20261015000600`): how a kind of
  exported transactions file maps to expense lines, saved by name. Like a suggestion it names its workspace itself
  (a foreign key to `Workspace`, so no `_1_set_tenant`) and goes with it; `_3_keep` stops it being re-pointed.
  Members read, insert and update it (an auditor saving one is the application's refusal); nobody deletes one
  through the API, and the platform admin sees none. It holds column names and category names, never a row of a
  file.
- **An emailed receipt is nobody's until trusted work says whose** (`InboundReceipt`, migrations `20261015001000`
  and `..1200`). The provider's webhook writes the row before anyone is known, so it starts with no `workspaceId`:
  such a row is read, written and removed only under `app.system` (the webhook, the worker's claim, the address
  lookup). The worker names the workspace only together with the sender, once the sender is a verified owner or
  bookkeeper of it and DMARC passed (`InboundReceipt_3_keep` refuses the workspace alone), so junk (an unknown
  address, an unverified sender, a stranger) stays nobody's. Once it names a workspace the row is that workspace's
  like any record: members read it, and change only what became of it; `_3_keep` lets the workspace and the sender go
  from unknown to known once, under `app.system`, and keeps everything the email came as. Trusted work removes, after
  30 days, the rows with no workspace and those `rejected` or `failed`; nothing else but with the workspace. What it
  files is filed as the member who sent it (the worker runs as that person, no system mark), so their roles and these
  policies apply as if they had uploaded it. It names its workspace itself (a foreign key, removed with the
  workspace; no `_1_set_tenant`). The engagement is a foreign key too (`ON DELETE SET NULL`), and
  `InboundReceipt_4_engagement` keeps it to an engagement of the row's own workspace and clears the filed document
  ids when it is cleared. A workspace's `receiptsAddress` is set and changed by its owners, never cleared
  (`Workspace_6_receipts_address_kept`; never under `app.admin`; the table's owner may still correct it).
- **Every receipts address ever used is held** (`ReceiptsAddress`, migration `20261017000400`), so mail sent to an old
  one never reaches another workspace. Not a tenant table: an address, dates and a count, no workspace data, and
  `workspaceId` is a plain id with no foreign key, since the row must outlive a deleted workspace. The database writes
  it (`Workspace_9_receipts_address_history`, as the function's owner) when an address is set, changed, or its
  workspace deleted; the address is unique across the whole history. Only `app.admin` and `app.system` read it; members,
  owners included, read nothing (they learn only whether an address is taken, `app_receipts_address_taken`). The webhook,
  under `app.system`, refuses mail to a previously used address and counts it (`ReceiptsAddress_3_keep`: the count and
  the last arrival only). The admin's mark removes ("releases") a previously used row, never a current one, only with
  its access-log line in that workspace written first in the same transaction (`ReceiptsAddress_4_release`).

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
Keep the list short and reviewed. Trusted work is the only deleter of a `Workspace` row (migration `20261012000100`; the API
checks first that the caller owns an empty workspace; memberships and suggestions go by foreign key, the access
log has no foreign key and stays), and it deletes `pending-` users only. Prisma reads back every row it inserts
(`RETURNING`), and Postgres applies the read policy to those rows too, which is why trusted work may read
`User` and `Workspace`; the database spec inserts with `RETURNING` to keep that true.

**The platform admin** (`app.admin`) is a person whose Clerk `publicMetadata.role` is `admin`, working at the
workspace level only. `AdminGuard` runs after `AuthenticatedGuard` on the admin routes, asks Clerk's backend for
the role on every request and calls `identifyAdmin`; `PrismaService` then sets `app.admin = on` beside the admin's
own `app.user_id` and `app.workspace_ids` (their own memberships), never with `app.system`, and `app_is_admin()`
counts the mark only beside a person. Migration `20261013000200` admits it to:

| Table                | The admin may                                                                             |
| -------------------- | ----------------------------------------------------------------------------------------- |
| `Workspace`          | read every one, insert one, update its name and lists only (`Workspace_4_admin_lists`)    |
| `Membership`         | read, insert, update and delete, in every workspace, each with its line (below)           |
| `User`               | read everyone; insert `pending-` placeholders only                                        |
| `Suggestion`         | read, in every workspace                                                                  |
| `DataAccessLog`      | insert a line in its own name in any workspace; **no read** (written with `createMany`)   |
| `PlatformRoleChange` | insert in its own name and read; nobody updates or deletes (no workspace, no foreign key) |

Nothing else admits the mark: every engagement-level table, the log's reads, `DeletionRecord` and
`TermsAcceptance` keep their policies, so there the admin sees only what its own memberships give it, and a member
who is also an admin keeps exactly their member rights. Creating a workspace is the admin's alone (trusted work no
longer inserts one). The admin accepts no Terms for the workspace it creates: the first owner who has accepted the
current version is recorded on it (`MeController`), and from then on `Workspace_5_terms_kept` refuses any change to
those three columns from anyone but the table's owner (migrations, scripts). A rename never touches them.

An admin may seat itself in a workspace (owner's decision, 2026-10-14) and then read its records as that member, so
the database makes sure it shows: `Membership_9_admin_logged` (a `DEFERRABLE INITIALLY DEFERRED` constraint trigger,
`SECURITY DEFINER` because the admin cannot read the log) refuses at commit a membership insert, update or delete
made under the mark unless this transaction wrote a `DataAccessLog` line in that workspace in the admin's name
(`xmin` is the transaction's id; a line written inside a savepoint does not count, which fails closed), and
`DataAccessLog_1_admin_name` sets a marked line's `actorName` from the admin's own `User.email`. The API's lines say
"(platform admin) added themself as …" or end "(by a platform admin)".

`PlatformRoleChange` belongs to no workspace, but its policies read the request's context, so it is in
`TENANT_TABLES` with a `tenant_read` policy like the rest; the restricted role's grants cover it as every table.

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
