-- The month's payroll runs (GitHub issue #22; owner's decisions, 2026-10-19): each run's pay date and pay period, kept
-- once for the workspace and month, so every payroll file is placed in a run by the pay date it prints and a
-- participant's payment takes its run's period. It replaces reading each file's period and asking a person file by
-- file (PayrollPeriodGiven, migration 20261019000400), which this drops.

CREATE TABLE "PayrollRunList" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "period" TEXT NOT NULL,
  -- [{ payDate, start, end }], each yyyy-mm-dd
  "runs" JSONB NOT NULL DEFAULT '[]',
  "changedById" TEXT NOT NULL,
  "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PayrollRunList_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PayrollRunList_period_check" CHECK ("period" ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT "PayrollRunList_runs_check" CHECK (jsonb_typeof("runs") = 'array' AND jsonb_array_length("runs") <= 10)
);
CREATE UNIQUE INDEX "PayrollRunList_workspaceId_period_key" ON "PayrollRunList"("workspaceId", "period");
ALTER TABLE "PayrollRunList" ADD CONSTRAINT "PayrollRunList_workspaceId_fkey" FOREIGN KEY ("workspaceId")
  REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE TRIGGER "PayrollRunList_3_keep" BEFORE UPDATE ON "PayrollRunList"
  FOR EACH ROW EXECUTE FUNCTION "forbid_reparent"('workspaceId', 'period');

-- Pay dates and periods are nobody's pay: every member reads them (both match screens); owners and bookkeepers keep
-- them (the API checks the role), in their own name.
ALTER TABLE "PayrollRunList" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_read" ON "PayrollRunList" FOR SELECT
  USING ("workspaceId" = ANY ((SELECT "app_workspace_ids"())::TEXT[]));
CREATE POLICY "tenant_insert" ON "PayrollRunList" FOR INSERT
  WITH CHECK ("workspaceId" = ANY ((SELECT "app_workspace_ids"())::TEXT[])
    AND "changedById" = (SELECT "app_user_id"()));
CREATE POLICY "tenant_update" ON "PayrollRunList" FOR UPDATE
  USING ("workspaceId" = ANY ((SELECT "app_workspace_ids"())::TEXT[]))
  WITH CHECK ("workspaceId" = ANY ((SELECT "app_workspace_ids"())::TEXT[])
    AND "changedById" = (SELECT "app_user_id"()));
CREATE POLICY "tenant_delete" ON "PayrollRunList" FOR DELETE USING (false);

DROP TABLE "PayrollPeriodGiven";
