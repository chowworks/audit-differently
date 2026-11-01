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

Prefix every GitHub issue title with its area. An engagement's work goes by its step: `[Proposal]` (step 1),
`[Award]` (step 2), `[Budgets]` (steps 3 and 4: budget narrative, approved budget lines), `[Participants]` (step 5:
participants and eligibility), `[Expenses]` (step 6's expenses: imports, receipts, matching, month-end closing),
`[Payroll]` (step 6's payroll: payroll proof, the payroll match, payroll details), `[Reports]` (step 7: the signed
report) or `[Audit]` (step 8: the audit package and exports). Outside an engagement: `[Workspace]` (people, roles,
lists, settings), `[Checks]` (compliance rules and AI review) or `[Platform]` (auth, tenancy, storage, deploy, CI).

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
  records the month-end closing, submits), `auditor` (reads everything, personal records included, changes
  nothing). Owners keep the workspace's tags (`Workspace.tagTypes`) under Configuration Data on the
  workspace's page, and set its receipts address (`receiptsAddress`); an owner may change it but never clear it, and admins don't set it.
  Every address used is kept in `ReceiptsAddress` (migration `20261017000400`); one in use or used before and not
  released is never chosen again, and the owner is told only "That address isn't available; choose another". Mail to a
  previously used address is refused and kept with no sender or subject, so its count is worked out, never stored.
  Owners don't see past addresses (owner's decision, 2026-10-17). Owners also set "Bookkeepers see
  and process payroll" (`Workspace.bookkeepersSeeStaffPayroll`, on by default): off, a bookkeeper's month pages show the payroll
  lines without their proof links or the payroll match (`ReportDetail.can.seeStaffPayroll`; owner's decision,
  2026-10-20: hiding the links is all it does); the screen only, the API is unchanged (owner's decision, 2026-10-17).
- **Budget lines** = `BudgetLine` rows of an engagement: its approved budget, as the contract states it (step 4, Manage
  Budget). Each has a name, the line of the funder's monthly report it is on (`reportLine`; the name defaults to it,
  since this funder budgets by report line), an approved amount and a note. **Every expense is spent against one**
  (`Expense.budgetLineId`; its `reportLine` follows from it, trigger `Expense_4_budget_line`, migration
  `20261017000200`), so spending is compared with the approved budget line by line: the month's budget tile, the
  `budget-overrun` check, a blocking `no-budget-line` check, and the audit package's `Budget vs actual.csv`. A line with
  spending keeps its report line and is not removed. Imports map categories to budget lines, saved by line name.
  The workspace's own list of budget items is gone (migration `20261017000300`); names are suggested from the
  workspace's other engagements.
- **Payroll on the budget** (owner's decisions, 2026-10-20): the pay the payroll match proves is the staff and
  participant pay on the budget. Each engagement's owner picks, on the budget line dialog, which line holds staff pay,
  staff taxes, participant pay and participant taxes (`BudgetLine.payroll`, migration `20261020000100`); Save writes
  the staff lines from the payroll details file (`Expense.payrollKey`). Importing transactions confirms the payroll
  rows it found ("Payroll transactions" step): they are kept marked (`Expense.payrollKind`, migration
  `20261020000200`), count on the budget until the match covers that kind on the month, then are hidden and kept for
  the reconciliation's "Expenses vs payroll files" (a difference means the books are off, not the report);
  re-importing the file is how a row's choice is changed. Which tax types count is issue #29.
- **Month End Payroll Processing** (`/workspaces/:id/payroll`, owner's choice 2026-10-20): Actions first (each with
  Review below), Engagement Budget Tracking, then Workspace Reconciliation, whose tiles (Missing proof, To check,
  Paid not grant-funded, Expenses differ, Staff w/o charges, Proof complete) filter its grid and the expenses table,
  then File Management with Match again; Save returns to this page.
- **Tags** = `Workspace.tagTypes` (owner-kept types and values, stable keys; "Funding source" is the built-in first
  type, migration `20261016000800`), applied as `tags` (`<type>:<value>`) on `Expense`, `WexPayment` and `Participant`,
  from the list only, never free text. A source in use can't be removed or renamed. Participant and payroll tags
  are personal data: logged by field name ("Tags"), never values.
- **Engagement tracks** = `Engagement.tracks`: which of proposal, award letter and signed contract the team keeps
  here; the financials are always kept. A step not kept shows greyed out as "not used" and counts nowhere.
- **Engagement** = an `Engagement` row, with `kind` (`ENGAGEMENT_KINDS`: grant, contract, cooperative
  agreement, other) and `status` (proposed, awarded, active, closed). It may start at the proposal, so the
  award and contract facts are optional columns. Each walks the same eight steps
  (`apps/web/src/lib/workflow.ts`): proposal, award letter, budget narrative, contract and approved budget,
  participants and eligibility (step 5, from the day the program starts enrolling), monthly ledger and
  proof, signed report submitted by the due day, final audit package. Every record carries a `task` in
  plain words; the overview's "records to check" and "next up" show the task, never the record's name.
- **Platform admin** = a person whose Clerk `publicMetadata.role` is `admin` (`PLATFORM_ADMIN`; same convention as
  Interview Differently), not a `Membership` role. On the **Admin tools** page (`/admin`, from the account menu; an
  admin in no workspace lands there) an admin lists every workspace with its people, creates one for a customer
  with its first owner named by email (`POST /workspaces`, the only way a workspace is made), renames any
  workspace and manages its people and lists, reads its suggestions (`/admin/workspaces/...`), and makes or unmakes
  other admins (`/admin/users`, `/admin/admins`; never their own role; at most 20, `MAX_PLATFORM_ADMINS`; every
  attempt that reaches Clerk is an append-only `PlatformRoleChange` row, shown as "Admin changes"). Platform admins also see and rerun the emailed receipts that went nowhere or were refused or failed, metadata
  only, never attachments (owner's decision, 2026-10-16; Admin tools → Email administration). Email administration also lists every receipts address used, with the
  emails received since removal and when the last arrived (worked out from the refused emails), and an admin releases a
  previously used one (never a current one; no quiet period). The row keeps who released it and when (set by the
  database, `ReceiptsAddress_4_release`), its kept refused emails go, so its count starts again, and nothing is written
  in the workspace's access log (owner's decisions, 2026-10-17). A rerun of a workspace's
  row writes its access-log line in the same transaction, and the database refuses it without one (`app_admin_reran`,
  migration `20261016000100`). The signed-in person's own list is "Workspace Manager"; Admin tools has tiles (Manage admins,
  Manage workspaces, Email administration, File Matching: the matchers' statistics, the payroll reading words and day
  windows, proof highlighting and every change to them, on one page). Workspace level
  only: an admin reads no engagement, record, access log or deletion summary and deletes no workspace, and where they
  are also a member they have exactly that membership's rights. An admin **may seat themself** in any workspace, in
  any role (owner's decision, 2026-10-14), and then reads its records as that member; the log line says so ("…
  (platform admin) added themself as owner"), an address that is one of the admin's own verified Clerk addresses
  seats the admin's account, never a placeholder, and every other admin line ends "(by a platform admin)". An owner
  renames their own workspace on its page.
- **Funder** = text on the engagement (`funder`, `funderContact`). There is no funder table and no funder
  user, and the app does not record the funder's answer (owner's decision, 2026-10-15). Before a month is
  submitted, the bookkeeper records its **month-end closing**: the company's own approval (usually the CEO's,
  often given offline; `authorizedByName`, `authorizedAt`), or that it was sent back with a reason, which reopens
  the month. A month is `draft`, `closed` or `submitted`; a database trigger refuses ledger writes to a month
  that is not a draft. A submitted month can be reopened to correct it
  (`POST /reports/:id/reopen`, owners and bookkeepers, with a reason): it goes back to a draft without its
  submission or closing approval, its documents stay, and it is closed and submitted again. What a reopening undid is kept in
  `ReportReopening` (append-only; it goes only with its month): submitted on, the closing approval, who reopened
  it, why, and the signed copy as submitted. That signed copy is never replaced or removed; the corrected copy is
  attached beside it, and only a copy uploaded after the latest reopening counts. A budget or
  participant-file change re-checks every month, closed and submitted ones included, and the screen warns first. If a funder portal is ever wanted, it is a new line, not a revival of the old
  agency one.
- The default lists a workspace starts with are fictional (`DEFAULT_TAG_TYPES`), and workspace owners
  edit them. The funder's form page (`ReportFormPage.tsx`) reproduces the government form the team sends, in the
  form's own wording (Section VI's review checklist, the line numbers and headings; owner's decision, 2026-10-16);
  its filled-in values (names, amounts, contract numbers, signatures) never go into the repository. Owners and bookkeepers ask for additions through `Suggestion` rows, kept for now and sent on
  later; an auditor changes nothing, suggestions included.
- A record a funder never issued is a `waiver` on the engagement (`Engagement.waivers`, keyed by document
  kind, with the reason). The workflow counts a documented absence as a record on file.

## Data rules (this repository handles payroll and bank records)

- The repository is **public** (owner's decision, 2026-10-12), so everything committed, every issue and every
  comment is world-readable, the security design in these docs included. **Fictional data only** in code, seeds,
  tests, docs, screenshots and issues, and never a secret, a real hostname or a real key. `Financial Reporting/` and `docs/private/` hold real reference documents and are
  gitignored; never read them into a seed or test, and never copy names, amounts, contract numbers or
  signatures from them into anything committed.
- **No real provider document is uploaded to any environment, local included, until** that environment runs
  with `REQUIRE_TENANT_RLS=on`, every document read is logged to `DataAccessLog`, and the bucket is private.
  Until then, demo with the fictional seed only.
- **Two sensitivity tiers** on `Document` (`DOCUMENT_SENSITIVITY` in `packages/types`): `financial` (invoices,
  statements, registers, allocation sheets) and `personal` (eligibility records, enrollment forms, pay stubs).
  Personal documents: signed URLs that expire in 60 seconds, every read logged, and never part of an export the funder
  did not ask for by name. **Pay stubs are payroll files** (owner's decision, 2026-10-16): owners, bookkeepers and
  auditors open them (`personalRolesFor`), they show on the page with their matched line highlighted like a timesheet
  or a bank statement, and their mark keeps the line's text. **Eligibility records and enrollment forms** stay
  strict: owners and auditors only (`PERSONAL_DOCUMENT_ROLES`; a bookkeeper attaches them and does not read them
  back), always a forced download, never an inline preview or thumbnail, never marked.
  Documents may be read to match them: a receipt's amount, date and vendor, a line on a
  bank statement, a pay stub's pay period and pay (owner's decisions, 2026-10-15 and 2026-10-16). A bank's downloaded PDF has a text layer; a scanned one does not, and the screen says so
  rather than running OCR. Financial receipts and invoices are read for amount, date and vendor (PDF text
  first; Claude only when `ANTHROPIC_API_KEY` is set, `apps/api/src/receipts/read-receipt.ts`); a database check
  keeps those columns empty on a personal document. A payroll item's link to its proof (timesheet, register, pay
  stub or bank statement) carries its highlights: `marks`, boxes around the exact words a platform admin chose for
  that proof type (Admin tools → File Matching, `HighlightSetting`, append-only; defaults `DEFAULT_HIGHLIGHTS`), and
  `mark`, the line found (migrations `20261016001100` to `..1400`). **Every payroll proof stands on its own per
  item** (owner's decision, 2026-10-16): the viewer, the month bundle and the audit package show each item its own
  copy (`itemCopy` in `mark-pdf.ts`), drawn on the fly from the untouched original with the file's own highlight
  notes removed and only that item's highlights; the package also files each shared original once, as stored.
  Copies never claim a highlight they could not draw, and the viewer gets the bytes through the
  API (`GET /payroll/statements/:documentId/file`, `GET /payroll-match/:runId/files/:fileId`; members only, every
  open logged), never from storage directly.
  "Match payroll & timecards" stages the zip on the server (`PayrollMatchRun`, `PayrollMatchFile`,
  `apps/api/src/payroll/payroll-match.service.ts`): the browser sends the files, a background job reads each PDF's
  text lines (`payroll-match.worker.ts`; closing the wizard stops nothing, and reopening picks the run up), the lines
  are kept on the run only, matches are worked out from them on request, nothing is a `Document` until Save, and
  Discard or 24 hours removes the run and its staged objects.
  **The workspace payroll match** (owner's decisions, 2026-10-17): an owner also matches one zip for the whole workspace
  and a month (`/workspaces/:id/payroll`, `workspace-payroll.service.ts`) against every engagement's payroll items for
  that period; the per-engagement wizard stays. A workspace run has `period` and no month (`PayrollMatchRun`, migration
  `20261017000500`; owners only, by policy, its files included). Starting again for the same month answers the open run,
  and a file sent again (same kind and sha256) is skipped. Save files each file **once** as a workspace document
  (`<workspaceId>/workspace/<period>/`) linked from each item it proves, and keeps every person-pay found in it
  (`PayrollPayLine`: register rows, bank payments, pay stubs; only the not-grant-funded reason ever changes). A chosen
  item's closed or submitted month is reopened first, after the owner confirms the list and gives one reason, inside the
  save's own transaction (`ReportsService.reopenWith`/`sendBackWith`), so a failed save reopens nothing. The reconciliation (owners and auditors read it; one read line, counts only)
  shows each pay as matched, guessed, unassigned or not grant-funded, and each item with no proof; owners link a pay by
  hand or mark it not grant-funded. Each engagement's audit package files the shared original once plus its own
  highlighted copies. A workspace payroll file with saved pays keeps its kind, month, engagement and key
  (`Document_5_keep_pay_lines`), and a document an unsaved upload holds is not removed until that upload is saved or
  discarded (foreign key, 409 in plain words). Deleting an engagement or a workspace first discards any unsaved upload
  holding its documents, each with its line; the workspace payroll files only it links are re-checked inside the
  transaction, and their objects go only after commit; one another engagement links stays. Removing a workspace
  payroll file is owners only. **A bank statement shows a pay run as one debit** (owner's decision, 2026-10-19): the
  bank line of every item a run paid (staff lines and work-experience payments) is the statement's line of the
  register's stated total ("Total direct deposits", else its net column added up) near its pay date
  (`pay-runs.ts`, read by both match screens); a line per person is read only when no such debit is found, and a pay
  stub is compared with its register row, never a bank line. **A pay belongs to the month it was paid in**, by its pay
  date (the period's end only when none is printed; a period starting in the month before is still this month's): a
  run or stub paid in another month is flagged `other-month`, never filed. Matching is per run: a staff line gets the
  register row, time report and debit of the run paid on its date (`runsOfLine`; a line dated otherwise, every run of
  the month), and each pay stub makes one payment per pay period, with its own run's proofs. A file whose contents are already on an item, or filed on
  its engagement month (the bookkeeper's copy), is linked as that document, never as a copy; two different files as
  one proof are flagged for the owner in the plan and the reconciliation (both stay) only when they contradict each
  other: two pay stubs by their pay, hours or dates (one whose words can't be read is flagged; owner's decision,
  2026-10-20), a timesheet or register by another amount or other hours for the same person. A bank line passes
  the month's check when it shows the item's amount, or when it was matched as the debit of the run that paid the item
  (`payRun` on the link, migration `20261019000300`).
- **Deleting is permanent and owner-only** (`apps/api/src/deletion/`; a bookkeeper or auditor gets 403, another
  workspace's row 404). An owner deletes an engagement, and the workspace once no engagement remains. A month with
  nothing to submit (a draft with no expense, payroll, file or reopening) is the one smaller delete: an owner removes
  it from the month's More menu (`DELETE /reports/:id`), logged. The order is
  fixed: `POST .../deletion` plans a full export, split into zips of about 1.5 GB of files each, and `GET .../deletion/:deletionId/parts/:n` sends each part (the audit package plus everything the owner may see: unfiled
  records, budget, months, checks; `AuditPackageService.plan` with `complete`) and writes a `DeletionRecord`; the
  record becomes `downloaded` only when every part's response has finished, and `DELETE` needs that record (this engagement,
  under 60 minutes old), the exact name and `DELETE_PHRASE`. The access log line is written first, the stored files go by prefix (`deleteByPrefix`) before the rows, and the rows go in one transaction (documents, then months, then
  the engagement; a document's storage-key trigger and `WexPayment -> Participant` Restrict make that order
  required). A workspace delete is the one other `runAsSystem` write, after the owner check. `DataAccessLog` and
  `DeletionRecord` rows stay (no foreign keys).
- **Our retained copy of a deletion export** lives at `retained/<workspaceId>/<engagementId or workspace>-part<n>-<timestamp>.zip`
  for `RETAINED_COPY_DAYS` (30). This top-level `retained/` prefix is the only exception to the workspace-first
  key layout, on purpose, so one R2 lifecycle rule on each bucket expires it (a manual step, `docs/dev-api.md`). It
  is never a `Document` row, nothing serves it, and `deleteByPrefix` refuses it. It holds personal records, so the
  rule must exist before a real one is uploaded.
- **Terms:** the version is the fingerprint of the wording itself (`apps/api/src/auth/terms-fingerprint.ts`, computed
  once at startup from `docs/terms/index.html`'s `#terms` section; startup refuses without it), so there is nothing to
  bump. The admin who creates a workspace accepts nothing for it: the first of its owners who has accepted the current
  version is kept on the `Workspace` (`termsVersion`, `termsAcceptedAt`, `termsAcceptedById`), once, at `POST /me/terms`
  or at `GET /me` if they had accepted already (`MeController`, with a line in its log; a failure there is logged and
  never fails sign-in); null until then. Once on file it is never changed through the API (trigger
  `Workspace_5_terms_kept`; the database owner may still correct it).
- Every user accepts the Terms at first sign-in, and again whenever the wording changes (`TermsAcceptance`, append-only;
  the guard answers 403 `terms_required` until then, except `GET /me` and `POST /me/terms`, marked `@SkipTermsGate`).
- Documents are private objects: stored under `<workspaceId>/<engagementId or workspace>/<period or
general>/<uuid>.<ext>` (a database trigger refuses any other key, migrations `20261011000600` and `..0700`,
  and the API serves, reads or deletes nothing from a row whose key says otherwise), served by a short-lived signed URL, never a public URL. Every read, list,
  download and export of a document or a participant row is written to `DataAccessLog`.
- **Every change is logged with it** (`AccessLogService.change`): the write and its `DataAccessLog` line go in one
  transaction, so neither is kept without the other. The `description` says what the person did in the words of
  the screen they did it on; staff are named by email, never display name; `changes` come from `changesOf`
  (`src/core/changes.ts`), which keeps personal and free-text fields to their name alone. A page writes one read
  line when it is opened, never because it re-fetched after the person's own action (actions return the updated
  data), and nothing turns read logging off.
- No document ever leaves the system by email. Notifications carry links.
- Allowed uploads: pdf, png, jpg/jpeg, xlsx, docx, and the bytes must begin the way that type does
  (`looksLike` in `documents.service.ts`); the browser's claimed type alone is never trusted. Record the sha256
  and size of every upload. An exported transactions file (csv or xlsx, `apps/api/src/imports/`) is the one
  exception: read in memory to make expense lines, never stored as a Document; an xlsx must begin like a zip, a
  csv must be UTF-8 with no NUL byte; no row of it goes to AI (an AI guess sees real column names alone).
- The API sets security headers on every response (helmet in `main.ts`: no-script CSP, HSTS, nosniff, no
  framing), rate-limits every client (`ThrottlerModule`, tighter on uploads, signed links and `/me`), and
  accepts a Clerk session only when its token names one of `FRONTEND_URL`'s origins (`authorizedParties`).
  The web app's own headers are in `apps/web/vercel.json`. The access log is read by owners and auditors.

## AI in the app

Every AI feature is opt-in (owner's decision, 2026-10-16). The app works fully without one, and nothing is sent to
an AI model unless a person said yes.

- **Asked each time, never remembered:** a person ticks a box or presses a button for this one action (read these
  receipts, suggest this mapping). The box starts unticked every time the screen opens; no default, no "always".
- **One exception, an owner setting:** work with no person present (an emailed receipt) uses a workspace setting an
  owner turns on, off by default (`readEmailedReceiptsWithAi`), shown with who changed it in the access log.
- **Marked the same way everywhere:** the control sits in an `ad-ai-optin` box with the purple
  `<span className="ad-ai-tag">✨ Optional AI Automation</span>` chip, and one line under it saying exactly what is
  sent (which files, or column names only) and what is never sent. A new AI feature copies that markup.
- **Shown only when it can run:** hidden when the server has no key (`aiAvailable`), never shown disabled.
- **Checked by a person:** a person checks every result before it counts, and the screen says when AI made a
  suggestion.
- **Logged:** each use writes its access-log line in the words of the screen. The Privacy page describes AI and our
  services without naming vendors.

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
  `runAsSystem` from `apps/api/src/core/tenant-context.ts`, kept to short, reviewed paths (today: the
  placeholder User row of an owner's invitation, and handing that placeholder's memberships to the real account
  on first sign-in, `GET /me`; and the emailed-receipts queue before a sender is known,
  `apps/api/src/inbound/inbound.service.ts`, whose filing then runs as the sending member, and which also refuses mail
  to a previously used receipts address, keeps it with no sender until the address is released, and refuses an email
  that arrived before its workspace took the address (`ReceiptsAddress`, platform-level, read only under `app.admin`
  and `app.system`); the payroll-match sweeper, `payroll-match.sweeper.ts`, which removes expired runs; and the job that reads a
  payroll match's files, `apps/api/src/payroll/payroll-match.worker.ts`, which the database lets change only what
  reading fills, migration `20261016001300`). It sees every workspace and marks the connection `app.system = on`; only the
  `User` and `Membership` write policies and the `User` and `Workspace` read policies admit that mark (no longer
  the `Workspace` insert policy, migration `20261013000200`), and trusted work deletes `pending-` users only
  (migrations `20261011000400` to `..0600`). The invitation claim matches a verified Clerk email only. The
  restricted role never bypasses a policy. A guard calls `identifyCaller` right after it verifies the caller.
- **The platform admin is a database flag, not trusted work.** `AdminGuard` (always after `AuthenticatedGuard`,
  so the Terms gate holds) asks Clerk's backend for the role on every admin request, never the browser, then
  `identifyAdmin`; `PrismaService` sets `app.admin = on` beside the admin's own `app.user_id` and memberships.
  Migration `20261013000200` admits it to read every `Workspace`, `Membership`, `User` and `Suggestion`, insert
  a `Workspace`, change its lists only (`tagTypes`; trigger
  `Workspace_4_admin_lists`; never `receiptsAddress`), give, change and remove memberships,
  insert `pending-` users, and insert `DataAccessLog` lines in its own name in any workspace (no read: the API
  writes them with `createMany`, which reads nothing back). No policy below the workspace admits it. Two triggers
  keep it visible: a line written under the mark names the admin by their `User.email` (`DataAccessLog_1_admin_name`),
  and a membership change under the mark fails at commit unless the same transaction wrote its line in that
  workspace (`Membership_9_admin_logged`, deferred). Its name, lists and memberships change; nothing else of a
  workspace (`Workspace_4_admin_lists`).
  `route-gates.spec.ts` lists the admin routes; admin work never uses `runAsSystem`.
- **The API connects as the restricted role in every environment, a laptop included:** `DATABASE_URL` is the
  role from `apps/api/scripts/create-app-role.ts`, kept in step on every Railway deploy by `role:ensure` after the
  migrations (never a superuser, `BYPASSRLS` or the owner), and
  `SCHEMA_DATABASE_URL` is the owner, for Prisma's CLI, the seed and the scripts (import
  `scripts/lib/owner-env.ts` first in any new one). Every environment sets `REQUIRE_TENANT_RLS=on`, and every
  connection to a database off the machine uses TLS (`sslmode=require`; `src/startup-checks.ts` refuses
  otherwise). A path that returns nothing under it is the bug, not the policy.
- Raw SQL is always parameterized. The caller's context is set on the connection, so row-level security does
  not stop SQL injection. Never build SQL from request values.
- **Every route carries `AuthenticatedGuard`** except `GET /api/health` and its failure counts
  (`/api/health/upload-failures`, `/api/health/server-errors`: status, count and window only, see "Health checks
  and monitoring"),
  `GET /api/documents/local/:token`
  (the file behind a signed, expiring token that the gated `/documents/:id/url` issued; local disk only, which
  a deployed API refuses) and `POST /api/contact` (the public contact form: validated, throttled, honeypot,
  sent through Resend, nothing stored or logged) and `POST /api/inbound/resend` (the email provider's webhook
  for emailed receipts: its credential is Resend's Svix signature over the raw body, checked in constant time
  within five minutes; it only queues `email.received` once per provider id; 404 until `RESEND_RECEIVING_API_KEY`
  (its own Full access key; the contact form keeps its sending-only `RESEND_API_KEY`), `RESEND_WEBHOOK_SECRET` and
  `RECEIPTS_DOMAIN` are all set; filed only from a member's verified address with
  DMARC passing); `apps/api/src/auth/route-gates.spec.ts` lists every
  route and fails on a new one without the guard. Inside the line, a row of another workspace is a 404 from
  the tenant-scoped query (`tenantWhere`), never the row and never a different error; a change needs
  `WRITE_ROLES` (lists and members: `owner`), opening a personal document `personalRolesFor` (pay stubs: every member; the rest `PERSONAL_DOCUMENT_ROLES`), and a
  read that returns document or participant rows (an engagement, a month, a document list) writes
  `DataAccessLog`.
- The database specs run the real migrations on PGlite as the restricted role with exactly its privileges;
  `npm test` sets the Node flag they need, and CI fails if they are skipped.

## Local development and the demo

- **No local database, no local API and no demo sign-in.** A laptop runs the web app against `api-dev` in the
  shared `dev` environment on Railway (fictional seed only) and signs in through the dev Clerk instance. No
  Postgres has a public TCP proxy, dev's included: scripts that need the database run in a shell on `api-dev`
  (`railway ssh`), and an API change is tried by deploying it (`apps/api/scripts/deploy-dev.sh`). Setup and the
  daily commands are in `docs/dev-api.md`; the demo people and story are in `docs/dev-api.md`. The owner's reason:
  no real record and no production credential ever sits on a laptop.
- Railway is declared in code, `.railway/railway.ts` (same pattern as Learn Differently), applied by CI on a push
  to `main` once the project exists. Secrets are `preserve()` there and set by hand in Railway; the dev service's
  are copied from a local `.env` by `apps/api/scripts/railway-dev-vars.sh`.
- `apps/api/src/startup-checks.ts` refuses to start an API whose configuration breaks the security rules: a
  database off this machine without `sslmode=require`; a Railway environment without `REQUIRE_TENANT_RLS=on`, a
  Clerk key or the R2 bucket; production without `NODE_ENV=production`, `TRUST_PROXY` or a live Clerk key. Add
  to it rather than to prose when a rule can be checked.
- `npm run demo:reset -w @ad/api -- --confirm-host <host:port>` removes the demo workspaces (the full demo and Harbor
  Tech) and reseeds them; people, Terms acceptances and any other workspace stay, as production's `demo:seed` leaves
  them. It is a shared database: say what will change and get a yes first ("Database" below). It refuses production.
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

## Admin tools

Every platform-admin tool looks the same (owner's decision, 2026-10-16). A tool is one entry in `TOOLS` in
`apps/web/src/pages/AdminPage.tsx` (its tile on `/admin`: icon, title, tile text) plus its page under `/admin/...`,
and the page:

- opens with `<AdminToolHead to="/admin/..." />`: the breadcrumb "Admin tools / <tool>", then the tile's icon, the
  title and **one line** (`sub`) saying what to do here. No eyebrow and no paragraph of directions above the work.
- puts the longer explanation (`how`) behind `<AdminHow to="/admin/..." />` ("How this works", closed until asked
  for) at the end of its main card.
- uses solid controls: buttons are `kind="navy"` (the header's colour; a green `primary` only for the one creating
  action, Cancel `ghost`, never an empty outline), and status chips are solid (`<Chip … fill>`: each with a sign:
  🔄 waiting grey, ⚠️ failed amber, ⛔ refused red). The owners' own screens a tool reuses (a workspace's people and lists) keep their style.
- keeps tables and actions as the other tools do; a new tool adds its entry, its route next to `/admin` in `App.tsx`
  (an admin with no workspace reaches it too) and its admin routes in `route-gates.spec.ts`.

## Messages, tips and notes on screen

Never write a new kind of box. Every message the app shows is one of these, already designed (owner's
instruction, 2026-10-16, after several plain boxes that looked bad):

- **How to do something, a tip, a reminder** ("Email receipts in", "Need a hand?"): `HandCard`
  (`components/HandCard.tsx`): navy, the yellow circle with a sign (`icon`), a title, one bold line (`lead`), then at
  most a short paragraph or a numbered list of steps. An address or code to use goes in its pill with a Copy button
  (`ad-hand-address`).
- **Where a record stands** (edits requested, sent back, approved, submitted): the month page's `StatusPanel`
  (`report-layouts/shared.tsx`): sign, heading, who and when, their own words quoted, then "What to do next".
- **A word of encouragement beside the tiles:** `CheerCard`.
- **AI:** the `ad-ai-optin` box with its chip ("AI in the app").
- **The end of a flow** (an import done, a batch uploaded): Import transactions' step 5: a green check with what
  happened as a centred heading (`ad-done`), the numbers as the month page's tiles (`ad-done-tiles`), then a
  `HandCard` "What to do next". Never a `Notice`.
- **What just happened** after a small action on a page ("Matched to expense 2105."): `Notice`, one line of coloured
  text with no box (`ad-quiet`, owner's decision, 2026-10-18): a green ✓ for "that worked", passed `fade` so it fades
  after a few seconds; a warning or a standing state stays and is never faded. A `Notice` is never used for guidance, a
  tip, a reminder, the end of a flow, or inside a dialog's steps (there, the problem goes beside its field, or as the
  `ErrorNote` at the top).
- **How to use a screen**, when it isn't obvious: a closed "How to …?" line under its controls with the navy `info` icon (a `<details>`, `.ss-help`), opened
  on a click, never on hover alone.
- **What went wrong** (a refusal, a failed save): `ErrorNote` (`ad-error`: a soft red band, ⚠️ then the message in
  bold red), at the top of the form, dialog or section; a problem with one field goes beside that field. Never wrap an
  error in `Notice` or style a new error box.

- **Something wrong in a form:** say it beside the field, in red under it (`Field`'s `error`), and every problem at
  once, before the person presses Next, with one line at the top of the form naming the fields still to fix. Never the
  problems listed at the top, and never one problem per try. The server checks everything too and answers with every
  problem in one message; its `ErrorNote` is only for what the screen could not know. A choice the screen knows cannot work
  here (a saved mapping made for other columns) is not offered.

- **Buttons:** navy (`kind="navy"`) for actions, Next and Save; green (`primary`) only for a card's one creating
  action ("+ Invite someone", "+ Add Tag Group"), placed beside the card's heading; Cancel `ghost`; a removal is a red
  text link. A dialog saves when its form is done: no separate "Save all" button under a list.
- **The two payroll match screens stay alike** (owner's decision, 2026-10-19): the bookkeeper's per-engagement wizard
  (`PayrollProof.tsx`) and the owner's workspace match (`WorkspacePayrollPage.tsx`) are built from the same components
  (`components/payroll-match/`) and read the same way: a red count only on "Remaining to match" (and a red "N to look
  at" beside the owner's Staff and Participants, with a green "✓ N matched"), each proof found as its file, "✓ Found,
  page N" (or a guess, or missing) and Show, one "How Auto-Match decided" panel for every reason (closed until Show), no
  "fully proved" panel, a short "What Save will do" beside the footer, and the footer Back: upload / Discard (a red
  text link) / "Save and continue". Change one only with the other.

Keep the words short: one bold line that says the point, then steps as a list, never a paragraph that wraps three
times. Look at it in the browser at the width it will be used before showing it to the owner.

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

## Health checks and monitoring

The API answers three public health routes (`apps/api/src/health/health.controller.ts`): `GET /api/health` (the API
is up; the CI smoke test reads it), `GET /api/health/upload-failures` (proof uploads that failed through no fault of
the person) and `GET /api/health/server-errors` (requests answered 5xx), each counting the last 15 minutes of the
`ServiceFailure` table (`apps/api/src/core/service-failure-log.ts`). Better Stack Uptime watches the last two and
shows them in the "Audit Differently" section of the shared status page; `ops/monitoring.ts` lists them and CI
applies it (`docs/monitoring.md`).

**When a change adds or changes something the bookkeeper cannot work without, consider whether a health check
should cover it**, and say so in the change summary either way. Expand an existing check before adding one; keep
the list short (today two). A check counts failures people actually hit, not whether a dependency answers a probe.

- A new check: a kind of work whose failure stops people from saving, attaching, opening or submitting records.
  Not for a new endpoint, admin tool or internal helper. Prefer counting it under an existing kind; a new kind
  needs its name in the `ServiceFailure_kind_check` constraint (a migration) and in `FailureKind`.
- Record a failure where it happens with `ServiceFailureLog.record(kind, route)`, unawaited (it never rejects), and
  only when it is not the request's fault (a 4xx is not counted). A row is when, the kind and the route pattern:
  never a workspace, person, file name or error message, which go to the API's log. Any 5xx is already counted as
  `server` by `ServerErrorFilter`.
- Each check is a `@Get` on `HealthController`, public and unguarded (add it to `PUBLIC` in `route-gates.spec.ts`
  and to the exceptions in "Tenant isolation"), answering `{ status, failures, windowMinutes }` only, 503 when
  there was a failure or the count could not be read. It goes through `answer()`, so it times out after 5 seconds
  and its result is reused for a minute. It reads no workspace data, so it logs nothing to `DataAccessLog` and
  needs no `runAsSystem`.
- Better Stack: add the check to `ops/monitoring.ts`, and the next deploy from `main` creates its monitor and its
  row. The sync never deletes: a removed check is reported in the CI log and removed in Better Stack by hand.

## Reviewing larger PRs

For a PR over about 500 changed lines (`git diff --stat origin/main...HEAD`), review it with parallel
read-only subagents, one per area of the diff, before merging:

1. Split the diff by area (for example API and rules, data model and migrations, web app, config). Each
   reviewer reads every hunk in its area and reports at most 8 ranked findings, each with a concrete failure
   scenario. Tell each what earlier reviews already fixed.
2. Verify the top claims against the code, then report at most 15 findings to the owner. Each finding gives the
   place (`file:line`), then **a scenario in plain words**: who does what, on which screen, and what goes wrong for
   them (for example "The CEO uploads March's payroll; Save fails halfway; the two months it reopened stay reopened
   with nothing attached"). Then the fix, also in plain words. No internal names or shorthand the owner would have to
   ask about ("the owner's run", "the general list", "release log"): say what it is on the screen or in the database
   the first time ("the upload the owner started, kept on the server until Save"). Say how many findings there were
   in all, and list the ones left out with one line each on why.
3. Fix in parallel by area with disjoint file lists, then run the CI gates locally (`npm run lint`,
   `npm run format:check`, `npm run typecheck`, `npm run build`, `npm run test`) before pushing. After a clean
   build confirm `apps/api/dist/main.js` exists.

## Reviewing a feature with the owner

Before a feature is committed, the owner sees it working, screen by screen (owner's decision, 2026-10-17):

1. **Deploy it to dev.** Say which migrations it applies to the shared database and get a yes, then deploy with
   `apps/api/scripts/deploy-dev.sh` (the local web app already points at it).
2. **Give a guided tour.** Drive the browser pane yourself, one screen at a time, on the fictional seed. For each
   screen, narrate in plain words: where we are, what each part does, what is new, and anything that looks wrong.
   Go slowly, one screen per message, so the owner can take notes as you narrate. Stop at the end of each section and wait for "next", so the owner can take notes. Do the real actions (save,
   change, release), cancel anything that should not stick, and put the demo data back as it was afterwards.
3. **Keep one numbered list of findings** as you go: everything the owner calls out and everything you notice
   (layout, wording, a broken rule). Repeat the list at the end of each section, one line per item, and strike what
   the owner rules out. Don't fix mid-tour unless asked.
4. **Fix the list, then tour the fixes** the same way, only over what changed.
5. **A design change goes back into the issue.** If the tour shows the design is wrong, rewrite the issue in plain
   words with the owner's decisions, and park the built code on a local branch (not on main) instead of shipping it.

## Posting screenshots to GitHub issues / PRs

Only when the user asks for screenshots on an issue or PR:

1. Start dev servers via the Preview MCP using `.claude/launch.json` (`web` on 5273, beside the other Differently products, against `api-dev`).
2. For auth-gated pages do NOT try to bypass auth. Ask the user to sign in via the Preview MCP browser.
3. Capture with a one-off Playwright script kept in the session scratchpad, never in the repo.
4. Save PNGs to `docs/screenshots/<feature>/`, named after the feature, never a phase. Seed data only.
5. Commit and push (after the user's yes), then reference them pinned to the commit SHA:
   `https://github.com/<owner>/<repo>/blob/<sha>/docs/screenshots/<feature>/NN-name.png?raw=true` (the
   repository is public, so any form of the link renders; the commit SHA keeps it from drifting).
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
