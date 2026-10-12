# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary: the provider's bookkeeper, often an outside accountant or the one finance person at a small nonprofit,
who holds a state workforce grant and is struggling with audit readiness: not even sure the records kept each
month are the ones the auditor will ask for. Works monthly against a due date (the 12th), from invoices, bank
and card statements, payroll registers, timesheets, pay stubs and participant files, usually in a spreadsheet
and an inbox. Secondary: the provider's executive, who certifies each month. The agency (contract specialist,
internal auditor) is an organizer construct in the product: it defines the contract and budget lines and
receives submissions; an auditor may enter only to execute an audit and pull what they need. (Confirmed by the
owner, 2026-10-11.)

## Product Purpose

Give a provider a process to follow every month so the proof an audit requires is collected as the spending
happens, instead of reconstructed after the audit letter arrives. Providers working through this on their own
produce inconsistent results; the product makes the workflow explicit and keeps score. Success: a provider
reaches the monitoring review with every sampled month complete, and the auditor's request is answered from
the system without a scramble.

## Positioning

The ledger is organized the way the auditor's request is organized (month, then program costs and work
experience, then invoice, payment, allocation, timesheet, register, eligibility), and rules check completeness
at entry, in the auditor's own words. Built by a provider that has been through the review. A generic
accounting tool cannot truthfully claim the second half; a generic form builder cannot claim the first.

## Operating Context

WIOA sub-recipient reporting to a state workforce agency: award letter, budget narrative (ten categories),
contract, the agency's monthly financial report form (seven lines, due the 12th of the following month, signed
by preparer and authorizer, reviewed on a six-point checklist), supporting documents by email today, and an
end-of-contract monitoring review that samples months and asks per month for invoices, payment records,
timesheets, payroll registers and, per participant, enrollment and eligibility records. Shared costs are
allocated by payroll hours or usage with a one-page worksheet each. The agency's own form must remain
producible and recognizable.

## Capabilities and Constraints

Built as of 2026-10-11: contracts and budget lines, a monthly ledger with proof attached per expense, fourteen
rule checks (blocker, attention, info), submit, agency review and approval, the agency form filled from the
ledger and printable, a participant eligibility grid, a personal-document tier (pay stubs, eligibility records:
download only, fewer roles, every read logged), an access log, database-level tenant isolation. Not built: the
audit package export, AI document reading, deployment, Clerk sign-in (local demo personas instead). Desktop
first; some mobile use expected, so the surface is responsive. Terminology: provider, agency, contract, month
(a report), line (the seven report lines), proof, check, participant file. React, Vite, Tailwind, NestJS API.

## Brand Commitments

The name is Audit Differently. It is a sibling of Code Differently, Interview Differently and Learn
Differently; the "Differently" name carries that on its own, and product or marketing copy never calls the
family out (owner, 2026-10-11). Its own palette and type are allowed. The first interface (Tailwind cards,
pill chips, system font, blue accent) was rejected by the owner as generic; it is the anti-reference.

## Evidence on Hand

Real reference documents in `Financial Reporting/` at the repository root (gitignored; never seed, quote, or
screenshot from them): an award letter, the agency's monthly workbook, a signed final report, a complete
monitoring-review package with the auditor's request letter. Fictional seed data in `apps/api/prisma/seed.ts`
(two providers, three months, three participants, forty-odd fictional PDFs). No customers, testimonials,
pricing or benchmarks exist; do not invent any.

## Product Principles

- The process is the product: a month is a checklist the bookkeeper can finish, not a form to fill.
- Proof lives on the line it proves; nothing is attached "somewhere".
- Say what is missing at entry, in the auditor's words, and show how far from done the month is.
- The agency's artifacts stay recognizable (the form, the checklist); the provider's workflow is ours.
- Sensitive records get visibly stricter handling than financial ones.

## Accessibility & Inclusion

No standard was pinned by the owner. A state-agency buyer makes WCAG 2.1 AA the floor: keyboard operation,
visible focus, 4.5:1 text contrast, labeled controls, tables that read in order.
