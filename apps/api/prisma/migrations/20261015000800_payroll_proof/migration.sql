-- Payroll proof (GitHub issue #15): a payroll item (a payroll expense line or a work-experience payment) linked to
-- its bank statement as evidence of payment, with the statement line it was paid on marked on the page.

-- 1. The mark: { page, x, y, width, height, text? } in PDF points from the page's bottom-left corner. Null for every
-- other link. `text` is the line as the statement prints it (it can hold a person's name: logged by name only).
ALTER TABLE "ExpenseDocument" ADD COLUMN "mark" JSONB;
ALTER TABLE "WexPaymentDocument" ADD COLUMN "mark" JSONB;

-- A mark is only ever on evidence of payment: a whole page number from 1, and a box of positive size. A missing field
-- makes the test null, which COALESCE turns into a refusal. (Inline, not a function: the restricted role executes only
-- the functions it needs.)
ALTER TABLE "ExpenseDocument" ADD CONSTRAINT "ExpenseDocument_mark_check" CHECK ("mark" IS NULL OR COALESCE((
  "purpose" = 'payment' AND jsonb_typeof("mark") = 'object'
  AND jsonb_typeof("mark" -> 'page') = 'number' AND ("mark" ->> 'page')::numeric >= 1
  AND ("mark" ->> 'page')::numeric = floor(("mark" ->> 'page')::numeric)
  AND jsonb_typeof("mark" -> 'x') = 'number' AND jsonb_typeof("mark" -> 'y') = 'number'
  AND jsonb_typeof("mark" -> 'width') = 'number' AND ("mark" ->> 'width')::numeric > 0
  AND jsonb_typeof("mark" -> 'height') = 'number' AND ("mark" ->> 'height')::numeric > 0
  AND (NOT "mark" ? 'text' OR (jsonb_typeof("mark" -> 'text') = 'string' AND char_length("mark" ->> 'text') <= 300))
), false));
ALTER TABLE "WexPaymentDocument" ADD CONSTRAINT "WexPaymentDocument_mark_check" CHECK ("mark" IS NULL OR COALESCE((
  "purpose" = 'payment' AND jsonb_typeof("mark") = 'object'
  AND jsonb_typeof("mark" -> 'page') = 'number' AND ("mark" ->> 'page')::numeric >= 1
  AND ("mark" ->> 'page')::numeric = floor(("mark" ->> 'page')::numeric)
  AND jsonb_typeof("mark" -> 'x') = 'number' AND jsonb_typeof("mark" -> 'y') = 'number'
  AND jsonb_typeof("mark" -> 'width') = 'number' AND ("mark" ->> 'width')::numeric > 0
  AND jsonb_typeof("mark" -> 'height') = 'number' AND ("mark" ->> 'height')::numeric > 0
  AND (NOT "mark" ? 'text' OR (jsonb_typeof("mark" -> 'text') = 'string' AND char_length("mark" ->> 'text') <= 300))
), false));

-- 2. A mark is only ever on a bank statement, a financial document: never on a pay stub or any personal record.
CREATE FUNCTION "mark_on_statement"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW."mark" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "Document"
    WHERE "id" = NEW."documentId" AND "kind" = 'bank-statement' AND "sensitivity" = 'financial'
  ) THEN
    RAISE EXCEPTION 'A line can be marked on a bank statement only' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION "mark_on_statement"() FROM PUBLIC;

CREATE TRIGGER "ExpenseDocument_4_mark_on_statement" BEFORE INSERT OR UPDATE ON "ExpenseDocument"
  FOR EACH ROW EXECUTE FUNCTION "mark_on_statement"();
CREATE TRIGGER "WexPaymentDocument_4_mark_on_statement" BEFORE INSERT OR UPDATE ON "WexPaymentDocument"
  FOR EACH ROW EXECUTE FUNCTION "mark_on_statement"();
