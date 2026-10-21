-- The payroll matchers' reading words, and payroll periods a person gives a file (owner's decisions, 2026-10-19).

-- 1. The words and day windows both payroll match screens read payroll files by ("Pay date", "Check date", a period
-- word, a register's debit totals, a stub's gross and net labels, how many days a debit may be from the pay date), set
-- by a platform admin in Admin tools → Payroll reading for the whole system. Append-only, as HighlightSetting: each save
-- is a new row holding every word and day, the newest is in force, and with no row the defaults are
-- (DEFAULT_PAYROLL_READING). Everyone signed in reads it (matching needs it); only a platform admin (app.admin) adds a
-- row, in their own name; nobody changes or removes one. The API checks each list and number; the database keeps the
-- row an object.
CREATE TABLE "PayrollReadingSetting" (
  "id" TEXT NOT NULL,
  "reading" JSONB NOT NULL,
  "changedById" TEXT NOT NULL,
  "changedByEmail" TEXT,
  "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PayrollReadingSetting_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PayrollReadingSetting_reading_check" CHECK (jsonb_typeof("reading") = 'object')
);
CREATE INDEX "PayrollReadingSetting_changedAt_idx" ON "PayrollReadingSetting"("changedAt");

ALTER TABLE "PayrollReadingSetting" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_read" ON "PayrollReadingSetting" FOR SELECT USING (true);
CREATE POLICY "tenant_insert" ON "PayrollReadingSetting" FOR INSERT
  WITH CHECK ((SELECT "app_is_admin"()) AND "changedById" = (SELECT "app_user_id"()));
CREATE POLICY "tenant_update" ON "PayrollReadingSetting" FOR UPDATE USING (false);
CREATE POLICY "tenant_delete" ON "PayrollReadingSetting" FOR DELETE USING (false);

-- 2. The payroll period a person gave a payroll file whose own could not be read (or that no register is of): its pay
-- period and, if known, its pay date. Kept by the file's contents (its sha256) in the workspace, so the same file is
-- read the same way in every match after: the upload it was given in, Add files, Match again, and the bookkeeper's
-- Auto-Match. It names its workspace itself (there is no parent row), never moves, and goes with the workspace. Every
-- member reads it (matching needs it); owners and bookkeepers give it (the API checks the role), in their own name.
CREATE TABLE "PayrollPeriodGiven" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "sha256" TEXT NOT NULL,
  "start" TEXT NOT NULL,
  "end" TEXT NOT NULL,
  "payDate" TEXT,
  "givenById" TEXT NOT NULL,
  "givenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PayrollPeriodGiven_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PayrollPeriodGiven_sha256_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "PayrollPeriodGiven_dates_check" CHECK (
    "start" ~ '^\d{4}-\d{2}-\d{2}$' AND "end" ~ '^\d{4}-\d{2}-\d{2}$' AND "start" <= "end"
    AND ("payDate" IS NULL OR "payDate" ~ '^\d{4}-\d{2}-\d{2}$'))
);
CREATE UNIQUE INDEX "PayrollPeriodGiven_workspaceId_sha256_key" ON "PayrollPeriodGiven"("workspaceId", "sha256");
ALTER TABLE "PayrollPeriodGiven" ADD CONSTRAINT "PayrollPeriodGiven_workspaceId_fkey" FOREIGN KEY ("workspaceId")
  REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE TRIGGER "PayrollPeriodGiven_3_keep" BEFORE UPDATE ON "PayrollPeriodGiven"
  FOR EACH ROW EXECUTE FUNCTION "forbid_reparent"('workspaceId', 'sha256');

ALTER TABLE "PayrollPeriodGiven" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_read" ON "PayrollPeriodGiven" FOR SELECT
  USING ("workspaceId" = ANY ((SELECT "app_workspace_ids"())::TEXT[]));
CREATE POLICY "tenant_insert" ON "PayrollPeriodGiven" FOR INSERT
  WITH CHECK ("workspaceId" = ANY ((SELECT "app_workspace_ids"())::TEXT[])
    AND "givenById" = (SELECT "app_user_id"()));
CREATE POLICY "tenant_update" ON "PayrollPeriodGiven" FOR UPDATE
  USING ("workspaceId" = ANY ((SELECT "app_workspace_ids"())::TEXT[]))
  WITH CHECK ("workspaceId" = ANY ((SELECT "app_workspace_ids"())::TEXT[])
    AND "givenById" = (SELECT "app_user_id"()));
CREATE POLICY "tenant_delete" ON "PayrollPeriodGiven" FOR DELETE USING (false);
