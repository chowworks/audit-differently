-- Matching statistics (owner's ask, 2026-10-16; GitHub issue #23): one row per finished match run, so a platform admin
-- sees how often the matchers run, how big the uploads are, how long they take and how well they match (Admin tools →
-- Matching statistics). Counts, sizes and durations only: no file name, no person's or vendor's name, no amount, no
-- document, engagement or month id. The workspace and the person who started it are named by id, and the person by
-- their email too, as staff are named everywhere.
--
-- feature: 'payroll' (Match payroll & timecards), 'receipts' (a month's receipts uploaded at once), 'emailed-receipts'
-- (one email's attachments, filed by the worker as the member who sent it).
-- outcome: payroll 'saved', 'discarded' or 'expired' (left past 24 hours, or replaced by a new run); receipts 'done'
-- or 'failed'.
-- items: payroll items of the month, or receipts filed. matched: proofs found sure, or receipts matched automatically.
-- guessed: proofs picked but not sure (payroll only). missing: proofs with nothing found, or receipts left unmatched.
-- failed: files that could not be read (payroll), or receipts with nothing read from them. bankLines: lines read from
-- the run's bank statements (payroll only).
CREATE TABLE "MatchRunStat" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "startedById" TEXT NOT NULL,
    "startedByEmail" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "outcome" TEXT NOT NULL,
    "fileCount" INTEGER NOT NULL DEFAULT 0,
    "totalBytes" BIGINT NOT NULL DEFAULT 0,
    "readMs" INTEGER,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "items" INTEGER NOT NULL DEFAULT 0,
    "matched" INTEGER NOT NULL DEFAULT 0,
    "guessed" INTEGER NOT NULL DEFAULT 0,
    "missing" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "bankLines" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "MatchRunStat_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MatchRunStat_feature_check" CHECK ("feature" IN ('payroll', 'receipts', 'emailed-receipts')),
    CONSTRAINT "MatchRunStat_outcome_check" CHECK (
      ("feature" = 'payroll' AND "outcome" IN ('saved', 'discarded', 'expired'))
      OR ("feature" <> 'payroll' AND "outcome" IN ('done', 'failed'))),
    CONSTRAINT "MatchRunStat_counts_check" CHECK (
      "fileCount" >= 0 AND "totalBytes" >= 0 AND ("readMs" IS NULL OR "readMs" >= 0) AND "durationMs" >= 0
      AND "items" >= 0 AND "matched" >= 0 AND "guessed" >= 0 AND "missing" >= 0 AND "failed" >= 0 AND "bankLines" >= 0)
);
CREATE INDEX "MatchRunStat_finishedAt_idx" ON "MatchRunStat"("finishedAt");
CREATE INDEX "MatchRunStat_workspaceId_finishedAt_idx" ON "MatchRunStat"("workspaceId", "finishedAt");
-- It names its workspace itself, as an import mapping does: the run it counts is gone by the time it is written (Save
-- and Discard remove a payroll run), so there is no parent row to copy it from. A real foreign key: it goes with its
-- workspace.
ALTER TABLE "MatchRunStat" ADD CONSTRAINT "MatchRunStat_workspaceId_fkey" FOREIGN KEY ("workspaceId")
  REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE TRIGGER "MatchRunStat_3_keep" BEFORE UPDATE ON "MatchRunStat"
  FOR EACH ROW EXECUTE FUNCTION "forbid_reparent"('workspaceId');

-- Append-only. A member writes their own workspace's rows, as the run ends (the person who ends a run may not be the
-- one who started it: an expired run is removed by whoever starts the next). The workspace's owners and the platform
-- admin's mark read them: workspace-level counts, like its memberships (migration 20261013000200). Nobody changes or
-- removes one.
ALTER TABLE "MatchRunStat" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_read" ON "MatchRunStat" FOR SELECT
  USING ("workspaceId" = ANY ((SELECT "app_owned_workspace_ids"())::TEXT[]) OR (SELECT "app_is_admin"()));
CREATE POLICY "tenant_insert" ON "MatchRunStat" FOR INSERT
  WITH CHECK ("workspaceId" = ANY ((SELECT "app_workspace_ids"())::TEXT[]));
CREATE POLICY "tenant_update" ON "MatchRunStat" FOR UPDATE USING (false) WITH CHECK (false);
CREATE POLICY "tenant_delete" ON "MatchRunStat" FOR DELETE USING (false);

-- How long the job spent reading each payroll file, so a run's reading time is known. The job alone fills it.
ALTER TABLE "PayrollMatchFile" ADD COLUMN "readMs" INTEGER;
CREATE OR REPLACE FUNCTION "payroll_match_file_job_only"() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['status', 'attempts', 'leaseUntil', 'error', 'pages', 'scanned', 'lines', 'items', 'readMs'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'attempts', 'leaseUntil', 'error', 'pages', 'scanned', 'lines', 'items', 'readMs']) THEN
    RAISE EXCEPTION 'Reading a payroll file changes only what was read' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
