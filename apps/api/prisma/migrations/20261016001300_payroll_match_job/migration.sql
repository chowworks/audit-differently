-- "Match payroll & timecards" reads its files in a background job (owner's decision, 2026-10-16): the browser only sends
-- them, and a worker inside the API reads each one, so closing the wizard or the browser stops nothing and an API
-- restart loses nothing. A file waits, is read (claimed with a lease, so a stopped worker's claim runs out and the file
-- is tried again), and ends read or, after its last attempt, failed.
ALTER TABLE "PayrollMatchFile"
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'waiting',
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "leaseUntil" TIMESTAMP(3),
  ADD COLUMN "error" TEXT,
  ADD CONSTRAINT "PayrollMatchFile_status_check" CHECK ("status" IN ('waiting', 'reading', 'read', 'failed'));
-- Files staged before this migration were read when they arrived.
UPDATE "PayrollMatchFile" SET "status" = 'read';
CREATE INDEX "PayrollMatchFile_status_leaseUntil_idx" ON "PayrollMatchFile"("status", "leaseUntil");

-- The worker is trusted work (app.system: it finds files in every workspace). It alone updates a file, and only the
-- columns reading fills; members still never change one. A reviewed runAsSystem path: payroll-match.worker.ts.
DROP POLICY "tenant_update" ON "PayrollMatchFile";
CREATE POLICY "tenant_update" ON "PayrollMatchFile" FOR UPDATE
  USING ((SELECT "app_is_system"())) WITH CHECK ((SELECT "app_is_system"()));

CREATE FUNCTION "payroll_match_file_job_only"() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['status', 'attempts', 'leaseUntil', 'error', 'pages', 'scanned', 'lines'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'attempts', 'leaseUntil', 'error', 'pages', 'scanned', 'lines']) THEN
    RAISE EXCEPTION 'Reading a payroll file changes only what was read' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION "payroll_match_file_job_only"() FROM PUBLIC;
CREATE TRIGGER "PayrollMatchFile_4_job_only" BEFORE UPDATE ON "PayrollMatchFile"
  FOR EACH ROW EXECUTE FUNCTION "payroll_match_file_job_only"();
