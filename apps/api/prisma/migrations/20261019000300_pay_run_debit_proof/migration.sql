-- A payroll item's bank line may be the one debit of the pay run that paid it (owner's decision, 2026-10-19): a bank
-- statement shows a run's pay as one debit, never a line per person. The match that links it says so here, and the
-- month's check then reads the line as that run's debit rather than looking for the item's own amount on it. False for
-- every link a person makes and for every link before this; only a bank statement's payment link is ever one.
ALTER TABLE "ExpenseDocument" ADD COLUMN "payRun" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "WexPaymentDocument" ADD COLUMN "payRun" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ExpenseDocument" ADD CONSTRAINT "ExpenseDocument_pay_run_check"
  CHECK (NOT "payRun" OR ("purpose" = 'payment' AND "mark" IS NOT NULL));
ALTER TABLE "WexPaymentDocument" ADD CONSTRAINT "WexPaymentDocument_pay_run_check"
  CHECK (NOT "payRun" OR ("purpose" = 'payment' AND "mark" IS NOT NULL));
