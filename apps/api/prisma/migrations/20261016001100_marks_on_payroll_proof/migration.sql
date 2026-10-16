-- "Match payroll & timecards" (GitHub issue #15): every proof of a payroll item may carry its marked line, not only the
-- bank statement. The line found on the timesheet (the person's row), the payroll register (the pay period) and the
-- pay stub (the person's pay) is what an auditor looks for, and the audit package draws it on a copy.
--
-- 1. A mark may sit on a timesheet or register link as well as on evidence of payment. Same shape as before.
ALTER TABLE "ExpenseDocument" DROP CONSTRAINT "ExpenseDocument_mark_check";
ALTER TABLE "ExpenseDocument" ADD CONSTRAINT "ExpenseDocument_mark_check" CHECK ("mark" IS NULL OR COALESCE((
  "purpose" IN ('payment', 'timesheet', 'register') AND jsonb_typeof("mark") = 'object'
  AND jsonb_typeof("mark" -> 'page') = 'number' AND ("mark" ->> 'page')::numeric >= 1
  AND ("mark" ->> 'page')::numeric = floor(("mark" ->> 'page')::numeric)
  AND jsonb_typeof("mark" -> 'x') = 'number' AND jsonb_typeof("mark" -> 'y') = 'number'
  AND jsonb_typeof("mark" -> 'width') = 'number' AND ("mark" ->> 'width')::numeric > 0
  AND jsonb_typeof("mark" -> 'height') = 'number' AND ("mark" ->> 'height')::numeric > 0
  AND (NOT "mark" ? 'text' OR (jsonb_typeof("mark" -> 'text') = 'string' AND char_length("mark" ->> 'text') <= 300))
), false));
ALTER TABLE "WexPaymentDocument" DROP CONSTRAINT "WexPaymentDocument_mark_check";
ALTER TABLE "WexPaymentDocument" ADD CONSTRAINT "WexPaymentDocument_mark_check" CHECK ("mark" IS NULL OR COALESCE((
  "purpose" IN ('payment', 'timesheet', 'register') AND jsonb_typeof("mark") = 'object'
  AND jsonb_typeof("mark" -> 'page') = 'number' AND ("mark" ->> 'page')::numeric >= 1
  AND ("mark" ->> 'page')::numeric = floor(("mark" ->> 'page')::numeric)
  AND jsonb_typeof("mark" -> 'x') = 'number' AND jsonb_typeof("mark" -> 'y') = 'number'
  AND jsonb_typeof("mark" -> 'width') = 'number' AND ("mark" ->> 'width')::numeric > 0
  AND jsonb_typeof("mark" -> 'height') = 'number' AND ("mark" ->> 'height')::numeric > 0
  AND (NOT "mark" ? 'text' OR (jsonb_typeof("mark" -> 'text') = 'string' AND char_length("mark" ->> 'text') <= 300))
), false));

-- 2. A mark sits on a payroll file: a bank statement, timesheet or payroll register (financial), or a pay stub
-- (personal). On a pay stub the mark is the box alone, never the line's text: the text is the person's name and pay.
CREATE OR REPLACE FUNCTION "mark_on_statement"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW."mark" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "Document"
    WHERE "id" = NEW."documentId" AND (
      ("kind" IN ('bank-statement', 'timesheet', 'payroll-register') AND "sensitivity" = 'financial')
      OR ("kind" = 'paystub' AND "sensitivity" = 'personal' AND NOT NEW."mark" ? 'text')
    )
  ) THEN
    RAISE EXCEPTION 'A line can be marked on a payroll file only, and on a pay stub without its text'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
