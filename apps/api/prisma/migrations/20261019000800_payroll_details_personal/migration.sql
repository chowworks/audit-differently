-- Payroll details are personal, as pay stubs are (GitHub issue #22, section 8; DOCUMENT_SENSITIVITY): a staged payroll
-- file of that kind is personal, every other kind but a pay stub financial. Migration 20261019000700 allowed the kind
-- but left this check saying only a pay stub is personal, so a payroll details upload was refused.
ALTER TABLE "PayrollMatchFile" DROP CONSTRAINT "PayrollMatchFile_sensitivity_check";
ALTER TABLE "PayrollMatchFile" ADD CONSTRAINT "PayrollMatchFile_sensitivity_check"
  CHECK (("kind" IN ('paystub', 'payroll-details') AND "sensitivity" = 'personal')
    OR ("kind" NOT IN ('paystub', 'payroll-details') AND "sensitivity" = 'financial'));
