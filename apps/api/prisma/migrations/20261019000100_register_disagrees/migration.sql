-- A pay stub is compared with its payroll register row, no longer with a bank line (owner's decision, 2026-10-19): a
-- bank statement shows payroll leaving as one debit per pay run, never one line per person. The flag a kept pay stub
-- line may carry is `register-disagrees`; `bank-disagrees` stays allowed for lines kept before this, and the
-- reconciliation no longer shows it (matching again rewrites a stub's flags).
ALTER TABLE "PayrollPayLine" DROP CONSTRAINT "PayrollPayLine_flags_check";
ALTER TABLE "PayrollPayLine" ADD CONSTRAINT "PayrollPayLine_flags_check" CHECK ("flags" <@ ARRAY[
  'stub-unreadable', 'no-participant', 'several-participants', 'no-month', 'bank-disagrees', 'register-disagrees',
  'duplicate', 'pay-unclear']::TEXT[]);
