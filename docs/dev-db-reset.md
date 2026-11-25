# Reset the dev database to a clean schema (DRAFT, untested)

**When:** a migration left dev's schema half-applied or wrong, or dev's data is beyond `demo:reset`. Dev holds a
fictional seed only, so nothing is lost that `db:seed` can't recreate. Anything else on dev (a workspace someone made
by hand) is lost, and dev has no backups.

**What "the same schema as production" means here:** production's schema is whatever the migrations on `main` built
(CI applies `main` to production on every push). So dev gets a clean copy by wiping dev and applying `main`'s
migrations to it. **Never copy production's database, a dump or a backup into dev**: it holds real records, and dev
is shared (CLAUDE.md, "Data rules").

## Before you start

1. Say in the team channel that dev is about to be wiped, and get a yes. It is shared and the last deploy wins.
2. Look at what is on dev, and ask whether anyone needs it (step 2's first command lists the workspaces).
3. Optional sanity check: production's latest deploy is not failed.
   `railway deployment list -e production -s audit-differently --limit 3` should show `SUCCESS` or `SKIPPED`, not `FAILED`.
   If production is behind `main`, dev will be one step ahead of it, which is what CI does to production next.

## Steps

1. Get a clean, current `main` (a deploy uploads uncommitted changes too, so a dirty tree would put them on dev):

   ```bash
   git fetch origin
   git switch main
   git pull --ff-only
   git status --short        # must print nothing
   ```

2. Wipe dev's schema, from a shell on `api-dev` (dev has no public database address, and the image has no `psql`).
   The script refuses to run anywhere but the `dev` environment:

   ```bash
   railway ssh -e dev -s api-dev
   cd /app/apps/api
   ```

   First, look at what is there (reads only):

   ```bash
   node -e '
   const { PrismaClient } = require("@prisma/client");
   const p = new PrismaClient({ datasourceUrl: process.env.SCHEMA_DATABASE_URL });
   (async () => {
     console.log(process.env.RAILWAY_ENVIRONMENT_NAME, await p.$queryRawUnsafe("select current_database()"));
     console.log(await p.$queryRawUnsafe("select name, \"receiptsAddress\" from \"Workspace\" order by name"));
     await p.$disconnect();
   })();
   '
   ```

   Then wipe it. This drops every table, trigger, policy and the `_prisma_migrations` history, and puts the schema's
   owner and default access back to how Postgres creates `public`:

   ```bash
   node -e '
   const { PrismaClient } = require("@prisma/client");
   if (process.env.RAILWAY_ENVIRONMENT_NAME !== "dev") { console.error("Not the dev environment. Stopping."); process.exit(2); }
   const p = new PrismaClient({ datasourceUrl: process.env.SCHEMA_DATABASE_URL });
   (async () => {
     for (const sql of [
       "DROP SCHEMA public CASCADE",
       "CREATE SCHEMA public",
       "ALTER SCHEMA public OWNER TO pg_database_owner",
       "GRANT USAGE ON SCHEMA public TO PUBLIC",
     ]) { await p.$executeRawUnsafe(sql); console.log("ok:", sql); }
     console.log(await p.$queryRawUnsafe("select pg_get_userbyid(nspowner) owner from pg_namespace where nspname = 'public'"));
     await p.$disconnect();
   })().catch((e) => { console.error(e.message); process.exit(1); });
   '
   ```

   - The four statements are fixed text, no value from outside goes into them.
   - **Check the last line prints `pg_database_owner`.** That is what dev's `public` schema had before this was
     written. If it prints another owner, stop and tell the owner.
   - Roles live outside the schema, so `ad_app` stays. `role:ensure` sets its grants up again on the next start
     (`GRANT USAGE ON SCHEMA public`, table and sequence grants, default privileges: `src/core/app-role-grants.ts`,
     `src/core/app-role.ts`).
   - R2: the dev bucket's old objects stay, and belong to workspaces that no longer exist. Empty the dev bucket's
     workspace folders by hand if that matters. Never touch production's bucket.
   - `exit` leaves the shell.

3. Deploy `main`:

   ```bash
   apps/api/scripts/deploy-dev.sh
   ```

   `deploy:start:dev` runs `prisma migrate deploy`, then `role:ensure`, then `db:seed`, then starts the API.

4. Check:
   - `curl https://<api-dev domain>/api/health` answers `ok`.
   - `railway logs -e dev -s api-dev` shows every migration applied and the seed loaded, with no error (above all
     none from `role:ensure`).
   - The rows in `_prisma_migrations` equal the folders in `apps/api/prisma/migrations` (not counting
     `migration_lock.toml`), none unfinished. Read it the same way as in step 2, with
     `select count(*) n, count(*) filter (where finished_at is null) unfinished from _prisma_migrations`.
   - Sign in to the web app as a demo person (see "The demo people" in [dev-api.md](dev-api.md)). First sign-in
     takes the seeded seat again.

5. Go back to your own branch: `git switch <your branch>`.

## If it fails

- A migration fails partway: the deploy stops and the API is down. Fix the SQL on a branch and redeploy. If Prisma
  says the migration failed (P3009), wipe again (step 2) rather than `migrate resolve`: dev has nothing to keep.
- The API starts but sign-in fails: the dev Clerk people still exist, but their seats come from the seed. Check the
  seed ran (`railway logs`).
- `ad_app` can't read the tables ("permission denied for schema public" or a table): `role:ensure` did not run or
  failed. Read its lines in the deploy log, fix, and redeploy.

## Open questions to settle before this is final

- Does a dev-scoped project token allow `railway ssh`? If not, only someone with the account login can do step 2.
  (With the account login it does; checked 2026-11-25.)
- Does `role:ensure` restore everything `ad_app` needs after the wipe? Run once on dev to confirm.
- Does `ALTER SCHEMA public OWNER TO pg_database_owner` succeed for the owner login (`postgres`, a superuser)?
- Run the whole thing once on dev with the owner's yes, then remove "DRAFT, untested".
