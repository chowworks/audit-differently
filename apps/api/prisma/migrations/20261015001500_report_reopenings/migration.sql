-- Every reopening of a submitted month, kept for good: when and by whom it was reopened, why, and what it undid (the
-- submission, the month-end closing approval and the signed copy that went to the funder). `MonthlyReport` clears
-- those on a reopen, so without this row the history was lost once the month was closed again.
--
-- Append-only: the workspace's members read the rows and add one in their own name; nobody changes or removes one
-- through the API. A row goes only with its month (the foreign key's cascade, which runs as the table's owner and so
-- is not held back by the delete policy), so deleting an engagement still works.
--
-- `reopenedById` is a plain id, as `DataAccessLog.actorId`: the history outlives the person, and the email is kept
-- with it (staff are named by email). `signedDocumentId` is a plain id too: the document's own row may only go with
-- the engagement, and the API refuses to replace or remove a signed copy a row points to.
CREATE TABLE "ReportReopening" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "monthlyReportId" TEXT NOT NULL,
    "reopenedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reopenedById" TEXT NOT NULL,
    "reopenedByEmail" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL,
    "approvedByName" TEXT,
    "approvedAt" TIMESTAMP(3),
    "signedDocumentId" TEXT,
    CONSTRAINT "ReportReopening_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ReportReopening_reason_check" CHECK (char_length("reason") BETWEEN 1 AND 500)
);
CREATE INDEX "ReportReopening_monthlyReportId_reopenedAt_idx" ON "ReportReopening"("monthlyReportId", "reopenedAt");
CREATE INDEX "ReportReopening_workspaceId_idx" ON "ReportReopening"("workspaceId");
ALTER TABLE "ReportReopening" ADD CONSTRAINT "ReportReopening_monthlyReportId_fkey" FOREIGN KEY ("monthlyReportId")
  REFERENCES "MonthlyReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Its workspace is its month's, and it stays with that month.
CREATE TRIGGER "ReportReopening_1_set_tenant" BEFORE INSERT OR UPDATE ON "ReportReopening"
  FOR EACH ROW EXECUTE FUNCTION "set_tenant_from_parent"('MonthlyReport', 'monthlyReportId');
CREATE TRIGGER "ReportReopening_3_keep" BEFORE UPDATE ON "ReportReopening"
  FOR EACH ROW EXECUTE FUNCTION "forbid_reparent"('monthlyReportId', 'workspaceId');

ALTER TABLE "ReportReopening" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_read" ON "ReportReopening" FOR SELECT
  USING ("workspaceId" = ANY ((SELECT "app_workspace_ids"())::TEXT[]));
CREATE POLICY "tenant_insert" ON "ReportReopening" FOR INSERT
  WITH CHECK ("workspaceId" = ANY ((SELECT "app_workspace_ids"())::TEXT[])
    AND "reopenedById" = (SELECT "app_user_id"()));
CREATE POLICY "tenant_update" ON "ReportReopening" FOR UPDATE USING (false) WITH CHECK (false);
CREATE POLICY "tenant_delete" ON "ReportReopening" FOR DELETE USING (false);

-- The latest reason is the newest row's now; the column it replaces goes.
ALTER TABLE "MonthlyReport" DROP COLUMN "reopenReason";
