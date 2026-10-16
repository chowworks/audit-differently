-- A month's ledger changes only while the month is a draft (GitHub issue #15).
--
-- The API refuses a change to a closed or submitted month (`ReportsService.editable`), but it reads the month's
-- status before its write transaction, so a closing approved in between would let the change land in a locked month.
-- This trigger checks the month as it stands at the write: an expense, a payroll item (work-experience payment) or
-- a document linked to either is added or changed only while its month is `draft`. Removing one stays allowed, so
-- deleting an engagement or a workspace (which removes its months with everything under them) still works.
--
-- It takes a share lock on the month's row, so a closing being approved at the same moment waits for this write to
-- commit, and a write that waits on the closing reads the month as the closing left it.
--
-- The message starts with "month_locked:" so the API can answer 409 (`MonthLockedFilter`).

CREATE FUNCTION "month_is_draft"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  s TEXT;
  p TEXT;
BEGIN
  IF TG_TABLE_NAME IN ('Expense', 'WexPayment') THEN
    SELECT "status", "period" INTO s, p FROM "MonthlyReport" WHERE "id" = NEW."monthlyReportId" FOR SHARE;
  ELSIF TG_TABLE_NAME = 'ExpenseDocument' THEN
    SELECT r."status", r."period" INTO s, p FROM "Expense" e
      JOIN "MonthlyReport" r ON r."id" = e."monthlyReportId" WHERE e."id" = NEW."expenseId" FOR SHARE OF r;
  ELSE
    SELECT r."status", r."period" INTO s, p FROM "WexPayment" w
      JOIN "MonthlyReport" r ON r."id" = w."monthlyReportId" WHERE w."id" = NEW."wexPaymentId" FOR SHARE OF r;
  END IF;
  IF s IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'month_locked: the % report is %; only a draft month can change', p, COALESCE(s, 'missing')
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION "month_is_draft"() FROM PUBLIC;

CREATE TRIGGER "Expense_5_month_draft" BEFORE INSERT OR UPDATE ON "Expense"
  FOR EACH ROW EXECUTE FUNCTION "month_is_draft"();
CREATE TRIGGER "WexPayment_5_month_draft" BEFORE INSERT OR UPDATE ON "WexPayment"
  FOR EACH ROW EXECUTE FUNCTION "month_is_draft"();
CREATE TRIGGER "ExpenseDocument_5_month_draft" BEFORE INSERT OR UPDATE ON "ExpenseDocument"
  FOR EACH ROW EXECUTE FUNCTION "month_is_draft"();
CREATE TRIGGER "WexPaymentDocument_5_month_draft" BEFORE INSERT OR UPDATE ON "WexPaymentDocument"
  FOR EACH ROW EXECUTE FUNCTION "month_is_draft"();
