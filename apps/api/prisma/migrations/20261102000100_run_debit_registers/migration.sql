-- A bank line that is a pay run's debit: how many of the month's registers it pays (two registers of one run, paid
-- together, share one debit). Set by each Save from the match; null on any other line. The reconciliation counts the
-- registers whose debit is found by it, since the registers' own text is not kept once the match is saved.
ALTER TABLE "PayrollPayLine" ADD COLUMN "registers" INTEGER;

-- Matched again, a pay line's run count changes as its flags do.
CREATE OR REPLACE FUNCTION "payroll_pay_line_decision_only"() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['notFundedReason', 'notFundedById', 'notFundedByEmail', 'notFundedAt', 'flags', 'registers'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['notFundedReason', 'notFundedById', 'notFundedByEmail', 'notFundedAt', 'flags', 'registers']) THEN
    RAISE EXCEPTION 'A pay line changes only by being marked not grant-funded or matched again' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION "payroll_pay_line_decision_only"() FROM PUBLIC;
