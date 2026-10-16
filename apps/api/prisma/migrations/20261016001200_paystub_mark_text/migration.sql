-- Pay stubs are payroll files like the rest (owner's decision, 2026-10-16): shown on the page with their line
-- highlighted, and their mark keeps the line's text, as a timesheet's or a bank statement's does. The text can hold a
-- person's name and pay, so the access log names it by field only (as before). Eligibility records and enrollment
-- forms are never marked.
CREATE OR REPLACE FUNCTION "mark_on_statement"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW."mark" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "Document"
    WHERE "id" = NEW."documentId" AND (
      ("kind" IN ('bank-statement', 'timesheet', 'payroll-register') AND "sensitivity" = 'financial')
      OR ("kind" = 'paystub' AND "sensitivity" = 'personal')
    )
  ) THEN
    RAISE EXCEPTION 'A line can be marked on a payroll file only' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
