# The shared dev environment

There is no local database and no demo sign-in. A laptop develops against the `dev` environment on Railway, which
holds the fictional seed and nothing else, and signs in through the dev Clerk instance. That is how the deployed
API runs too, so what works on a laptop works deployed, and no real record ever sits on a laptop: production's
database has no public address and production's keys are never in a local `.env` (CLAUDE.md, "Data rules").

## What it is

- **`Postgres` in Railway's `dev` environment**, declared in `.railway/railway.ts`, with a public TCP proxy so
  laptops can reach it. It is set up like production: the owner runs migrations and the seed, the API connects as
  the restricted role `ad_app`, and every connection uses TLS (`sslmode=require`; the API refuses to start
  otherwise, `apps/api/src/startup-checks.ts`).
- **`api-dev`**, an API beside it on Railway's private network, with a public domain. Nothing deploys it
  automatically (no GitHub source). You deploy the working tree you are on, uncommitted changes included:
  `apps/api/scripts/deploy-dev.sh`.
- **Dev keys only**: the dev Clerk instance (`sk_test_`) and a dev R2 bucket. Never a live key and never the
  production bucket.

## Set it up (once per project)

1. Create the Railway project and the `dev` environment (`railway environment new dev`), then apply the
   declaration: `railway config plan` and `railway config apply` from the repository root (needs `npm install`,
   which brings the `railway` SDK). No backups on dev: it holds a fictional seed that `db:seed` recreates.
2. Fill `apps/api/.env` from `railway variables -s Postgres -e dev` (the TCP proxy domain and port, the Postgres password): both URLs on that host, both with
   `sslmode=require`, the owner in `SCHEMA_DATABASE_URL`. Then, as the owner: `npm run db:migrate -w @ad/api`,
   `APP_ROLE_PASSWORD=<24+ chars> npm run role:create -w @ad/api -- --confirm-host <host:port>`, put the URL it
   prints in `DATABASE_URL`, `npm run db:seed -w @ad/api`.
3. Create a dev Clerk instance for this product; put its `sk_test_` key in `apps/api/.env` and its `pk_test_` key
   in `apps/web/.env.local`. Create the four demo people in it with the seed's emails (listed under "The demo people" below); their
   first sign-in takes over the seeded memberships.
4. Create a dev R2 bucket (private, no public access) and put its keys in `apps/api/.env`. Add the lifecycle rule
   below to it.
5. `apps/api/scripts/railway-dev-vars.sh --apply` copies the dev keys to `api-dev` and sets the database URLs on
   the private host; then `apps/api/scripts/deploy-dev.sh`. Check `curl https://<domain>/api/health`.

## The one manual bucket step: expire retained copies

Before an owner deletes an engagement or a workspace the API builds them a full export (in parts when it is big) and keeps its own copy at
`retained/<workspaceId>/<engagementId or workspace>-part<n>-<timestamp>.zip` for 30 days (`RETAINED_COPY_DAYS`), to cover an
accidental delete or a failed download. Nothing in code expires it; the bucket does. We cannot set this from code, so
do it once on **each** bucket (dev now, production before the first real row), in the Cloudflare dashboard: R2,
the bucket, Settings, Object lifecycle rules, Add rule:

- Prefix: `retained/` (exactly this; the rest of the bucket is workspace folders and must never expire)
- Action: delete objects 30 days after they were created
- Check it shows as enabled. Until it exists, retained copies (which hold personal records) are kept forever.

The retained copy is the one key outside the `<workspaceId>/...` layout, on purpose, so one rule covers it.

## Every day

`npm run dev` runs the API and the web app on your machine against the dev database. The dev database is shared:
`npm run demo:reset -w @ad/api -- --confirm-host <host:port>` empties it and reseeds, so say so before you run it.
Migrations are shared the same way: `db:migrate` applies yours for everyone.

## The demo people

The seed makes two fictional workspaces. Sign in as one of these people (they exist in the dev Clerk instance
with these emails; the first sign-in takes over the seeded seat). Sam's seat is the
test account `test@chowworks.com`.

| Person        | Email                         | Role                  | Sees                                                                                                    |
| ------------- | ----------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------- |
| Dana Okafor   | dana.okafor@riverbend.example | bookkeeper, Riverbend | Riverbend's engagement: July and August closed and submitted, September draft with five blocking checks |
| Sam Whitfield | test@chowworks.com            | owner, Riverbend      | The same, plus personal documents, the people and the lists of the workspace                            |
| Jules Park    | jules.park@riverbend.example  | auditor, Riverbend    | Everything in Riverbend, read-only, personal documents included                                         |
| Lee Tanaka    | lee.tanaka@harbortech.example | bookkeeper, Harbor    | Only Harbor Tech's workspace: an engagement missing its proposal and narrative                          |

The story: as Dana, the overview says September is owed and lists what is missing. Open the engagement:
steps 1 to 4 are on file (proposal, award letter, narrative, contract), July and August are signed and in,
September is the month that needs you. Open September, attach the missing allocation worksheet and the bank
statement, remove the G&A row the rule flagged as indirect, record the month-end closing as approved by Sam
Whitfield, attach the signed copy, submit. As Sam, My workspaces shows Riverbend's people, roles and
the source-of-funds list; "Set up an award" walks the five-step setup, starting at the proposal or the award.

Reset the demo to its starting state (the dev database is shared, so say so first):

```bash
npm run demo:reset -w @ad/api -- --confirm-host <host:port of SCHEMA_DATABASE_URL>
```

## Production

`.railway/railway.ts` declares it too: the GitHub source, `NODE_ENV=production`, no TCP proxy on Postgres, no seed
in the start command, and the `Postgres-PITR` bucket: switch daily backups and point-in-time recovery on in the
Postgres volume's settings before the first real row. CI applies the file and deploys the API on every push to `main` once the repository variable
`RAILWAY_PROJECT_READY` is `true` and the secret `RAILWAY_TOKEN` is set. The production secrets (`preserve()`
values) are set once in Railway by an owner and never written down.
