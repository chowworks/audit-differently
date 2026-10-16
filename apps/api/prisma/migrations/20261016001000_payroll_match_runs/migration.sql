-- "Match payroll & timecards": a payroll zip held on the server while the person checks its matches, and nothing in
-- the month changes until they press Save. A run is one opening of the wizard: its staged files (the zip's files, each
-- read once for its text, page by page, with each line's box) and, unless the run replaces them, the month's payroll
-- documents already on file, read the same way. Matches are worked out from those lines when asked for; nothing about a
-- match is stored until Save, which turns the staged files into the month's documents and links each item to its
-- proof with the line marked. Discard, or 24 hours without a Save, removes the run, its rows and its stored objects.
--
-- The lines are the files' own text, a pay stub's included (a person's name and pay): they live only as long as the
-- run, are read by the workspace's members alone, and are never logged by value.
CREATE TABLE "PayrollMatchRun" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "monthlyReportId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Save also removes the month's earlier payroll documents ("Replace this month's payroll files").
    "replace" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "PayrollMatchRun_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PayrollMatchRun_monthlyReportId_idx" ON "PayrollMatchRun"("monthlyReportId");
CREATE INDEX "PayrollMatchRun_workspaceId_createdAt_idx" ON "PayrollMatchRun"("workspaceId", "createdAt");
ALTER TABLE "PayrollMatchRun" ADD CONSTRAINT "PayrollMatchRun_monthlyReportId_fkey" FOREIGN KEY ("monthlyReportId")
  REFERENCES "MonthlyReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One file of a run: staged (no `documentId`; its object is the run's until Save) or a document already on file
-- (`documentId`, a plain id; its object is the document's and the run never removes it).
CREATE TABLE "PayrollMatchFile" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "documentId" TEXT,
    "kind" TEXT NOT NULL,
    "sensitivity" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "pages" INTEGER NOT NULL DEFAULT 0,
    "scanned" BOOLEAN NOT NULL DEFAULT false,
    -- [{ page, text, x, y, width, height }] in PDF points, as statement-lines.ts reads them.
    "lines" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PayrollMatchFile_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PayrollMatchFile_kind_check"
      CHECK ("kind" IN ('timesheet', 'payroll-register', 'paystub', 'bank-statement')),
    -- Its object lives under its workspace, as every document's does.
    CONSTRAINT "PayrollMatchFile_key_check" CHECK (starts_with("storageKey", "workspaceId" || '/'))
);
CREATE INDEX "PayrollMatchFile_runId_idx" ON "PayrollMatchFile"("runId");
CREATE INDEX "PayrollMatchFile_workspaceId_idx" ON "PayrollMatchFile"("workspaceId");
ALTER TABLE "PayrollMatchFile" ADD CONSTRAINT "PayrollMatchFile_runId_fkey" FOREIGN KEY ("runId")
  REFERENCES "PayrollMatchRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TRIGGER "PayrollMatchRun_1_set_tenant" BEFORE INSERT OR UPDATE ON "PayrollMatchRun"
  FOR EACH ROW EXECUTE FUNCTION "set_tenant_from_parent"('MonthlyReport', 'monthlyReportId');
CREATE TRIGGER "PayrollMatchRun_3_keep" BEFORE UPDATE ON "PayrollMatchRun"
  FOR EACH ROW EXECUTE FUNCTION "forbid_reparent"('monthlyReportId', 'workspaceId');
CREATE TRIGGER "PayrollMatchFile_1_set_tenant" BEFORE INSERT OR UPDATE ON "PayrollMatchFile"
  FOR EACH ROW EXECUTE FUNCTION "set_tenant_from_parent"('PayrollMatchRun', 'runId');
CREATE TRIGGER "PayrollMatchFile_3_keep" BEFORE UPDATE ON "PayrollMatchFile"
  FOR EACH ROW EXECUTE FUNCTION "forbid_reparent"('runId', 'workspaceId');

-- Members read and remove their workspace's runs; a run is started in the caller's own name. The API keeps starting,
-- adding to and saving a run to owners and bookkeepers on a draft month.
ALTER TABLE "PayrollMatchRun" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_read" ON "PayrollMatchRun" FOR SELECT
  USING ("workspaceId" = ANY ((SELECT "app_workspace_ids"())::TEXT[]));
CREATE POLICY "tenant_insert" ON "PayrollMatchRun" FOR INSERT
  WITH CHECK ("workspaceId" = ANY ((SELECT "app_workspace_ids"())::TEXT[])
    AND "createdById" = (SELECT "app_user_id"()));
CREATE POLICY "tenant_update" ON "PayrollMatchRun" FOR UPDATE USING (false) WITH CHECK (false);
CREATE POLICY "tenant_delete" ON "PayrollMatchRun" FOR DELETE
  USING ("workspaceId" = ANY ((SELECT "app_workspace_ids"())::TEXT[]));

ALTER TABLE "PayrollMatchFile" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_read" ON "PayrollMatchFile" FOR SELECT
  USING ("workspaceId" = ANY ((SELECT "app_workspace_ids"())::TEXT[]));
CREATE POLICY "tenant_insert" ON "PayrollMatchFile" FOR INSERT
  WITH CHECK ("workspaceId" = ANY ((SELECT "app_workspace_ids"())::TEXT[]));
CREATE POLICY "tenant_update" ON "PayrollMatchFile" FOR UPDATE USING (false) WITH CHECK (false);
CREATE POLICY "tenant_delete" ON "PayrollMatchFile" FOR DELETE
  USING ("workspaceId" = ANY ((SELECT "app_workspace_ids"())::TEXT[]));
