# Installation and Development

## Local development

**Prerequisites:** Node 22 (`.nvmrc`), access to the Railway project and the dev Clerk instance. There is no
local database and no demo sign-in: your API and web app run on your machine against the shared `dev`
environment on Railway (fictional seed only) and sign in through the dev Clerk instance, the way the deployed
API does. The one-time setup of that environment, and the daily commands, are in
[docs/dev-api.md](docs/dev-api.md).

```bash
npm install
cp apps/api/.env.example apps/api/.env       # fill in the dev database URLs (sslmode=require) and the dev Clerk key
cp apps/web/.env.example apps/web/.env.local # fill in the dev Clerk publishable key
```

### Database

Migrations are hand-written SQL under `apps/api/prisma/migrations/` and applied with `migrate deploy`
(see `CLAUDE.md`, "Database"). The first two create the tables and the tenant isolation
(`docs/tenant-isolation.md`). Against the dev database, as the owner (`SCHEMA_DATABASE_URL`):

```bash
cd apps/api
npx prisma generate        # the client, needed before typecheck
npm run db:migrate         # prisma migrate deploy, as the owner
npm run db:seed            # two fictional workspaces, their people, engagements, months and participants
# Then, once per database: the restricted role the API connects as, and the first owner of a new workspace.
APP_ROLE_PASSWORD=<24+ chars> npm run role:create -- --confirm-host <host:port>
npm run role:grant -- --user <clerk user id> --workspace "<name>" --role owner --confirm-host <host:port>
cd ../..
```

Put the URL `role:create` prints in `DATABASE_URL`; `SCHEMA_DATABASE_URL` stays the owner. Both carry
`sslmode=require`. With `REQUIRE_TENANT_RLS=on` the API refuses to start until the role exists, and
`src/startup-checks.ts` refuses a database off this machine without TLS.

### Start everything

```bash
npm run dev                # API on http://localhost:3000/api/health, web on http://localhost:5173
```

Or one at a time with `npm run dev --workspace @ad/api` and `npm run dev --workspace @ad/web`
(`.claude/launch.json` has the same two).

## The demo

The demo people, the story and the reset command: [docs/dev-api.md](docs/dev-api.md).

## CI gates

Run before pushing; CI runs the same:

```bash
npm run lint
npm run format:check
npm run typecheck
npm run build
npm run test
```

## Environment variables

**apps/api/.env**

| Name                  | Purpose                                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| `PORT`                | API port (3000)                                                                                |
| `FRONTEND_URL`        | Comma-separated browser origins allowed by CORS                                                |
| `DATABASE_URL`        | The API's connection: the restricted role from `scripts/create-app-role.ts`, `sslmode=require` |
| `SCHEMA_DATABASE_URL` | The owner, for Prisma's CLI, the seed and scripts                                              |
| `CLERK_SECRET_KEY`    | This product's own Clerk instance (never Interview Differently's or Learn Differently's)       |
| `R2_*`                | Private bucket for documents. Unset locally: files go to `apps/api/storage/` (gitignored)      |
| `APP_ROLE_PASSWORD`   | What `role:create` gives the restricted role; only needed while running that script            |
| `REQUIRE_TENANT_RLS`  | `on` in every environment: the API refuses to start as a role that bypasses the policies       |
| `TRUST_PROXY`         | `1` behind Railway's proxy                                                                     |

**apps/web/.env.local**

| Name                         | Purpose                        |
| ---------------------------- | ------------------------------ |
| `VITE_API_URL`               | API origin, without `/api`     |
| `VITE_CLERK_PUBLISHABLE_KEY` | Same Clerk instance as the API |

## Deployment

Railway is declared in code: [.railway/railway.ts](.railway/railway.ts) (the `railway/iac` SDK, same pattern as
Interview Differently). `railway config plan` previews, `railway config apply` applies; CI does both on every push
to `main` once the repository variable `RAILWAY_PROJECT_READY` is `true` and the secret `RAILWAY_TOKEN` is set,
then deploys `apps/api` with `railway up`. `apps/web` goes to Vercel (its job is added the same way once that
project exists). Documents live in a private Cloudflare R2 bucket per environment. The dev environment and the
rules it carries are in [docs/dev-api.md](docs/dev-api.md).
