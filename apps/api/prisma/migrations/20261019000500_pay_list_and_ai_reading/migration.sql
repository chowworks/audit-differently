-- The month's pay list, and what AI read from a payroll file (GitHub issue #22; owner's decisions, 2026-10-19).

-- 1. The pay list: the owner pastes the month's pay, one row per person and payroll run (name, pay date, gross pay), so
-- the workspace payroll match checks the files against it instead of reading them. One per workspace and month, changed
-- in place. It is staff and participant pay, so it is read as the staff list is (owners and auditors) and changed by
-- owners only. It names its workspace itself (no parent row) and never moves.
CREATE TABLE "PayrollPayList" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "period" TEXT NOT NULL,
  -- [{ name, payDate (yyyy-mm-dd), gross }]
  "rows" JSONB NOT NULL DEFAULT '[]',
  "changedById" TEXT NOT NULL,
  "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PayrollPayList_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PayrollPayList_period_check" CHECK ("period" ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT "PayrollPayList_rows_check" CHECK (jsonb_typeof("rows") = 'array' AND jsonb_array_length("rows") <= 2000)
);
CREATE UNIQUE INDEX "PayrollPayList_workspaceId_period_key" ON "PayrollPayList"("workspaceId", "period");
ALTER TABLE "PayrollPayList" ADD CONSTRAINT "PayrollPayList_workspaceId_fkey" FOREIGN KEY ("workspaceId")
  REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE TRIGGER "PayrollPayList_3_keep" BEFORE UPDATE ON "PayrollPayList"
  FOR EACH ROW EXECUTE FUNCTION "forbid_reparent"('workspaceId', 'period');

ALTER TABLE "PayrollPayList" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_read" ON "PayrollPayList" FOR SELECT
  USING ("workspaceId" = ANY ((SELECT "app_staff_workspace_ids"())::TEXT[]));
CREATE POLICY "tenant_insert" ON "PayrollPayList" FOR INSERT
  WITH CHECK ("workspaceId" = ANY ((SELECT "app_owned_workspace_ids"())::TEXT[])
    AND "changedById" = (SELECT "app_user_id"()));
CREATE POLICY "tenant_update" ON "PayrollPayList" FOR UPDATE
  USING ("workspaceId" = ANY ((SELECT "app_owned_workspace_ids"())::TEXT[]))
  WITH CHECK ("workspaceId" = ANY ((SELECT "app_owned_workspace_ids"())::TEXT[])
    AND "changedById" = (SELECT "app_user_id"()));
CREATE POLICY "tenant_delete" ON "PayrollPayList" FOR DELETE
  USING ("workspaceId" = ANY ((SELECT "app_owned_workspace_ids"())::TEXT[]));

-- 2. What AI read from a payroll file, when a person asked for it on a match screen: the values it found, each with the
-- line of the file's own text it was found on (a value it could not show in the file is never kept). Kept by the file's
-- contents (its sha256) in the workspace, as PayrollPeriodGiven, so every later match of the same file uses it. Every
-- member reads it (both match screens); owners and bookkeepers write it (the API checks the role), in their own name.
CREATE TABLE "PayrollFileAiReading" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "sha256" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  -- AiFileFacts in packages/types: the run (pay date, period, totals) and the people found, each with its line
  "facts" JSONB NOT NULL,
  "model" TEXT NOT NULL,
  "readById" TEXT NOT NULL,
  "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PayrollFileAiReading_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PayrollFileAiReading_sha256_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "PayrollFileAiReading_kind_check"
    CHECK ("kind" IN ('timesheet', 'payroll-register', 'paystub', 'bank-statement')),
  CONSTRAINT "PayrollFileAiReading_facts_check" CHECK (jsonb_typeof("facts") = 'object')
);
CREATE UNIQUE INDEX "PayrollFileAiReading_workspaceId_sha256_key" ON "PayrollFileAiReading"("workspaceId", "sha256");
ALTER TABLE "PayrollFileAiReading" ADD CONSTRAINT "PayrollFileAiReading_workspaceId_fkey" FOREIGN KEY ("workspaceId")
  REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE TRIGGER "PayrollFileAiReading_3_keep" BEFORE UPDATE ON "PayrollFileAiReading"
  FOR EACH ROW EXECUTE FUNCTION "forbid_reparent"('workspaceId', 'sha256');

ALTER TABLE "PayrollFileAiReading" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_read" ON "PayrollFileAiReading" FOR SELECT
  USING ("workspaceId" = ANY ((SELECT "app_workspace_ids"())::TEXT[]));
CREATE POLICY "tenant_insert" ON "PayrollFileAiReading" FOR INSERT
  WITH CHECK ("workspaceId" = ANY ((SELECT "app_workspace_ids"())::TEXT[])
    AND "readById" = (SELECT "app_user_id"()));
CREATE POLICY "tenant_update" ON "PayrollFileAiReading" FOR UPDATE
  USING ("workspaceId" = ANY ((SELECT "app_workspace_ids"())::TEXT[]))
  WITH CHECK ("workspaceId" = ANY ((SELECT "app_workspace_ids"())::TEXT[])
    AND "readById" = (SELECT "app_user_id"()));
CREATE POLICY "tenant_delete" ON "PayrollFileAiReading" FOR DELETE USING (false);

-- 3. Two flags a pay stub's kept line may carry (PAY_LINE_FLAGS in packages/types): the stub doesn't show the pay
-- list's amount for its person (`list-disagrees`), and its person was named by AI, not by the name rule, for the owner
-- to confirm (`named-by-ai`).
ALTER TABLE "PayrollPayLine" DROP CONSTRAINT "PayrollPayLine_flags_check";
ALTER TABLE "PayrollPayLine" ADD CONSTRAINT "PayrollPayLine_flags_check" CHECK ("flags" <@ ARRAY[
  'stub-unreadable', 'no-participant', 'several-participants', 'no-month', 'other-month', 'bank-disagrees',
  'register-disagrees', 'duplicate', 'pay-unclear', 'list-disagrees', 'named-by-ai']::TEXT[]);
