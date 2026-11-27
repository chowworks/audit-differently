-- The budget history (GitHub issue #98): each budget file uploaded to an engagement, kept as uploaded, so every earlier
-- version of the approved budget can be downloaded again. The file replaced the whole budget when it was saved, so the
-- newest row is the current budget's file. There is no restore: a person downloads an earlier file and uploads it again.
--
-- Append-only: the workspace's members read the rows and add one in their own name; nobody changes or removes one
-- through the API. A row goes only with its engagement (the foreign key's cascade, which runs as the table's owner and
-- so is not held back by the delete policy); the stored file goes with the engagement's prefix (`deleteByPrefix`).
--
-- The file is stored under the engagement, in the workspace-first key layout of every stored file:
-- `<workspaceId>/<engagementId>/general/<uuid>.xlsx` (or `.csv`). It is never a `Document`: budget files are working
-- files, kept apart from the engagement's records, the audit package and the auditor (owner's rule, 2026-11-27).
--
-- `uploadedById` is a plain id, as `ReportReopening.reopenedById`: the history outlives the person, and the email is
-- kept with it (staff are named by email).
CREATE TABLE "BudgetFile" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "engagementId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "lineCount" INTEGER NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploadedById" TEXT NOT NULL,
    "uploadedByEmail" TEXT NOT NULL,
    CONSTRAINT "BudgetFile_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BudgetFile_fileName_check" CHECK (char_length("fileName") BETWEEN 1 AND 255),
    CONSTRAINT "BudgetFile_size_check" CHECK ("size" > 0),
    CONSTRAINT "BudgetFile_lineCount_check" CHECK ("lineCount" > 0),
    -- Checked after the tenant trigger sets "workspaceId": the file lives under its own workspace and engagement.
    CONSTRAINT "BudgetFile_storageKey_check" CHECK (
      "storageKey" ~ ('^' || "workspaceId" || '/' || "engagementId" || '/general/[0-9a-f-]{36}\.(xlsx|csv)$')
    )
);
CREATE UNIQUE INDEX "BudgetFile_storageKey_key" ON "BudgetFile"("storageKey");
CREATE INDEX "BudgetFile_engagementId_uploadedAt_idx" ON "BudgetFile"("engagementId", "uploadedAt");
CREATE INDEX "BudgetFile_workspaceId_idx" ON "BudgetFile"("workspaceId");
ALTER TABLE "BudgetFile" ADD CONSTRAINT "BudgetFile_engagementId_fkey" FOREIGN KEY ("engagementId")
  REFERENCES "Engagement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Its workspace is its engagement's, and it stays with that engagement.
CREATE TRIGGER "BudgetFile_1_set_tenant" BEFORE INSERT OR UPDATE ON "BudgetFile"
  FOR EACH ROW EXECUTE FUNCTION "set_tenant_from_parent"('Engagement', 'engagementId');
CREATE TRIGGER "BudgetFile_3_keep" BEFORE UPDATE ON "BudgetFile"
  FOR EACH ROW EXECUTE FUNCTION "forbid_reparent"('engagementId', 'workspaceId');

ALTER TABLE "BudgetFile" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_read" ON "BudgetFile" FOR SELECT
  USING ("workspaceId" = ANY ((SELECT "app_workspace_ids"())::TEXT[]));
CREATE POLICY "tenant_insert" ON "BudgetFile" FOR INSERT
  WITH CHECK ("workspaceId" = ANY ((SELECT "app_workspace_ids"())::TEXT[])
    AND "uploadedById" = (SELECT "app_user_id"()));
CREATE POLICY "tenant_update" ON "BudgetFile" FOR UPDATE USING (false) WITH CHECK (false);
CREATE POLICY "tenant_delete" ON "BudgetFile" FOR DELETE USING (false);
