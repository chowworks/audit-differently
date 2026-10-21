-- "Match payroll & timecards" for the whole workspace (GitHub issue #22): one payroll zip for a month (a register and a
-- bank statement are the company's, not one engagement's), matched against the payroll items of every engagement with a
-- month for that period, with a reconciliation that accounts for every person-pay in the files. The per-engagement
-- match stays as it is (owner's decision, 2026-10-17).

-- 1. A run is of one month (`monthlyReportId`, as before) or of the workspace and a period (`period`, no month). A
-- workspace run names its workspace itself, as a document does; a month's run still takes it from its month.
ALTER TABLE "PayrollMatchRun" ALTER COLUMN "monthlyReportId" DROP NOT NULL;
ALTER TABLE "PayrollMatchRun" ADD COLUMN "period" TEXT;
ALTER TABLE "PayrollMatchRun" ADD CONSTRAINT "PayrollMatchRun_scope_check" CHECK (
  ("monthlyReportId" IS NOT NULL AND "period" IS NULL)
  OR ("monthlyReportId" IS NULL AND "period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'));
-- A workspace run goes with its workspace (a workspace is deleted only once it has no engagement).
ALTER TABLE "PayrollMatchRun" ADD CONSTRAINT "PayrollMatchRun_workspaceId_fkey" FOREIGN KEY ("workspaceId")
  REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "PayrollMatchRun_workspaceId_period_idx" ON "PayrollMatchRun"("workspaceId", "period");

CREATE FUNCTION "payroll_match_run_tenant"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  w TEXT;
BEGIN
  IF NEW."monthlyReportId" IS NOT NULL THEN
    SELECT "workspaceId" INTO w FROM "MonthlyReport" WHERE "id" = NEW."monthlyReportId";
    IF w IS NULL THEN
      RAISE EXCEPTION 'PayrollMatchRun refers to no MonthlyReport' USING ERRCODE = '23503';
    END IF;
    NEW."workspaceId" := w;
  ELSIF NEW."workspaceId" IS NULL THEN
    RAISE EXCEPTION 'A workspace payroll match names its workspace' USING ERRCODE = '23502';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION "payroll_match_run_tenant"() FROM PUBLIC;
DROP TRIGGER "PayrollMatchRun_1_set_tenant" ON "PayrollMatchRun";
CREATE TRIGGER "PayrollMatchRun_1_set_tenant" BEFORE INSERT OR UPDATE ON "PayrollMatchRun"
  FOR EACH ROW EXECUTE FUNCTION "payroll_match_run_tenant"();
DROP TRIGGER "PayrollMatchRun_3_keep" ON "PayrollMatchRun";
CREATE TRIGGER "PayrollMatchRun_3_keep" BEFORE UPDATE ON "PayrollMatchRun"
  FOR EACH ROW EXECUTE FUNCTION "forbid_reparent"('monthlyReportId', 'workspaceId', 'period');

-- Owners alone start a workspace run (owner's decision, 2026-10-17); a month's run stays any member's in their own name
-- (the API keeps it to owners and bookkeepers on a draft month).
DROP POLICY "tenant_insert" ON "PayrollMatchRun";
CREATE POLICY "tenant_insert" ON "PayrollMatchRun" FOR INSERT
  WITH CHECK ("workspaceId" = ANY ((SELECT "app_workspace_ids"())::TEXT[])
    AND "createdById" = (SELECT "app_user_id"())
    AND ("monthlyReportId" IS NOT NULL OR "workspaceId" = ANY ((SELECT "app_owned_workspace_ids"())::TEXT[])));
-- And owners alone discard one; trusted work removes one past 24 hours (payroll-match.sweeper.ts), as it does a month's.
DROP POLICY "tenant_delete" ON "PayrollMatchRun";
CREATE POLICY "tenant_delete" ON "PayrollMatchRun" FOR DELETE
  USING ("workspaceId" = ANY ((SELECT "app_workspace_ids"())::TEXT[])
    AND ("monthlyReportId" IS NOT NULL OR "workspaceId" = ANY ((SELECT "app_owned_workspace_ids"())::TEXT[])
         OR (SELECT "app_is_system"())));

-- 2. A workspace run's files are staged where their documents will be: the workspace's own folder for the period,
-- <workspaceId>/workspace/<period>/<name> (migration 20261011000700). A month's run keeps its month's folder. A run the
-- caller cannot see is refused here too, so the folder check is never skipped (it used to leave that to the policy).
CREATE OR REPLACE FUNCTION "payroll_match_file_key"() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  prefix TEXT;
BEGIN
  SELECT NEW."workspaceId" || '/'
         || CASE WHEN run."monthlyReportId" IS NULL THEN 'workspace' ELSE r."engagementId" END || '/'
         || CASE WHEN run."monthlyReportId" IS NULL THEN run."period" ELSE r."period" END || '/'
    INTO prefix
    FROM "PayrollMatchRun" run LEFT JOIN "MonthlyReport" r ON r."id" = run."monthlyReportId"
   WHERE run."id" = NEW."runId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PayrollMatchFile refers to no PayrollMatchRun' USING ERRCODE = '23503';
  END IF;
  IF prefix IS NULL OR NEW."storageKey" IS NULL OR position(prefix IN NEW."storageKey") <> 1
     OR length(NEW."storageKey") = length(prefix) OR strpos(substr(NEW."storageKey", length(prefix) + 1), '/') > 0 THEN
    RAISE EXCEPTION 'PayrollMatchFile %: storage key must be in its month''s folder', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- Owners alone add files to a workspace run or remove them (a month's run keeps any member's, as before); the worker's
-- updates (migration 20261016001300) are unchanged. Removing a run takes its files by the foreign key.
DROP POLICY "tenant_insert" ON "PayrollMatchFile";
CREATE POLICY "tenant_insert" ON "PayrollMatchFile" FOR INSERT
  WITH CHECK ("workspaceId" = ANY ((SELECT "app_workspace_ids"())::TEXT[])
    AND EXISTS (SELECT 1 FROM "PayrollMatchRun" run WHERE run."id" = "PayrollMatchFile"."runId"
      AND (run."monthlyReportId" IS NOT NULL OR run."workspaceId" = ANY ((SELECT "app_owned_workspace_ids"())::TEXT[]))));
DROP POLICY "tenant_delete" ON "PayrollMatchFile";
CREATE POLICY "tenant_delete" ON "PayrollMatchFile" FOR DELETE
  USING ("workspaceId" = ANY ((SELECT "app_workspace_ids"())::TEXT[])
    AND EXISTS (SELECT 1 FROM "PayrollMatchRun" run WHERE run."id" = "PayrollMatchFile"."runId"
      AND (run."monthlyReportId" IS NOT NULL OR run."workspaceId" = ANY ((SELECT "app_owned_workspace_ids"())::TEXT[])
           OR (SELECT "app_is_system"()))));

-- A file already on file names a real document of its own workspace, and that document is not removed while an open
-- run holds it (the API discards the runs first). A staged run is temporary: a file whose document is gone is dropped.
DELETE FROM "PayrollMatchFile" f
 WHERE f."documentId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Document" d WHERE d."id" = f."documentId");
ALTER TABLE "PayrollMatchFile" ADD CONSTRAINT "PayrollMatchFile_documentId_fkey" FOREIGN KEY ("documentId")
  REFERENCES "Document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "PayrollMatchFile_documentId_idx" ON "PayrollMatchFile"("documentId");
-- Read as the caller, so a document of another workspace and no document at all are refused alike (the foreign key,
-- which sees every row, would otherwise tell them apart).
CREATE FUNCTION "payroll_match_file_document"() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW."documentId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "Document" WHERE "id" = NEW."documentId" AND "workspaceId" = NEW."workspaceId"
  ) THEN
    RAISE EXCEPTION 'PayrollMatchFile refers to no document of its workspace' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION "payroll_match_file_document"() FROM PUBLIC;
CREATE TRIGGER "PayrollMatchFile_2_document" BEFORE INSERT OR UPDATE OF "documentId", "workspaceId" ON "PayrollMatchFile"
  FOR EACH ROW EXECUTE FUNCTION "payroll_match_file_document"();

-- 3. The reconciliation: each person-pay found in a workspace payroll file when its match was saved (a payroll register's
-- row, a bank statement's transaction, a pay stub), kept for good with its document. Whether it landed on an
-- engagement's payroll item is read from the items' proof links whenever the reconciliation opens; what is kept here is
-- the line itself (its page, its box and its text, which can carry a person's name and pay, as a link's mark does) and,
-- for a pay on no engagement's item, an owner's word that it is not grant-funded, with the reason.
CREATE TABLE "PayrollPayLine" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    -- { page, x, y, width, height, text } in PDF points; null for a scanned pay stub (the file is the pay).
    "mark" JSONB,
    "notFundedReason" TEXT,
    "notFundedById" TEXT,
    "notFundedByEmail" TEXT,
    "notFundedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PayrollPayLine_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PayrollPayLine_kind_check" CHECK ("kind" IN ('payroll-register', 'paystub', 'bank-statement')),
    CONSTRAINT "PayrollPayLine_period_check" CHECK ("period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
    CONSTRAINT "PayrollPayLine_mark_check" CHECK ("mark" IS NULL OR COALESCE((
      jsonb_typeof("mark") = 'object'
      AND jsonb_typeof("mark" -> 'page') = 'number' AND ("mark" ->> 'page')::numeric >= 1
      AND ("mark" ->> 'page')::numeric = floor(("mark" ->> 'page')::numeric)
      AND jsonb_typeof("mark" -> 'x') = 'number' AND jsonb_typeof("mark" -> 'y') = 'number'
      AND jsonb_typeof("mark" -> 'width') = 'number' AND ("mark" ->> 'width')::numeric > 0
      AND jsonb_typeof("mark" -> 'height') = 'number' AND ("mark" ->> 'height')::numeric > 0
      AND (NOT "mark" ? 'text' OR (jsonb_typeof("mark" -> 'text') = 'string' AND char_length("mark" ->> 'text') <= 300))
    ), false)),
    -- Not grant-funded: the reason, who said so and when, all together or none of them.
    CONSTRAINT "PayrollPayLine_not_funded_check" CHECK (
      ("notFundedReason" IS NULL AND "notFundedById" IS NULL AND "notFundedByEmail" IS NULL AND "notFundedAt" IS NULL)
      OR ("notFundedReason" IS NOT NULL AND char_length(btrim("notFundedReason")) BETWEEN 1 AND 500
          AND "notFundedById" IS NOT NULL AND "notFundedByEmail" IS NOT NULL AND "notFundedAt" IS NOT NULL))
);
CREATE INDEX "PayrollPayLine_workspaceId_period_idx" ON "PayrollPayLine"("workspaceId", "period");
CREATE INDEX "PayrollPayLine_documentId_idx" ON "PayrollPayLine"("documentId");
ALTER TABLE "PayrollPayLine" ADD CONSTRAINT "PayrollPayLine_documentId_fkey" FOREIGN KEY ("documentId")
  REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A pay line is of a workspace payroll file (filed to no engagement), of its kind and month, and takes its workspace from
-- it. One check sets the tenant and refuses everything else with one message: read as the caller (not SECURITY DEFINER),
-- so another workspace's document, a missing one, an engagement's, or one of another kind or month all read alike, and an
-- owner learns nothing about another workspace's documents from the wording.
CREATE FUNCTION "payroll_pay_line_document"() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  w TEXT;
BEGIN
  SELECT "workspaceId" INTO w FROM "Document"
   WHERE "id" = NEW."documentId" AND "engagementId" IS NULL AND "kind" = NEW."kind" AND "period" = NEW."period";
  IF w IS NULL THEN
    RAISE EXCEPTION 'A pay line is of a workspace payroll file of its kind and month' USING ERRCODE = '23514';
  END IF;
  NEW."workspaceId" := w;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION "payroll_pay_line_document"() FROM PUBLIC;
CREATE TRIGGER "PayrollPayLine_1_set_tenant" BEFORE INSERT OR UPDATE ON "PayrollPayLine"
  FOR EACH ROW EXECUTE FUNCTION "payroll_pay_line_document"();

CREATE TRIGGER "PayrollPayLine_3_keep" BEFORE UPDATE ON "PayrollPayLine"
  FOR EACH ROW EXECUTE FUNCTION "forbid_reparent"('documentId', 'workspaceId');

-- Once found, a line stays as it was read: only the owner's not-grant-funded word changes.
CREATE FUNCTION "payroll_pay_line_decision_only"() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['notFundedReason', 'notFundedById', 'notFundedByEmail', 'notFundedAt'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['notFundedReason', 'notFundedById', 'notFundedByEmail', 'notFundedAt']) THEN
    RAISE EXCEPTION 'A pay line changes only by being marked not grant-funded' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION "payroll_pay_line_decision_only"() FROM PUBLIC;
CREATE TRIGGER "PayrollPayLine_4_decision_only" BEFORE UPDATE ON "PayrollPayLine"
  FOR EACH ROW EXECUTE FUNCTION "payroll_pay_line_decision_only"();

-- A file whose pays are saved stays where they were found: a pay saved from March's bank statement never comes to point
-- at an April file, or an engagement's, by the document being moved under it. SECURITY DEFINER so the pay lines are
-- found whoever changes the document.
CREATE FUNCTION "document_keep_pay_lines"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF (NEW."kind", NEW."period", NEW."engagementId", NEW."storageKey")
       IS DISTINCT FROM (OLD."kind", OLD."period", OLD."engagementId", OLD."storageKey")
     AND EXISTS (SELECT 1 FROM "PayrollPayLine" WHERE "documentId" = OLD."id") THEN
    RAISE EXCEPTION 'Document %: a payroll file with saved pays keeps its kind, month and place', OLD."id"
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION "document_keep_pay_lines"() FROM PUBLIC;
CREATE TRIGGER "Document_5_keep_pay_lines" BEFORE UPDATE OF "kind", "period", "engagementId", "storageKey" ON "Document"
  FOR EACH ROW EXECUTE FUNCTION "document_keep_pay_lines"();

-- Members read them (the API shows the reconciliation to owners and auditors); owners alone add, decide and remove,
-- since owners alone run the workspace match. They go with their document, by the foreign key.
ALTER TABLE "PayrollPayLine" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_read" ON "PayrollPayLine" FOR SELECT
  USING ("workspaceId" = ANY ((SELECT "app_workspace_ids"())::TEXT[]));
CREATE POLICY "tenant_insert" ON "PayrollPayLine" FOR INSERT
  WITH CHECK ("workspaceId" = ANY ((SELECT "app_owned_workspace_ids"())::TEXT[]));
CREATE POLICY "tenant_update" ON "PayrollPayLine" FOR UPDATE
  USING ("workspaceId" = ANY ((SELECT "app_owned_workspace_ids"())::TEXT[]))
  WITH CHECK ("workspaceId" = ANY ((SELECT "app_owned_workspace_ids"())::TEXT[]));
CREATE POLICY "tenant_delete" ON "PayrollPayLine" FOR DELETE
  USING ("workspaceId" = ANY ((SELECT "app_owned_workspace_ids"())::TEXT[]));

-- 4. "Bookkeepers see payroll": the owners' setting, on by default (today's behaviour). Off, a bookkeeper's monthly
-- report pages leave out the payroll section. The screen only: the API is unchanged (owner's decision, 2026-10-17).
-- The platform admin never changes it in a workspace they do not own (Workspace_4_admin_lists).
ALTER TABLE "Workspace" ADD COLUMN "bookkeepersSeePayroll" BOOLEAN NOT NULL DEFAULT true;
