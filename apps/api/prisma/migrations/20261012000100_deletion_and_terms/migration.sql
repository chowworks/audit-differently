-- Deleting an engagement or a workspace, and the terms an owner accepts creating one.
--
-- 1. Terms: the version and time an owner accepted, on the workspace. Nullable; workspaces made before stay null.
ALTER TABLE "Workspace"
  ADD COLUMN "termsVersion" TEXT,
  ADD COLUMN "termsAcceptedAt" TIMESTAMP(3),
  ADD COLUMN "termsAcceptedById" TEXT;

-- 2. DeletionRecord: what was exported and deleted, by whom. No foreign keys, so it survives the delete of the
-- engagement or workspace it describes. Its workspaceId is named by the row itself (like an engagement's), not
-- copied from a parent, so there is no set_tenant trigger: the policies below tie it to a workspace the writer owns.
CREATE TABLE "DeletionRecord" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "engagementId" TEXT,
  "subjectName" TEXT NOT NULL,
  "deletedById" TEXT NOT NULL,
  "deletedByName" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'exported',
  "exportKey" TEXT NOT NULL,
  "sha256" TEXT NOT NULL DEFAULT '',
  "bytes" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DeletionRecord_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DeletionRecord_status_check" CHECK ("status" IN ('exported', 'downloaded', 'deleted'))
);
CREATE INDEX "DeletionRecord_workspaceId_engagementId_idx" ON "DeletionRecord"("workspaceId", "engagementId");

-- What it describes cannot be re-pointed, and its status only moves forward: exported, downloaded, deleted.
CREATE TRIGGER "DeletionRecord_3_keep" BEFORE UPDATE ON "DeletionRecord"
  FOR EACH ROW EXECUTE FUNCTION "forbid_reparent"('workspaceId', 'engagementId', 'exportKey', 'deletedById', 'subjectName');

CREATE FUNCTION "deletion_record_status_forward"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" <> OLD."status" AND NOT (
       (OLD."status" = 'exported' AND NEW."status" = 'downloaded')
    OR (OLD."status" = 'downloaded' AND NEW."status" = 'deleted')) THEN
    RAISE EXCEPTION 'DeletionRecord status cannot go from % to %', OLD."status", NEW."status" USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "DeletionRecord_2_status" BEFORE UPDATE ON "DeletionRecord"
  FOR EACH ROW EXECUTE FUNCTION "deletion_record_status_forward"();
REVOKE ALL ON FUNCTION "deletion_record_status_forward"() FROM PUBLIC;

-- Only an owner of the workspace reads, writes or updates its records; nobody deletes one through the API (the
-- helper that wrote these for the other tables was dropped at the end of migration 20261011000100).
ALTER TABLE "DeletionRecord" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_read" ON "DeletionRecord" FOR SELECT
  USING ("workspaceId" = ANY ((SELECT "app_owned_workspace_ids"())::TEXT[]));
CREATE POLICY "tenant_insert" ON "DeletionRecord" FOR INSERT
  WITH CHECK ("workspaceId" = ANY ((SELECT "app_owned_workspace_ids"())::TEXT[]));
CREATE POLICY "tenant_update" ON "DeletionRecord" FOR UPDATE
  USING ("workspaceId" = ANY ((SELECT "app_owned_workspace_ids"())::TEXT[]))
  WITH CHECK ("workspaceId" = ANY ((SELECT "app_owned_workspace_ids"())::TEXT[]));
CREATE POLICY "tenant_delete" ON "DeletionRecord" FOR DELETE
  USING (false);

-- 3. A workspace is deleted by trusted work only, after the API has checked the caller owns it and has no
-- engagements left (migration 20261011000600 did the same for creating one). Memberships and suggestions go with
-- it by foreign key; the access log has no foreign key and stays.
DROP POLICY "tenant_delete" ON "Workspace";
CREATE POLICY "tenant_delete" ON "Workspace" FOR DELETE
  USING ((SELECT "app_is_system"()));
