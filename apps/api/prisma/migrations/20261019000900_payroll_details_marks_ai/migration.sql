-- Payroll details are highlighted and read by AI like every payroll proof (GitHub issue #22, section 8; owner's
-- decisions, 2026-10-19): each item's own copy of the spreadsheet fills that person's rows of the run yellow (a mark is
-- a sheet's row, or one cell of it: page = the sheet, y = the row, x = the column or 0 for the whole row), a platform
-- admin picks what is highlighted on it, and AI reads its rows when the person ticks it.

-- A line marked on a link: also on payroll details, a personal payroll file.
CREATE OR REPLACE FUNCTION "mark_on_statement"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF (NEW."mark" IS NOT NULL OR jsonb_array_length(NEW."marks") > 0) AND NOT EXISTS (
    SELECT 1 FROM "Document"
    WHERE "id" = NEW."documentId" AND (
      ("kind" IN ('bank-statement', 'timesheet', 'payroll-register') AND "sensitivity" = 'financial')
      OR ("kind" IN ('paystub', 'payroll-details') AND "sensitivity" = 'personal')
    )
  ) THEN
    RAISE EXCEPTION 'A line can be marked on a payroll file only' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

ALTER TABLE "HighlightSetting" DROP CONSTRAINT "HighlightSetting_kind_check";
ALTER TABLE "HighlightSetting" ADD CONSTRAINT "HighlightSetting_kind_check"
  CHECK ("kind" IN ('timesheet', 'payroll-register', 'paystub', 'bank-statement', 'payroll-details'));

ALTER TABLE "PayrollFileAiReading" DROP CONSTRAINT "PayrollFileAiReading_kind_check";
ALTER TABLE "PayrollFileAiReading" ADD CONSTRAINT "PayrollFileAiReading_kind_check"
  CHECK ("kind" IN ('timesheet', 'payroll-register', 'paystub', 'bank-statement', 'payroll-details'));
