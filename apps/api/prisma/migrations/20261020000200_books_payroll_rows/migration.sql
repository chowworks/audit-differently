-- The books' payroll transactions (owner's decisions, 2026-10-20, #22): a payroll provider's run as the accounting export
-- has it (salaries, payroll taxes, benefits, work-experience pay), imported after the "Payroll transactions
-- confirmation" step or marked so on the month. Such a line counts on the budget only until the payroll match covers its
-- kind of payroll on the month; after that the match's pay counts, and the line is kept for payroll reconciliation,
-- never counted twice. Its kind is kept as the import found it: the account it was read from is stored cut short.
ALTER TABLE "Expense" ADD COLUMN "payrollKind" TEXT;
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_payrollKind_check" CHECK (
  "payrollKind" IS NULL OR "payrollKind" IN ('staff-pay', 'staff-taxes', 'participant-pay', 'participant-taxes')
);
-- A line the match wrote is the match's own pay, never a books' payroll transaction.
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_payrollKind_key_check" CHECK ("payrollKind" IS NULL OR "payrollKey" IS NULL);
