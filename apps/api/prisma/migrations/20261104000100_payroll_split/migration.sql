-- A staff payroll line's run split by program, written by Save from payroll details and the time report: its pay
-- stub opens with a note of it, so the line's amount reads against the stub's whole pay. Filled by the next Save.
ALTER TABLE "Expense" ADD COLUMN "payrollSplit" JSONB;
