# Product brief: Audit Differently

_Written 2026-10-11 from the reference documents in `Financial Reporting/` (an award letter, the agency's monthly
financial report workbook, a signed final report, and the full audit package a provider assembled for a
monitoring review), the agency's budget narrative form, and the owner's notes from a meeting with the agency's
secretary. Names and amounts in this document are fictional or generic; the real ones stay in the gitignored
folder._

## 1. Summary

Workforce agencies pass federal and state grant money (for example WIOA Youth) to providers. A provider reports
spending monthly on the agency's spreadsheet form and emails it with the supporting documents. At contract end
the agency's internal auditor asks for every receipt, payment record, timesheet and payroll register for a
sample of months, and the provider rebuilds the year as a folder tree of PDFs. The agency was "trampled" in its
last federal audit of these programs: it could not show, provider by provider, that the money was spent as
budgeted and that the proof exists.

The tool replaces the emailed spreadsheet with a ledger the provider fills in month by month, with the proof
attached to each line, checked before submission, reviewed by the agency in place, and exportable as the audit
package in one click. Payroll and bank records stop travelling by email.

## 2. Why standalone (decision record)

The owner asked whether to build this inside Learn Differently or on its own. Both sides, then the verdict.

**The case for building it into Learn Differently**

- The platform already has Clerk sign-in, Railway Postgres, private R2 storage, and an agency → provider tenant
  model with row-level security; `Institution.kind` already knows `agency` and `provider`.
- The LMS owns "outcomes dashboards and exports for institutions and funders". Spending beside outcomes is a
  stronger pitch to the same buyer, with one login for agency staff.
- One stack to operate instead of two (one Clerk instance, one Railway project, one Vercel project).
- A weekend build is faster when the scaffolding exists.

**The case for standalone**

- **The Interview Differently repository is public.** Its own rules say fictional data only and keep funding and
  procurement details out of issues. This product's issues, docs and screenshots are nothing but funding and
  procurement detail, and its database holds payroll registers and bank statements. The rule that follows is
  fictional data only, in every file, issue and screenshot. (Update 2026-10-12: the owner has made this
  repository public, so that rule is now the only protection, not a second one.)
- **It serves none of the five verbs.** Learn Differently's boundaries doc assigns every feature to Structure,
  Spark, Practice, Opportunity or Placement, on one learner record. The user here is a fiscal officer, an
  internal auditor and a provider's bookkeeper (often an outside accountant). The data is a contract's money,
  not a learner. Adding a sixth product is allowed by the doc, but it would put bank statements beside the
  gradebook with nothing joining them except the agency row.
- **Blast radius.** A breach or a bad query in the LMS should never expose bank statements, and the reverse.
  Different retention (2 CFR 200.334: three years from the final expenditure report), different access policy,
  different consequences. A separate database is the simplest control.
- **Different compliance conversation.** A state fiscal office will ask about data handling, hosting and access
  for this system specifically. A small, single-purpose system answers those questions in a page.
- **It sells on its own.** Every pass-through entity that sub-awards WIOA funds has this problem, and the buyer
  is a fiscal office that may never buy an LMS.
- **The reuse is patterns, not code.** The domain code (budget lines, monthly report, documents, checks) is new
  either way; the auth, storage and tenancy patterns copy over in an hour, which is what this scaffold did.

**Verdict: standalone, same conventions as Interview Differently.** The real cost is
operating a second stack, and it is worth it. If an agency later wants spending and outcomes side by side,
connect the two through single sign-on or an API, the way the boundaries doc already says products connect:
through shared identity, never shared code.

## 3. Who uses it

| Person                  | Organisation | What they need                                                                        |
| ----------------------- | ------------ | ------------------------------------------------------------------------------------- |
| Preparer (bookkeeper)   | Provider     | Enter the month's expenses, attach proof, see what is missing, submit by the due date |
| Authorizer (executive)  | Provider     | Certify and sign the monthly report                                                   |
| Contract specialist     | Agency       | Receive, review (the agency's own checklist), approve or deny for payment             |
| Internal auditor        | Agency       | Pick months, see every expense with its proof, download the audit package             |
| Fiscal lead / secretary | Agency       | Across providers: who is late, who is over budget, who has gaps                       |

Roles in the data model: `provider-preparer`, `provider-admin`, `agency-reviewer`, `agency-auditor`,
`agency-admin`.

## 4. The process today, and what the auditor asks for

1. **Proposal** by email, with an initial budget.
2. **Award letter** by email: contract amount (usually far below the request), no spending before execution.
3. **Budget narrative** on the agency's web form: an amount and a narrative for each of Personnel, Fringe,
   Travel, Equipment, Supplies, Contractual/Subawards, Participant/Training Costs, Other, Indirect (yes/no),
   Work Experience (WEX); Construction must be zero.
4. **Budget approval** and a contract by email.
5. **Monthly financial report workbook** by email: twelve sheets, one per month. Each has seven line items
   (Staff Salaries, Staff Fringe, Program Costs, Participant Wages, Participant Fringes, WEX, Indirect for
   Parent Org) with Previously Billed, Billed this Period, Cumulative, Budget and Remaining, a comments
   section, a certification with two signatures, and the agency's review section (received date, six
   verification checkboxes, approved or denied for payment, invoice number).
6. **Submission** of the signed report and supporting documents by email by the 12th of the following month.
7. **Monitoring review** at contract end. The auditor names sample months and asks, per month: invoices,
   receipts and purchase orders; evidence the goods or services were received; payment records (bank
   statements, cancelled checks, EFT confirmations); and for work experience, per participant: enrollment
   form, eligibility records, timesheets, payroll registers, evidence of payment. Plus a participant list
   split into carryover and new enrollments. The provider answers with a folder tree, a README and a cover
   letter.

One provider already keeps the ledger the auditor wants, in a spreadsheet: one sheet per month, one row per
expense with item number, date, vendor, account, total cost, allocated amount (program and WEX columns),
allocation type and method, and links to the calculation, the invoice, the payroll detail and the register,
plus "submitted to folder" and "reviewed" flags. **That spreadsheet is the product spec.** The agency's
secretary saw it and asked for it as a tool.

## 5. What the tool does (MVP)

Same seven steps, in the tool:

- **Contract.** Agency staff create the contract: number, program, funding sources, period, award amount, due
  day. The approved budget is entered once as budget lines, each tagged with the narrative category it came
  from and the monthly-report line it rolls into (the crosswalk in `packages/types`).
- **Month ledger.** The preparer adds expenses to the month: item number, date, vendor, memo, account, total
  cost, allocated amount, allocation type (direct, by payroll hours, by usage) and the report line. Each
  expense takes attachments by purpose: invoice or receipt, proof of payment, allocation calculation,
  timesheet, payroll register. Work-experience pay is a row per participant and pay period with its paystub,
  timesheet and register.
- **Monthly report, computed.** Billed this period, cumulative and remaining per line come from the ledger and
  the previous months. The export is the agency's own form as a PDF, so nothing changes for the agency's fiscal
  process on day one. Certification is a recorded click by the authorizer (e-signature later if required).
- **Participant file.** Each participant has the items of the agency's eligibility checklist (enrollment
  form, proof of age, right to work, school status, income eligibility, barrier statement, signed service
  strategy, objective assessment, or a temporary self-attestation), each a document in the `personal` tier.
  The month shows who is paid and whose file is short.
- **Checks before submit.** Rules run on every save and block or warn (section 8). The preparer sees exactly
  what is missing before the agency does.
- **Agency review.** The contract specialist works the same checklist that is on the form today, in the tool,
  and approves or denies for payment with a reason. Every review step is timestamped.
- **Audit package.** For any set of months, or the whole contract, generate the folder tree, README and cover
  letter the provider builds by hand today, from the attached documents.
- **Across providers.** For the agency: due and late reports, over-budget lines, open checks, by provider.

## 6. Scope decisions

- **Participant eligibility records are in scope** (owner's decision, 2026-10-11). The audit letter asks, per
  participant, for the enrollment form and eligibility records beside the payroll proof, so a tool that
  answers the auditor has to hold them. The sample audit package contained Social Security cards, birth
  certificates, passports, driver's licences, benefit letters and parents' pay stubs, for minors: the most
  sensitive data in the system. They get their own tier (section 9) and the rule in section 8 that says
  whose file is short before the auditor does.
- **Accounting integration** (QuickBooks, Rippling) is a later convenience. The MVP accepts what the
  bookkeeper already exports.
- **Replacing the agency's intake form** for the budget narrative waits until the agency asks. Enter the
  approved budget; do not rebuild the form.
- **Payments, e-signature, multi-funder**: out.

## 7. Data model

Source of truth: `apps/api/prisma/schema.prisma`. In words:

- **Agency** (tenant) has **Providers**. **Users** hold **Memberships** with a role, for an agency or one of
  its providers. Every row below carries `agencyId` and `providerId`, set by database triggers from its parent
  and enforced by row-level security (section 9).
- **Contract** (provider, number, program, funding sources, period, award, due day, status) has **BudgetLines**
  (narrative category, amount, narrative, report line).
- **MonthlyReport** (contract, period `YYYY-MM`, status, due date, submitted/approved/denied timestamps,
  preparer and authorizer, agency review checklist, invoice number).
- **Expense** (report, item number, date, vendor, memo, account, total cost, allocated amount, allocation type
  and note, report line). A split across two report lines is two rows with one item number.
- **Document** (provider, kind, sensitivity `financial` or `personal`, file name, type, size, sha256, storage
  key, period, uploader). Joined to expenses by **ExpenseDocument** with a purpose (invoice, payment,
  allocation, timesheet, register), and to participants by **ParticipantDocument** with the eligibility item
  it satisfies.
- **Participant** (contract, id number, display name, enrollment status) and **WexPayment** (report,
  participant, pay period, hours, gross amount) with its documents.
- **Check** (report, optional expense or WEX payment, code, severity, source rule or AI, message, status open,
  resolved or waived, who and why).
- **DataAccessLog** (agency, provider, actor, resource, subject, action, detail, time).

Money is `Decimal(12,2)`. Periods are `YYYY-MM` strings. Statuses and kinds are strings with the allowed values
listed in `packages/types`, not enums, so adding one needs no migration.

## 8. Compliance checks

**Rules first (phase 0 and 1), AI second (phase 2).** A rule is a pure function over the month's data
(`apps/api/src/checks/rules.ts`), fast, explainable and testable; the preparer sees it as they type. AI reads
the documents themselves and is only trusted to raise attention, never to clear a check.

Rules, each with the evidence that motivated it:

| Code                                     | Severity  | Rule                                                                                                                                                                                                                                                                                      |
| ---------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `missing-invoice`                        | blocker   | A non-payroll expense has no invoice, receipt or purchase order attached (the auditor's first request).                                                                                                                                                                                   |
| `missing-proof-of-payment`               | blocker   | No bank statement, card statement, cancelled check or EFT confirmation attached (the auditor's third).                                                                                                                                                                                    |
| `missing-allocation`                     | blocker   | An allocated (shared) expense has no calculation attached. Shared costs were a third of the sample ledger.                                                                                                                                                                                |
| `allocation-exceeds-total`               | blocker   | Allocated amount is larger than the expense.                                                                                                                                                                                                                                              |
| `missing-timesheet` / `missing-register` | blocker   | Payroll and WEX rows need both; a participant's pay also needs its pay stub or deposit advice (`missing-proof-of-payment`).                                                                                                                                                               |
| `budget-overrun`                         | attention | Cumulative on a line exceeds its budget. The sample final report shows one line over by the same amount another is under: it balanced in total and still needs the agency's agreement.                                                                                                    |
| `date-outside-contract`                  | blocker   | Expense date outside the contract period.                                                                                                                                                                                                                                                 |
| `date-far-from-period`                   | attention | More than 60 days before the report month (accruals happen; a half-year lag does not).                                                                                                                                                                                                    |
| `indirect-as-direct`                     | attention | A "general and administrative", "overhead" or "indirect" line booked under Program Costs while the contract's Indirect line is zero. The sample ledger has a 10% G&A row under program costs; whether that is allowed depends on the contract's indirect terms, which the tool must hold. |
| `duplicate-item`                         | attention | Same vendor, amount and date twice in the contract.                                                                                                                                                                                                                                       |
| `late-submission`                        | info      | Submitted after the due day of the following month (or the agreed date).                                                                                                                                                                                                                  |
| `unallowable-category`                   | blocker   | Construction, or equipment in the final funded year, per the agency's narrative form.                                                                                                                                                                                                     |
| `proof-mismatch`                         | attention | A payroll proof highlighted for its item does not show the item's amount (evidence of payment, a participant's timesheet) or its pay period (a participant's proofs), for what the platform highlights on that kind of proof.                                                             |

A participant's eligibility file is not a monthly check: step 5 (participants and eligibility) shows each
participant's missing items where they are collected (owner's decision, 2026-10-16).

AI review (phase 2), each returning a finding with a quote from the document, never a silent pass:

- Read an attached invoice or receipt: vendor, date, amount, last four of the account; compare with the row.
- Read a bank or card statement: find the line that pays each expense; flag unmatched expenses and, for the
  agency, unexplained program-coded lines.
- Read a payroll register and timesheet: hours × rate = gross; participant present on the master list and not
  offboarded before the pay period.
- Classify an upload's kind and period from its content, and flag a document attached to the wrong month.
- Summarise a month for the reviewer in plain words, listing what to look at first.

## 9. Security requirements

What the owner called "the main issue". Everything below is a requirement of phase 1, before any real document:

- Private bucket. Documents served only by signed URLs that expire in minutes, with a
  forced download name; never a public URL.
- Row-level security from the first migration, at both the agency and the provider line, with the API
  connected as a restricted role in every environment (`docs/tenant-isolation.md`; same design as Interview
  Differently, extended to providers). Built and tested on 2026-10-11.
- Roles inside those lines are the application's: agency reviewers approve, auditors are read-only, provider
  admins manage their staff, preparers enter and attach.
- Personal-tier documents (eligibility records, enrollment forms, pay stubs): 60-second signed URLs that
  always force a download, no inline preview or thumbnail, visible to agency roles and provider admins only,
  every read logged, never in an export the agency did not ask for by name, never read by OCR or AI without
  the agency's written decision.
- Every read, list, download and export of a document or participant row goes to `DataAccessLog`, visible to
  agency admins. Exports (audit packages) are logged with what they contained.
- Multi-factor sign-in for agency staff (Clerk).
- Upload limits: allowed types, size cap, sha256 recorded, content type checked server-side, not trusted from
  the browser. Virus scanning before phase 2 (a scanning service, not a library in the API).
- Retention: records kept three years after the contract's final expenditure report, then deleted on a
  schedule the agency approves. Nothing is deleted on a user's click.
- Backups with point-in-time recovery on before the first real row.
- No email attachments, ever. Notifications link to the tool.
- Open question for the agency: whether providers upload full bank statements or redacted pages. Full
  statements show other programs' transactions. The tool should accept either and record which.

## 10. Phases

| Phase | Goal                                                                                                                                                                                                                                                                                      | Done when                                                                           |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 0     | **Demo** on the fictional seed, before the budget lands: contract and budget, month ledger with uploads, participant files, computed monthly report in the agency's own form, the first rules, agency review. **Built 2026-10-11** (`docs/demo/README.md`); row-level security already in | The secretary can click through a month and see a blocked submit become a clean one |
| 1     | **Pilot** with one provider and one agency on real data: restricted database role in every environment, access log on every document read, roles, review workflow, due dates and notifications, backups                                                                                   | A real month is submitted, reviewed and approved in the tool, with no email         |
| 2     | **Audit package** generation and **AI document review**; bank-statement matching                                                                                                                                                                                                          | The auditor's request for a sample of months is answered from the tool in one click |
| 3     | **Onboarding more providers**; agency-wide dashboard; budget narrative intake if asked; accounting import                                                                                                                                                                                 | Second provider live without a developer in the loop                                |

## 11. Open questions (for the owner, then the agency)

1. Budget and timeline. Phase 0 is built on the assumption that the demo must land before the budget does.
2. Who hosts and owns the data: the vendor's Railway and Cloudflare accounts, or state infrastructure? The
   answer changes the security section and the contract.
3. Is the agency's monthly financial report PDF the system of record? If yes, the export must match it
   exactly; if the tool becomes the record, the form can go.
4. Full or redacted bank statements (section 9).
5. The contract's indirect-cost terms, so `indirect-as-direct` is a rule and not a guess.
6. The product's name.

## 12. Things noticed in the sample documents

Worth knowing before design; each is a question for the agency, not a finding.

- **The budget narrative's categories and the monthly report's lines do not match.** The narrative has ten
  categories; the report has seven lines; "Program Costs" absorbs most of them. The crosswalk in
  `packages/types` is the tool's answer; the agency should confirm it.
- **Indirect appears under Program Costs.** The sample ledger adds a 10% general and administrative row to
  each month under program costs while the report's Indirect line is zero. Allowed or not depends on the
  contract. The tool records the contract's indirect terms and flags the pattern.
- **Lines can be over and under at once.** The sample final report has Program Costs over budget and WEX under
  by the same amount, total exactly on budget. Needs a recorded agency agreement or a budget modification.
- **File names carry the data today.** Item number, vendor, amount and date live in file names
  (for example `RYS-12 - Rent Allocation - $630.00 - 09.15.26.pdf`, a fictional one), with inconsistent spelling and one missing extension.
  The tool should read those names on upload as a hint and never rely on them.
- **Every shared cost has two files**: the vendor's invoice for the full amount and a one-page allocation
  worksheet with the program's share and percentage. The expense row needs both purposes.
- **Allocation drivers are documented once per month** ("based on payroll hours", "based on usage") as a
  methodology page. The tool should store the methodology on the contract and the monthly driver figures
  (hours per program) once, so each allocated row can be recomputed instead of re-attached.
- **The audit package included participant eligibility records**, and the provider tracked them on a
  checklist with "temporary fix" and "final audit goal" columns per item. That checklist is the model for the
  participant file (section 5) and the rule in section 8.
