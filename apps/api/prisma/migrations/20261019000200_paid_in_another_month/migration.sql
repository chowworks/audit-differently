-- A pay belongs to the month it was paid in, by its pay date (owner's decision, 2026-10-19; the pay period's end only
-- when no pay date is printed): a pay stub or a register row paid in another month than the month's payroll files is
-- not that month's pay, and its kept line says so (`other-month`, PAY_LINE_FLAGS in packages/types).
ALTER TABLE "PayrollPayLine" DROP CONSTRAINT "PayrollPayLine_flags_check";
ALTER TABLE "PayrollPayLine" ADD CONSTRAINT "PayrollPayLine_flags_check" CHECK ("flags" <@ ARRAY[
  'stub-unreadable', 'no-participant', 'several-participants', 'no-month', 'other-month', 'bank-disagrees',
  'register-disagrees', 'duplicate', 'pay-unclear']::TEXT[]);
