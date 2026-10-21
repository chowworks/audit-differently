-- Payroll details (GitHub issue #22, section 8; owner's decisions, 2026-10-19): the payroll company's per-person export,
-- one row per person, run, pay type and job, as a fifth folder of the payroll zip. It is kept as proof (a personal-tier
-- workspace payroll file, the per-person register of each person it charges to the grant), so its kind is allowed on a
-- staged payroll file, a staff member's proof and a dropped decision. It is a spreadsheet: never marked, so the marks
-- trigger (`mark_on_statement`) is unchanged and refuses a mark on it.

ALTER TABLE "PayrollMatchFile" DROP CONSTRAINT "PayrollMatchFile_kind_check";
ALTER TABLE "PayrollMatchFile" ADD CONSTRAINT "PayrollMatchFile_kind_check"
  CHECK ("kind" IN ('timesheet', 'payroll-register', 'paystub', 'bank-statement', 'payroll-details'));

ALTER TABLE "StaffPayProof" DROP CONSTRAINT "StaffPayProof_kind_check";
ALTER TABLE "StaffPayProof" ADD CONSTRAINT "StaffPayProof_kind_check"
  CHECK ("kind" IN ('timesheet', 'payroll-register', 'bank-statement', 'payroll-details'));

ALTER TABLE "PayrollDroppedDecision" DROP CONSTRAINT "PayrollDroppedDecision_kind_check";
ALTER TABLE "PayrollDroppedDecision" ADD CONSTRAINT "PayrollDroppedDecision_kind_check"
  CHECK ("kind" IN ('timesheet', 'payroll-register', 'paystub', 'bank-statement', 'payroll-details'));

-- With payroll details, the month's runs list and pay list go (owner's decision, 2026-10-19): the flow is Upload → Match →
-- Done, each person's pay per run read from the payroll company's export, each run from its register. Their rows are
-- per-month notes of a workspace (pay dates; names and pay), dropped whole.
DROP TABLE "PayrollRunList";
DROP TABLE "PayrollPayList";
