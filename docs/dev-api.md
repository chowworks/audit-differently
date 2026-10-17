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
6. Emailed receipts (optional; off until all three are set). Dev uses **its own Resend account**, never production's:
   a Full access key reads every email its account received, and this key sits in a `.env`. In the dev account, add
   the dev receipts subdomain (a `receipts-dev` subdomain, receiving on) and its MX record at the DNS host, add a
   webhook for `email.received` to `https://<api-dev domain>/api/inbound/resend`, and create a Full access key. Put
   them in `apps/api/.env` as `RECEIPTS_DOMAIN`, `RESEND_WEBHOOK_SECRET` and `RESEND_RECEIVING_API_KEY`, rerun
   `railway-dev-vars.sh --apply`, then redeploy `api-dev` (the script sets variables without a deploy). The webhook
   answers 401 to an unsigned request once it is on. Mail the demo address (`riverbend-youth@<dev receipts
subdomain>`) from a demo person's verified address to try it.
   Other developers leave the three blank in their own `.env`: emailed receipts are rows in the shared dev database,
   so they see them anyway, and a local API with them blank runs no inbound worker. A worker only ever claims mail
   sent to its own `RECEIPTS_DOMAIN`, so a laptop set up otherwise never takes dev's mail.

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
`npm run demo:reset -w @ad/api -- --confirm-host <host:port>` removes the demo workspaces and reseeds them (people, their
Terms acceptances and other workspaces stay), so say so before you run it.
Migrations are shared the same way: `db:migrate` applies yours for everyone.

## The demo people

The seed makes two fictional workspaces. Sign in as one of these people (they exist in the dev Clerk instance
with these emails; the first sign-in takes over the seeded seat). Sam's seat is the
test account `test@chowworks.com`.

| Person        | Email                         | Role                  | Sees                                                                                                 |
| ------------- | ----------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------- |
| Dana Okafor   | dana.okafor@riverbend.example | bookkeeper, Riverbend | Riverbend's engagement: July and August closed and submitted, September a draft with blocking checks |
| Sam Whitfield | test@chowworks.com            | owner, Riverbend      | The same, plus personal documents, the people and the lists of the workspace                         |
| Jules Park    | jules.park@riverbend.example  | auditor, Riverbend    | Everything in Riverbend, read-only, personal documents included                                      |
| Lee Tanaka    | lee.tanaka@harbortech.example | bookkeeper, Harbor    | Only Harbor Tech's workspace: an engagement missing its proposal and narrative                       |

The story: as Dana, the overview says September is owed and lists what is missing. Open the engagement:
steps 1 to 4 are on file (proposal, award letter, narrative, contract), July and August are signed and in,
September is the month that needs you. Open September, attach the missing allocation worksheet and the bank
statement, remove the G&A row the rule flagged as indirect, record the month-end closing as approved by Sam
Whitfield, attach the signed copy, submit. As Sam, My workspaces shows Riverbend's people, roles and
the source-of-funds list; "Set up an award" walks the five-step setup, starting at the proposal or the award.

What else the months show, all fictional and drawn by `apps/api/prisma/demo-payroll.ts`:

- **Payroll proof, highlighted.** Each month from August has one pay run (a program coordinator, Morgan Reyes, and
  the three work-experience youth): a time report, a payroll register, a pay stub per participant and the bank
  statement. Every link carries the exact words highlighted on it (`marks`, plus the matched line in `mark`), worked
  out by the API's own reader and matcher (`readStatement`, `matchSlot`, the highlight settings in force), so "Show",
  the item's proof copy and the audit package draw boxes that sit on the words.
- **August** is complete: every staff and participant pay item has its timesheet, register and evidence of payment.
  It was submitted on 09/11, reopened on 09/14 to correct the mileage line (the reopening is on file with the first
  signed copy), and submitted again on 09/15 with a corrected signed copy.
- **September** is half matched: Jordan's pay is fully proved; Riley's pay stub is filed but not linked (missing proof
  of payment); Casey's pay was entered as $300.00 where the stub says $280.00 (proof mismatch); the coordinator's
  wages, RYS-18, have their timesheet and register but no bank line yet (Unmatched payments). A Bright Path receipt,
  read from its text, waits in Match receipts for RYS-19.
- Receipts and invoices carry the amount, date and vendor read from them; expenses and pay carry tags; the workspace
  has a saved import mapping, "Ledger & Co. export".

The payroll sample zip (`apps/web/public/samples/payroll-sample.zip`) is its own fictional September pay run for
the same three participants and pay period, for trying "Match payroll & timecards" from the start.

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

Emailed receipts in production use the main Resend account: the receipts subdomain with its MX record pointing at
Resend, a webhook for `email.received` to `https://<production API domain>/api/inbound/resend`, and a Full access key
made for production alone. All three variables are set on the production service only, never in a local `.env`.

### The demo workspace in production

Production comes up with one fictional workspace to show the product: Riverbend Youth Services with DEMO-26IS-RYS,
the same story as dev (July, August, September above) and nothing of Harbor Tech or the emailed-receipts queue.
`npm run demo:seed -w @ad/api` loads it (`apps/api/scripts/demo-seed.ts`, which calls `seedDemoWorkspace` in
`apps/api/prisma/seed.ts`). It is safe on a database with real workspaces because:

- it builds that one workspace again: the workspace marked Full demo (`featuredDemo`), if there is one and it is
  plainly the demo (its name, and only `DEMO-` engagements), is removed with its records and files first, so a demo
  seeded by an older version comes back whole; it empties no table and writes nothing in another workspace. Anyone
  seated in the demo seats themself again;
- it refuses, changing nothing, when two workspaces match, when the match has another name or receipts address, or
  when it holds an engagement whose number does not start with `DEMO-` (a real customer by that name stays untouched);
- the dev seed (`db:seed`) and `demo:reset` refuse to run in production; only this script does;
- it adopts an existing workspace only when it is already marked as the demo (`featuredDemo`); one an admin made for
  a real customer of the same name is refused, and a new demo workspace is marked from its first row;
- it does not guess where it runs from the shell's variables, so it behaves the same from a laptop: its files go to
  `R2_DOCUMENTS_BUCKET` under the demo workspace's own prefix (it refuses without it unless the database is on this
  machine), every run writes its access-log line, and its personas, the owner's seat included, are `.example`
  addresses no one can verify unless `DEMO_OWNER_EMAIL` names one, so no account takes a seat. A platform admin who
  wants to walk it seats themself from Admin tools, and the log says so.

Run it only with the owner's yes at the time (it writes to the production database), as the database owner, from a
shell on the production API service, since production's Postgres has no public address:

```bash
railway ssh -e production -s audit-differently
# inside the service (it has the service's variables: SCHEMA_DATABASE_URL, the R2 values)
cd /app && npm run demo:seed -w @ad/api        # prints the database host and stops
npm run demo:seed -w @ad/api -- --confirm-host <the host it printed>
```

Re-running it puts the demo back in its starting shape (its months, links and highlights; anything a visitor added
stays), and each run writes one access-log line in the demo workspace saying the demo data was loaded.
