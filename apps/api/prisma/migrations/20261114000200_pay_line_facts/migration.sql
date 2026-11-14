-- Each person-pay's amount, date and payee, as the reconciliation's Amount, Date and Paid columns show them (owner's
-- decision, 2026-11-14). Kept by each Save from what the match read: a pay stub's net pay (else gross), pay period end and printed
-- name; a register row's net, its run's pay date and the person it names; a bank line's one amount and its date. Null
-- where the file does not say, never guessed. Columns only added: a pay saved before shows what its kept line says until
-- its month is matched again.
ALTER TABLE "PayrollPayLine"
  ADD COLUMN "amount" DECIMAL(12,2),
  ADD COLUMN "payDate" DATE,
  ADD COLUMN "payee" TEXT;

-- A pay line still changes only by being marked not grant-funded or matched again; a match also keeps these three.
CREATE OR REPLACE FUNCTION "payroll_pay_line_decision_only"() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['notFundedReason', 'notFundedById', 'notFundedByEmail', 'notFundedAt', 'flags', 'registers', 'amount', 'payDate', 'payee'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['notFundedReason', 'notFundedById', 'notFundedByEmail', 'notFundedAt', 'flags', 'registers', 'amount', 'payDate', 'payee']) THEN
    RAISE EXCEPTION 'A pay line changes only by being marked not grant-funded or matched again' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION "payroll_pay_line_decision_only"() FROM PUBLIC;
