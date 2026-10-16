-- Exact-word highlights on payroll proof (owner's decision, 2026-10-16): each item's proof carries boxes around the
-- exact words an auditor looks for (the name, the pay period, the pay date, the amount, the row, a transaction's date),
-- as a platform admin sets them per proof type.

-- 1. The words read from a payroll match's files, with their boxes: what a highlight is cut from. The job fills them.
ALTER TABLE "PayrollMatchFile" ADD COLUMN "items" JSONB NOT NULL DEFAULT '[]';
CREATE OR REPLACE FUNCTION "payroll_match_file_job_only"() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['status', 'attempts', 'leaseUntil', 'error', 'pages', 'scanned', 'lines', 'items'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'attempts', 'leaseUntil', 'error', 'pages', 'scanned', 'lines', 'items']) THEN
    RAISE EXCEPTION 'Reading a payroll file changes only what was read' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- 2. The highlights on a proof link: up to 20 boxes, each a whole page from 1 and a box of positive size, with its
-- words (at most 300 characters). Only on a payroll proof (timesheet, register, evidence of payment), and only on a
-- payroll file (the trigger below). `mark` stays: the line found, as before.
ALTER TABLE "ExpenseDocument" ADD COLUMN "marks" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "WexPaymentDocument" ADD COLUMN "marks" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "ExpenseDocument" ADD CONSTRAINT "ExpenseDocument_marks_check" CHECK (
  jsonb_typeof("marks") = 'array' AND jsonb_array_length("marks") <= 20
  AND (jsonb_array_length("marks") = 0 OR "purpose" IN ('payment', 'timesheet', 'register'))
  AND NOT jsonb_path_exists("marks", '$[*] ? (!exists(@.page) || !exists(@.x) || !exists(@.y) || !exists(@.width) || !exists(@.height)
    || @.page.type() != "number" || @.page < 1 || @.page != @.page.floor()
    || @.x.type() != "number" || @.y.type() != "number" || @.width.type() != "number" || @.width <= 0
    || @.height.type() != "number" || @.height <= 0)')
  AND NOT jsonb_path_exists("marks", '$[*].text ? (@.type() != "string" || @ like_regex "^.{200}.{101}" flag "s")'));
ALTER TABLE "WexPaymentDocument" ADD CONSTRAINT "WexPaymentDocument_marks_check" CHECK (
  jsonb_typeof("marks") = 'array' AND jsonb_array_length("marks") <= 20
  AND (jsonb_array_length("marks") = 0 OR "purpose" IN ('payment', 'timesheet', 'register'))
  AND NOT jsonb_path_exists("marks", '$[*] ? (!exists(@.page) || !exists(@.x) || !exists(@.y) || !exists(@.width) || !exists(@.height)
    || @.page.type() != "number" || @.page < 1 || @.page != @.page.floor()
    || @.x.type() != "number" || @.y.type() != "number" || @.width.type() != "number" || @.width <= 0
    || @.height.type() != "number" || @.height <= 0)')
  AND NOT jsonb_path_exists("marks", '$[*].text ? (@.type() != "string" || @ like_regex "^.{200}.{101}" flag "s")'));

CREATE OR REPLACE FUNCTION "mark_on_statement"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF (NEW."mark" IS NOT NULL OR jsonb_array_length(NEW."marks") > 0) AND NOT EXISTS (
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

-- 3. What is highlighted on each proof type, set by a platform admin for the whole system. Append-only: each save is a
-- new row, so the history of who changed what, and when, is the table itself; the newest row per kind is in force,
-- and a kind with no row uses the defaults (DEFAULT_HIGHLIGHTS). Everyone signed in reads it (matching needs it);
-- only a platform admin (app.admin) adds a row, in their own name; nobody changes or removes one.
CREATE TABLE "HighlightSetting" (
  "id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "fields" TEXT[] NOT NULL,
  "changedById" TEXT NOT NULL,
  "changedByEmail" TEXT,
  "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "HighlightSetting_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "HighlightSetting_kind_check"
    CHECK ("kind" IN ('timesheet', 'payroll-register', 'paystub', 'bank-statement')),
  CONSTRAINT "HighlightSetting_fields_check"
    CHECK ("fields" <@ ARRAY['name', 'payPeriod', 'payDate', 'amount', 'row', 'date']::TEXT[]
      AND cardinality("fields") BETWEEN 1 AND 6)
);
CREATE INDEX "HighlightSetting_kind_changedAt_idx" ON "HighlightSetting"("kind", "changedAt");

ALTER TABLE "HighlightSetting" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_read" ON "HighlightSetting" FOR SELECT USING (true);
CREATE POLICY "tenant_insert" ON "HighlightSetting" FOR INSERT
  WITH CHECK ((SELECT "app_is_admin"()) AND "changedById" = (SELECT "app_user_id"()));
CREATE POLICY "tenant_update" ON "HighlightSetting" FOR UPDATE USING (false);
CREATE POLICY "tenant_delete" ON "HighlightSetting" FOR DELETE USING (false);
