# Audit Differently

Grant financial reporting and compliance for workforce pass-through agencies and the providers they fund.

**Status: working demo on the dev environment** (phase 0 of the brief). A bookkeeper walks an engagement through
eight steps, records a month's expenses with their proof, sees what the rules flag, submits, and downloads the
audit package. Tenant isolation is in the database from the first migration. No real data anywhere. Start with
[docs/product-brief.md](docs/product-brief.md), then [docs/dev-api.md](docs/dev-api.md) and
[docs/dev-api.md](docs/dev-api.md) to run it.

## The problem

A provider that wins a workforce grant reports its spending to the agency every month on a signed spreadsheet,
then emails it with the proof: receipts, invoices, allocation worksheets, payroll registers, timesheets, bank
and card statements. When the agency audits the contract, the provider rebuilds the whole year as a folder tree
of PDFs with a cover letter. Everything moves by email, including payroll and bank records. Nobody knows what is
missing until the auditor says so.

## What it does

- A provider records each month's expenses against the approved budget lines and attaches the proof to each one.
- The monthly financial report the agency already uses is computed from those lines and exported in the agency's own format.
- Rules check every report before it is submitted: missing proof, allocation math, budget overruns, dates, duplicates.
  AI review of the documents themselves comes after the rules (phase 2 in the brief).
- Agency staff review, approve or deny in the tool, and generate the audit package for any month or the whole contract.
- Participant eligibility files sit beside the payroll proof, in a stricter tier, so the auditor's request is answered in full.
- Documents never travel by email again.

## Architecture

```
Frontend (React + Vite + TypeScript)  →  Vercel        apps/web
Backend API (NestJS + Prisma)         →  Railway       apps/api
Postgres                              →  Railway
Private document storage (R2)         →  Cloudflare
Shared types                          →  packages/types
```

Same shape as Interview Differently, by design, so the two projects share conventions (see `CLAUDE.md`),
including database-level tenant isolation from the first migration ([docs/tenant-isolation.md](docs/tenant-isolation.md)).
They share no code, database or sign-in.

## Repository structure

```
apps/api            NestJS API: auth (Clerk), row-level tenancy, storage, compliance rules, Prisma schema, migrations, seed
apps/web            React app for providers and agency staff
packages/types      Shared TypeScript types: report lines, budget categories, document kinds, check codes
docs/product-brief  What it is, why standalone, the process it replaces, data model, checks, security, phases
docs/tenant-isolation  How one agency and one provider are kept from another, and how to set a database up
docs/release-notes  Plain-words changelog (open index.html in a browser)
Financial Reporting/   Real reference documents. Gitignored. Never seed, test or screenshot from them.
```

## Running it

See [DEVELOPMENT.md](DEVELOPMENT.md).
