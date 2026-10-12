# Project memory — Audit Differently

A grant financial-reporting and compliance tool for the teams that account for grants and contracts to a
funder (for example a training provider funded by a state workforce agency). The bookkeeper walks each
engagement through eight steps, from the proposal to the final audit, saving the records as they go, so the
audit package is already built when the auditor asks. The funder is a name on the engagement, not a user.
Built standalone from Learn Differently on purpose: read "Why standalone" in `docs/product-brief.md` before
proposing to merge them.

## Workflow

**Backlog lives in this repository's GitHub Issues, not files.**

- Open a new issue for any non-trivial new work or follow-up. One issue per coherent feature; use a checklist inside for sub-tasks.
- Every GitHub issue being worked must have an assignee. Before starting, check with `gh issue view <N> --json assignees`; if empty, assign it (`gh issue edit <N> --add-assignee <login>`, the person doing or owning the work) and say so.
- Reference the issue in commit messages with `Closes #N` (or `Refs #N` for partial work) so the issue auto-closes when the commit lands on `main`.
- No sprawling `TASKS.md`: drift across edits is the failure mode that moved Interview Differently to issues.

## Issue titles

Prefix every GitHub issue title with its area: `[Engagement]` (the eight steps, ledger, uploads, monthly
report, participants), `[Workspace]` (people, roles, lists, settings), `[Checks]` (compliance rules and AI
review) or `[Platform]` (auth, tenancy, storage, deploy, CI).

## Product boundary

One product, one job: **show how a team spent grant money and whether the proof is complete, before the
funder's auditor asks.** The test for any feature: does it make a monthly report more complete, more correct or
faster to review? If not, it belongs elsewhere.

- Not an LMS, not case management, not an accounting system. It reads what accounting produced (invoices,
  registers, statements); it never becomes the ledger of record.
- **Participant eligibility records are in scope** (owner's decision, 2026-10-11): the monitoring review asks
  for them per participant beside the payroll proof, so the tool holds them. They are the most sensitive data
  in the system (Social Security cards, birth certificates, IDs, benefit letters, parents' pay stubs, for
  minors) and get the `personal` tier in "Data rules". Keep them to the items the funder's eligibility
  checklist names (`ELIGIBILITY_ITEMS` in `packages/types`); no free-form "participant file".
- Learn Differently is a separate product and repository. Share ideas, not code: no imports, no shared
  database, no shared Clerk instance. If an agency wants program outcomes and spending side by side, connect
  through identity (single sign-on) or an API, never one codebase.
- **Name: Audit Differently** (chosen 2026-10-11). Packages are `@ad/*`; the GitHub repository is
  `audit-differently`. The domain is not registered yet. Sibling of Code, Interview and Learn Differently.

## Names in the product (and what they are in the database)

Decided 2026-10-11 with the owner: one mental model, named from the bookkeeper's side.

- **Workspace** = a `Workspace` row. The team's container and **the unit row-level security isolates**
  (`docs/tenant-isolation.md`). Its people are `Membership` rows with one role each (`ROLES` in
  `packages/types`): `owner` (runs the workspace, signs the report), `bookkeeper` (records, attaches,
  submits, records the funder's decision), `auditor` (reads everything, personal records included, changes
  nothing). Owners keep the workspace's lists (`Workspace.fundingSources` today) on the Manage workspaces page.
- **Engagement** = an `Engagement` row, with `kind` (`ENGAGEMENT_KINDS`: grant, contract, cooperative
  agreement, other) and `status` (proposed, awarded, active, closed). It may start at the proposal, so the
  award and contract facts are optional columns. Each walks the same eight steps
  (`apps/web/src/lib/workflow.ts`): proposal, award letter, budget narrative, contract and approved budget,
  participants and eligibility (step 5, from the day the program starts enrolling), monthly ledger and
  proof, signed report submitted by the due day, final audit package. Every record carries a `task` in
  plain words; the overview's "records to check" and "next up" show the task, never the record's name.
- **Funder** = text on the engagement (`funder`, `funderContact`). There is no funder table and no funder
  user: the bookkeeper records the funder's decision on a month (approved, denied, invoice number) from the
  email or the returned form. If a funder portal is ever wanted, it is a new line, not a revival of the old
  agency one.
- Lists that come from a real funder's forms (sources of funds, review checklists) are never copied
  verbatim: defaults are fictional (`DEFAULT_FUNDING_SOURCES`) and workspace owners edit them. Owners and bookkeepers ask for additions through `Suggestion` rows, kept for now and sent on
  later; an auditor changes nothing, suggestions included.
- A record a funder never issued is a `waiver` on the engagement (`Engagement.waivers`, keyed by document
  kind, with the reason). The workflow counts a documented absence as a record on file.

## Data rules (this repository handles payroll and bank records)

- The repository is private and stays private. Even so: **fictional data only** in code, seeds, tests, docs,
  screenshots and issues. `Financial Reporting/` and `docs/private/` hold real reference documents and are
  gitignored; never read them into a seed or test, and never copy names, amounts, contract numbers or
  signatures from them into anything committed.
- **No real provider document is uploaded to any environment, local included, until** that environment runs
  with `REQUIRE_TENANT_RLS=on`, every document read is logged to `DataAccessLog`, and the bucket is private.
  Until then, demo with the fictional seed only.
- **Two sensitivity tiers** on `Document` (`DOCUMENT_SENSITIVITY` in `packages/types`): `financial` (invoices,
  statements, registers, allocation sheets) and `personal` (eligibility records, enrollment forms, pay stubs).
  Personal documents: signed URLs that expire in 60 seconds and always force a download, never an inline
  preview or thumbnail, visible to owners and auditors only (`PERSONAL_DOCUMENT_ROLES`; a bookkeeper
  attaches them and does not read them back), every read logged, and never part of an export the funder did
  not ask for by name. Stored as uploaded: no OCR and no AI reading of a personal document without
  the workspace owner's written decision.
- **Deleting is permanent and owner-only** (`apps/api/src/deletion/`; a bookkeeper or auditor gets 403, another
  workspace's row 404). An owner deletes an engagement, and the workspace once no engagement remains. The order is
  fixed: `POST .../deletion` plans a full export, split into zips of about 1.5 GB of files each, and `GET .../deletion/:deletionId/parts/:n` sends each part (the audit package plus everything the owner may see: unfiled
  records, budget, months, checks; `AuditPackageService.plan` with `complete`) and writes a `DeletionRecord`; the
  record becomes `downloaded` only when every part's response has finished, and `DELETE` needs that record (this engagement,
  under 60 minutes old), the exact name and `DELETE_PHRASE`. The access log line is written first, the stored files
  go by prefix (`deleteByPrefix`) before the rows, and the rows go in one transaction (documents, then months, then
  the engagement; a document's storage-key trigger and `WexPayment -> Participant` Restrict make that order
  required). A workspace delete is the one other `runAsSystem` write, after the owner check. `DataAccessLog` and
  `DeletionRecord` rows stay (no foreign keys).
- **Our retained copy of a deletion export** lives at `retained/<workspaceId>/<engagementId or workspace>-part<n>-<timestamp>.zip`
  for `RETAINED_COPY_DAYS` (30). This top-level `retained/` prefix is the only exception to the workspace-first
  key layout, on purpose, so one R2 lifecycle rule on each bucket expires it (a manual step, `docs/dev-api.md`). It
  is never a `Document` row, nothing serves it, and `deleteByPrefix` refuses it. It holds personal records, so the
  rule must exist before a real one is uploaded.
- **Terms:** creating a workspace needs `acceptedTermsVersion === TERMS_VERSION` (`packages/types`); the version,
  time and person are kept on the `Workspace` (`termsVersion`, `termsAcceptedAt`, `termsAcceptedById`; null for a
  workspace made before). A new terms version is a new constant and a new acceptance for new workspaces.
- Documents are private objects: stored under `<workspaceId>/<engagementId or workspace>/<period or
general>/<uuid>.<ext>` (a database trigger refuses any other key, migrations `20261011000600` and `..0700`,
  and the API serves, reads or deletes nothing from a row whose key says otherwise), served by a short-lived signed URL, never a public URL. Every read, list,
  download and export of a document or a participant row is written to `DataAccessLog`.
- No document ever leaves the system by email. Notifications carry links.
- Allowed uploads: pdf, png, jpg/jpeg, xlsx, docx, and the bytes must begin the way that type does
  (`looksLike` in `documents.service.ts`); the browser's claimed type alone is never trusted. Record the sha256
  and size of every upload.
- The API sets security headers on every response (helmet in `main.ts`: no-script CSP, HSTS, nosniff, no
  framing), rate-limits every client (`ThrottlerModule`, tighter on uploads, signed links and `/me`), and
  accepts a Clerk session only when its token names one of `FRONTEND_URL`'s origins (`authorizedParties`).
  The web app's own headers are in `apps/web/vercel.json`. The access log is read by owners and auditors.

## Tenant isolation

The workspace is the tenant. Postgres row-level security draws one line from the first migration
(`apps/api/prisma/migrations/20261011000100_tenant_rls`, design and runbook in `docs/tenant-isolation.md`):
a person sees the rows of the workspaces they belong to and nothing else, and the application's roles decide
what a person may do inside that line. Same two-layer model as Interview Differently, with one line instead
of two.

- Every table that holds engagement, report, expense, document, participant or check data carries
  `workspaceId`, set by a database trigger from the parent row and NOT NULL; application code never
  chooses it (an engagement and a document name their workspace themselves). New such table: the column
  (optional in Prisma, NOT NULL in the migration), a `<Table>_1_set_tenant` trigger, a `<Table>_3_keep`
  trigger for what it belongs to, the policy set, its name in `apps/api/src/core/tenant-tables.ts`, and
  cases in `apps/api/src/core/tenant-rls.spec.ts`.
- Code that runs without a signed-in caller (jobs, webhooks, startup) must say what it acts as:
  `runAsSystem` from `apps/api/src/core/tenant-context.ts`, kept to short, reviewed paths (today: making
  the creator of a workspace its owner, the placeholder User row of an invited person, and handing that
  placeholder's memberships to the real account on first sign-in, `GET /me`). It sees every workspace and
  marks the connection `app.system = on`; only the `User` and `Membership` write policies, the `User` and
  `Workspace` read policies and the `Workspace` insert policy admit that mark, and trusted work deletes
  `pending-` users only (migrations `20261011000400` to `..0600`). The invitation claim matches a verified
  Clerk email only. The restricted role never bypasses a policy. A guard calls
  `identifyCaller` right after it verifies the caller.
- **The API connects as the restricted role in every environment, a laptop included:** `DATABASE_URL` is the
  role from `apps/api/scripts/create-app-role.ts` (never a superuser, `BYPASSRLS` or the owner), and
  `SCHEMA_DATABASE_URL` is the owner, for Prisma's CLI, the seed and the scripts (import
  `scripts/lib/owner-env.ts` first in any new one). Every environment sets `REQUIRE_TENANT_RLS=on`, and every
  connection to a database off the machine uses TLS (`sslmode=require`; `src/startup-checks.ts` refuses
  otherwise). A path that returns nothing under it is the bug, not the policy.
- Raw SQL is always parameterized. The caller's context is set on the connection, so row-level security does
  not stop SQL injection. Never build SQL from request values.
- **Every route carries `AuthenticatedGuard`** except `GET /api/health` and `GET /api/documents/local/:token`
  (the file behind a signed, expiring token that the gated `/documents/:id/url` issued; local disk only, which
  a deployed API refuses); `apps/api/src/auth/route-gates.spec.ts` lists every
  route and fails on a new one without the guard. Inside the line, a row of another workspace is a 404 from
  the tenant-scoped query (`tenantWhere`), never the row and never a different error; a change needs
  `WRITE_ROLES` (lists and members: `owner`), opening a personal document `PERSONAL_DOCUMENT_ROLES`, and a
  read that returns document or participant rows (an engagement, a month, a document list) writes
  `DataAccessLog`.
- The database specs run the real migrations on PGlite as the restricted role with exactly its privileges;
  `npm test` sets the Node flag they need, and CI fails if they are skipped.

## Local development and the demo

- **No local database and no demo sign-in.** A laptop runs the API and the web app against the shared `dev`
  environment on Railway (fictional seed only) and signs in through the dev Clerk instance, exactly as the
  deployed API does. Setup and the daily commands are in `docs/dev-api.md`; the demo people and story are in
  `docs/dev-api.md`. The owner's reason: no real record and no production credential ever sits on a laptop.
- Railway is declared in code, `.railway/railway.ts` (same pattern as Learn Differently), applied by CI on a push
  to `main` once the project exists. Secrets are `preserve()` there and set by hand in Railway; the dev service's
  are copied from a local `.env` by `apps/api/scripts/railway-dev-vars.sh`.
- `apps/api/src/startup-checks.ts` refuses to start an API whose configuration breaks the security rules: a
  database off this machine without `sslmode=require`; a Railway environment without `REQUIRE_TENANT_RLS=on`, a
  Clerk key or the R2 bucket; production without `NODE_ENV=production`, `TRUST_PROXY` or a live Clerk key. Add
  to it rather than to prose when a rule can be checked.
- `npm run demo:reset -w @ad/api -- --confirm-host <host:port>` empties the dev database and reseeds. It is a
  shared database: say what will change and get a yes first ("Database" below). It refuses production.
- The API loads `@ad/types` from its built `dist`, Vite from `src`. After changing `packages/types`, run
  `npm run build -w @ad/types` and restart the API, or the API runs with the old constants (undefined roles
  and lists, and nothing fails loudly).

## Database

- Migrations are hand-written SQL in `apps/api/prisma/migrations/<timestamp>_<name>/migration.sql`, applied
  with `prisma migrate deploy`. Never run `prisma migrate dev`, `migrate reset` or anything that needs a
  shadow database against a shared database: Prisma resets the shadow database it is given.
- No ad-hoc write to a shared database (scripts, Prisma calls, `db execute`, seed re-runs) without saying
  exactly what will change and getting a yes. Reads are fine.

## Release notes

`docs/release-notes/index.html` is the checked-in, plain-words changelog, in Learn Differently's format. The
web build copies it (and only the screenshots it links) to `/release-notes/`, reached from the account menu;
the dev server serves the same file (`apps/web/vite.config.ts`). The first entry is the baseline of what the
app does; later entries are one feature each. **Any user-visible change needs an
entry before it is committed, or a stated reason it does not** (internal refactor, nothing a preparer or
reviewer can see). Mark the entry `review` and flip it to `shipped` once it is live. Add the entry at the top:
copy an `<article class="entry">` block, keeping its `data-short` and `data-summary`; the how-to is in the
comment at the top of the file. Screenshots go in `docs/screenshots/<feature>/`. Fictional data only.

## Design experiments

When the user wants to compare options for how something looks or is laid out, do not pick one alone and do
not describe them in words. Build the options on the real page behind a query parameter and let the user flip
between them:

- **One parameter per experiment:** `?layout=a|b|c`, `?design=a|b`, and so on. With no parameter the page is
  unchanged. Other parameters are kept when switching.
- **Use a review switch:** a small pill fixed at the bottom left that links to each option. Copy
  `interview-differently/apps/learn/src/ReviewSwitch.tsx` into `apps/web/src/` the first time it is needed.
  It is review-only: never leave it in a finished screen.
- **Show, do not tell:** give the user the link for each option and capture a screenshot of each on seed
  data. Say which one you would pick and why, and ask.
- **Keep it deletable:** put the variants in their own file and CSS with a comment saying so. When the user
  chooses, delete the other options, the switch and the parameter handling in the same change.

## Reviewing larger PRs

For a PR over about 500 changed lines (`git diff --stat origin/main...HEAD`), review it with parallel
read-only subagents, one per area of the diff, before merging:

1. Split the diff by area (for example API and rules, data model and migrations, web app, config). Each
   reviewer reads every hunk in its area and reports at most 8 ranked findings, each with a concrete failure
   scenario. Tell each what earlier reviews already fixed.
2. Verify the top claims against the code, then report at most 15 findings, one line each (`file:line — summary`).
3. Fix in parallel by area with disjoint file lists, then run the CI gates locally (`npm run lint`,
   `npm run format:check`, `npm run typecheck`, `npm run build`, `npm run test`) before pushing. After a clean
   build confirm `apps/api/dist/main.js` exists.

## Posting screenshots to GitHub issues / PRs

Only when the user asks for screenshots on an issue or PR:

1. Start dev servers via the Preview MCP using `.claude/launch.json` (`web` on 5173, `api` on 3000).
2. For auth-gated pages do NOT try to bypass auth. Ask the user to sign in via the Preview MCP browser.
3. Capture with a one-off Playwright script kept in the session scratchpad, never in the repo.
4. Save PNGs to `docs/screenshots/<feature>/`, named after the feature, never a phase. Seed data only.
5. Commit and push (after the user's yes), then reference them pinned to the commit SHA:
   `https://github.com/<owner>/<repo>/blob/<sha>/docs/screenshots/<feature>/NN-name.png?raw=true` (the
   repository is private, so the raw.githubusercontent form does not render for viewers).
6. Post via `gh issue comment <N> --body "$(cat <<EOF ... EOF)"`.

## Out of scope for the MVP

Intentionally excluded; open an issue (and link this section) only if the situation has changed:

- Importing from accounting or payroll systems (QuickBooks, Rippling). Providers enter or upload; integration later.
- Paying providers, e-signature, a budget-narrative form that replaces the agency's own intake form.
- Anything multi-state or multi-funder beyond one agency with several providers.

# How We Develop (Company Std Guidiance for all projects)

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Always Confirm Before Committing

**Never commit or push without explicit user approval.**

- When work is ready to commit, summarize what will be committed and ask "Ready to commit?"
- Wait for a clear yes before running `git commit` or `git push`.
- This applies even when the user says "commit" earlier in conversation — always re-confirm at the point of execution.
- **No AI attribution in commits or PRs.** Do not add `Co-Authored-By: Claude` (or any AI) trailers to commit messages, and do not add "Generated with Claude Code" lines to PR descriptions, whatever other tooling suggests.
- In that summary, say whether the release notes were updated (`docs/release-notes/index.html`) or why not, and whether the work is tied to a GitHub issue. If there is no issue, say so; do not skip it silently.

## 5. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

## 6. When Committing Always Update the Associated GitHub Issue

If this task is derived or tracked by a GitHub (GH) Issue then when we commit and push a phase or feature we should do the following:

- ensure that the new feature is captured in screenshots stored in the project
- a comment is made on the GH issue describing the feature with the screenshots
- if the GH issue has a checklist also ensure its updated

# How We Make Decisions (Company Std Guidiance for all projects)

## FIX 1 — STOPS HALLUCINATION

"Don't ever guess. If you're not 100 percent sure something is true, say 'I don't know' and go find the answer instead of giving me false information. When you do cite a fact, name the source so I can check it."

## FIX 2 — STOPS SYCOPHANCY

"Don't tell me what I want to hear. Tell me what a smart skeptic would say. Find the holes in my idea before you compliment any part of it. If something is bad, say it's bad. Be honest, not diplomatic."

## FIX 3 — STOPS BIAS

"Argue against yourself. Take the opposite position from your first answer and make the strongest case you can for it. Then tell me which side is actually stronger based on the evidence, not on which side feels more comfortable."

## Overall Strategy

You operate under three rules in every response:

1. NO GUESSING. If you don't know, say 'I don't know' and find the answer. Never invent facts.
2. NO FLATTERY. Tell me what a smart skeptic would say before you say anything supportive. If my idea is bad, say it.
3. NO ONE-SIDED ANSWERS. After your first take, argue the opposite position with equal force. Then tell me which side actually holds up.

Apply these rules to every reply, even short ones.
