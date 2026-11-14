-- The bookkeeper's match reads the month's workspace payroll files too (owner's decision, 2026-11-14: the bookkeeper's
-- and the owner's match agree), so a month's run may hold, beside the files staged in its month's folder, a file that is
-- already one of the workspace's documents for that period: <workspaceId>/workspace/<period>/<name>, with that
-- document's id and its own key. A staged file (no document) still goes only in its month's folder, as before.
CREATE OR REPLACE FUNCTION "payroll_match_file_key"() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  prefix TEXT;
  shared TEXT;
BEGIN
  SELECT NEW."workspaceId" || '/'
         || CASE WHEN run."monthlyReportId" IS NULL THEN 'workspace' ELSE r."engagementId" END || '/'
         || CASE WHEN run."monthlyReportId" IS NULL THEN run."period" ELSE r."period" END || '/',
         CASE WHEN run."monthlyReportId" IS NULL THEN NULL
              ELSE NEW."workspaceId" || '/workspace/' || r."period" || '/' END
    INTO prefix, shared
    FROM "PayrollMatchRun" run LEFT JOIN "MonthlyReport" r ON r."id" = run."monthlyReportId"
   WHERE run."id" = NEW."runId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PayrollMatchFile refers to no PayrollMatchRun' USING ERRCODE = '23503';
  END IF;
  -- A month's run holding one of the workspace's documents of its period, by that document's own key.
  IF shared IS NOT NULL AND NEW."documentId" IS NOT NULL AND NEW."storageKey" IS NOT NULL
     AND position(shared IN NEW."storageKey") = 1
     AND EXISTS (SELECT 1 FROM "Document" d
                  WHERE d."id" = NEW."documentId" AND d."workspaceId" = NEW."workspaceId"
                    AND d."engagementId" IS NULL AND d."storageKey" = NEW."storageKey") THEN
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

-- The trigger now also reads "documentId": re-run it when that changes.
DROP TRIGGER "PayrollMatchFile_2_key" ON "PayrollMatchFile";
CREATE TRIGGER "PayrollMatchFile_2_key" BEFORE INSERT OR UPDATE OF "storageKey", "runId", "workspaceId", "documentId"
  ON "PayrollMatchFile" FOR EACH ROW EXECUTE FUNCTION "payroll_match_file_key"();
