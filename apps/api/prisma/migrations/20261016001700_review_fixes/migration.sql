-- Fixes from the review of the payroll matching work (2026-10-16): the database now holds what the API already
-- assumed.

-- 1. A proof link's highlights, checked element by element. The checks of migration 20261016001400 ran in lax mode,
-- which unwraps a nested array (so `[[{...}]]` passed) and an array `text` (so `"text": ["..."]` passed). In strict
-- mode `$[*]` is each element as it is: it must be an object with a whole page from 1, numbers for x and y, a box of
-- positive size, and, when it has `text`, a string of at most 300 characters. A check that cannot be worked out (a
-- key missing, a value of the wrong type) counts as a failure (`is unknown`).
ALTER TABLE "ExpenseDocument" DROP CONSTRAINT "ExpenseDocument_marks_check";
ALTER TABLE "WexPaymentDocument" DROP CONSTRAINT "WexPaymentDocument_marks_check";
ALTER TABLE "ExpenseDocument" ADD CONSTRAINT "ExpenseDocument_marks_check" CHECK (
  jsonb_typeof("marks") = 'array' AND jsonb_array_length("marks") <= 20
  AND (jsonb_array_length("marks") = 0 OR "purpose" IN ('payment', 'timesheet', 'register'))
  AND NOT jsonb_path_exists("marks", 'strict $[*] ? (!(@.type() == "object"
      && @.page.type() == "number" && @.page >= 1 && @.page == @.page.floor()
      && @.x.type() == "number" && @.y.type() == "number"
      && @.width.type() == "number" && @.width > 0 && @.height.type() == "number" && @.height > 0
      && (!exists(@.keyvalue() ? (@.key == "text")) || @.text.type() == "string" && !(@.text like_regex "^.{200}.{101}" flag "s")))
    || (@.type() == "object"
      && @.page.type() == "number" && @.page >= 1 && @.page == @.page.floor()
      && @.x.type() == "number" && @.y.type() == "number"
      && @.width.type() == "number" && @.width > 0 && @.height.type() == "number" && @.height > 0
      && (!exists(@.keyvalue() ? (@.key == "text")) || @.text.type() == "string" && !(@.text like_regex "^.{200}.{101}" flag "s"))) is unknown)'));
ALTER TABLE "WexPaymentDocument" ADD CONSTRAINT "WexPaymentDocument_marks_check" CHECK (
  jsonb_typeof("marks") = 'array' AND jsonb_array_length("marks") <= 20
  AND (jsonb_array_length("marks") = 0 OR "purpose" IN ('payment', 'timesheet', 'register'))
  AND NOT jsonb_path_exists("marks", 'strict $[*] ? (!(@.type() == "object"
      && @.page.type() == "number" && @.page >= 1 && @.page == @.page.floor()
      && @.x.type() == "number" && @.y.type() == "number"
      && @.width.type() == "number" && @.width > 0 && @.height.type() == "number" && @.height > 0
      && (!exists(@.keyvalue() ? (@.key == "text")) || @.text.type() == "string" && !(@.text like_regex "^.{200}.{101}" flag "s")))
    || (@.type() == "object"
      && @.page.type() == "number" && @.page >= 1 && @.page == @.page.floor()
      && @.x.type() == "number" && @.y.type() == "number"
      && @.width.type() == "number" && @.width > 0 && @.height.type() == "number" && @.height > 0
      && (!exists(@.keyvalue() ? (@.key == "text")) || @.text.type() == "string" && !(@.text like_regex "^.{200}.{101}" flag "s"))) is unknown)'));

-- 2. A payroll match's file is what its month's document will be: a pay stub personal and the rest financial
-- (DOCUMENT_SENSITIVITY), and its object in its run's month folder, <workspaceId>/<engagementId>/<period>/<name>, as
-- a document's is (migrations 20261011000600 and ..0700). The file's own workspace is set by _1_set_tenant first. Not
-- SECURITY DEFINER: the caller reads the run and its month as row-level security lets them, so a run out of their sight
-- says nothing here (the foreign key or the insert policy refuses the row instead).
ALTER TABLE "PayrollMatchFile" ADD CONSTRAINT "PayrollMatchFile_sensitivity_check"
  CHECK (("kind" = 'paystub' AND "sensitivity" = 'personal') OR ("kind" <> 'paystub' AND "sensitivity" = 'financial'));

CREATE FUNCTION "payroll_match_file_key"() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  prefix TEXT;
BEGIN
  SELECT NEW."workspaceId" || '/' || r."engagementId" || '/' || r."period" || '/' INTO prefix
    FROM "PayrollMatchRun" run JOIN "MonthlyReport" r ON r."id" = run."monthlyReportId"
   WHERE run."id" = NEW."runId";
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF prefix IS NULL OR NEW."storageKey" IS NULL OR position(prefix IN NEW."storageKey") <> 1
     OR length(NEW."storageKey") = length(prefix) OR strpos(substr(NEW."storageKey", length(prefix) + 1), '/') > 0 THEN
    RAISE EXCEPTION 'PayrollMatchFile %: storage key must be in its month''s folder', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION "payroll_match_file_key"() FROM PUBLIC;
CREATE TRIGGER "PayrollMatchFile_2_key" BEFORE INSERT OR UPDATE OF "storageKey", "runId", "workspaceId" ON "PayrollMatchFile"
  FOR EACH ROW EXECUTE FUNCTION "payroll_match_file_key"();

-- Which storage holds the file's object ('r2:<bucket>', or 'local:<host>' for a laptop's disk): the job claims only
-- files of its own storage, so an API with its own bucket on the shared dev database never takes, and fails, another's
-- files (payroll-match.worker.ts, `storageName`). Null on a file staged before this: any job may read it, as before.
ALTER TABLE "PayrollMatchFile" ADD COLUMN "storage" TEXT;

-- 3. Matching statistics are written by the people who run the matchers (owners and bookkeepers), in their own name.
-- The one row that names someone else is a payroll run past 24 hours (`outcome` 'expired'): swept by the next member
-- to start one, and then only someone of the caller's workspaces, or by the sweeper's trusted work
-- (payroll-match.sweeper.ts), which has no caller.
DROP POLICY "tenant_insert" ON "MatchRunStat";
CREATE POLICY "tenant_insert" ON "MatchRunStat" FOR INSERT
  WITH CHECK ("workspaceId" = ANY ((SELECT "app_workspace_ids"())::TEXT[])
    AND ((SELECT "app_is_system"()) AND "feature" = 'payroll' AND "outcome" = 'expired'
    OR EXISTS (SELECT 1 FROM "Membership" m
                 WHERE m."workspaceId" = "MatchRunStat"."workspaceId" AND m."userId" = (SELECT "app_user_id"())
                   AND m."role" IN ('owner', 'bookkeeper'))
    AND ("startedById" = (SELECT "app_user_id"())
      OR ("feature" = 'payroll' AND "outcome" = 'expired'
        AND "startedById" = ANY ((SELECT "app_visible_user_ids"())::TEXT[])))));

-- 4. The full demo mark is the demo seed's alone (scripts/demo-seed.ts, as the database owner): no owner's update and
-- no admin's new workspace sets or clears it. As Workspace_6_receipts_address_kept, the function is not SECURITY
-- DEFINER, so current_user is the role that runs it, and the table's owner (migrations, scripts) passes.
CREATE FUNCTION "workspace_featured_demo_kept"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  before BOOLEAN := CASE WHEN TG_OP = 'UPDATE' THEN OLD."featuredDemo" ELSE false END;
BEGIN
  IF NEW."featuredDemo" IS DISTINCT FROM before
     AND NOT pg_has_role(current_user, (SELECT c.relowner FROM pg_class c WHERE c.oid = TG_RELID), 'MEMBER') THEN
    RAISE EXCEPTION 'Only the demo seed marks the full demo workspace' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "Workspace_8_featured_demo_kept" BEFORE INSERT OR UPDATE ON "Workspace"
  FOR EACH ROW EXECUTE FUNCTION "workspace_featured_demo_kept"();
REVOKE ALL ON FUNCTION "workspace_featured_demo_kept"() FROM PUBLIC;

-- 5. The month lock (migration 20261015001100) covers removing too: an expense, a payroll item or a proof link is
-- removed only while its month is a draft. What goes with its parent still goes: when the month, the engagement, the
-- expense or payroll item, or the document a link points at is being deleted in the same statement (a cascade), the
-- parent is already gone and nothing is refused. So an owner's engagement delete (documents, then months, then the
-- engagement, apps/api/src/deletion/) and an empty draft month's delete still work; the API refuses a document's own
-- delete in a closed or submitted month (`refuseLockedMonth`).
CREATE OR REPLACE FUNCTION "month_is_draft"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  s TEXT;
  p TEXT;
  rec JSONB;
BEGIN
  IF TG_OP = 'DELETE' THEN
    rec := to_jsonb(OLD);
  ELSE
    rec := to_jsonb(NEW);
  END IF;
  IF TG_TABLE_NAME IN ('Expense', 'WexPayment') THEN
    SELECT "status", "period" INTO s, p FROM "MonthlyReport" WHERE "id" = rec->>'monthlyReportId' FOR SHARE;
  ELSIF TG_TABLE_NAME = 'ExpenseDocument' THEN
    SELECT r."status", r."period" INTO s, p FROM "Expense" e
      JOIN "MonthlyReport" r ON r."id" = e."monthlyReportId" WHERE e."id" = rec->>'expenseId' FOR SHARE OF r;
  ELSE
    SELECT r."status", r."period" INTO s, p FROM "WexPayment" w
      JOIN "MonthlyReport" r ON r."id" = w."monthlyReportId" WHERE w."id" = rec->>'wexPaymentId' FOR SHARE OF r;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF s IS NULL
       OR (TG_TABLE_NAME = 'Expense' AND NOT EXISTS (SELECT 1 FROM "Engagement" WHERE "id" = rec->>'engagementId'))
       OR (TG_TABLE_NAME IN ('ExpenseDocument', 'WexPaymentDocument')
           AND NOT EXISTS (SELECT 1 FROM "Document" WHERE "id" = rec->>'documentId')) THEN
      RETURN OLD;
    END IF;
  END IF;
  IF s IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'month_locked: the % report is %; only a draft month can change', p, COALESCE(s, 'missing')
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "Expense_6_month_draft_delete" BEFORE DELETE ON "Expense"
  FOR EACH ROW EXECUTE FUNCTION "month_is_draft"();
CREATE TRIGGER "WexPayment_6_month_draft_delete" BEFORE DELETE ON "WexPayment"
  FOR EACH ROW EXECUTE FUNCTION "month_is_draft"();
CREATE TRIGGER "ExpenseDocument_6_month_draft_delete" BEFORE DELETE ON "ExpenseDocument"
  FOR EACH ROW EXECUTE FUNCTION "month_is_draft"();
CREATE TRIGGER "WexPaymentDocument_6_month_draft_delete" BEFORE DELETE ON "WexPaymentDocument"
  FOR EACH ROW EXECUTE FUNCTION "month_is_draft"();
