-- Import transactions (GitHub issue #15): a file the team exports from its accounting system (a QuickBooks report,
-- or another CSV or Excel file) becomes expense lines, month by month. The file itself is read in memory and never
-- stored; what stays is each line it made, and the mappings people saved for the next file.

-- 1. The fingerprint of the file row an expense came from (a hash of its date, amount, payee, memo and reference),
-- so the same row imported again is flagged and never made twice. Null on an expense typed by hand.
ALTER TABLE "Expense" ADD COLUMN "importFingerprint" TEXT;
CREATE UNIQUE INDEX "Expense_engagementId_importFingerprint_key" ON "Expense"("engagementId", "importFingerprint");

-- 2. ImportMapping: how a kind of file maps to an expense line, saved under a name ("QuickBooks mapping") by an owner
-- or bookkeeper and offered on the next import. `headers` are the file's column names, so a file with the same
-- columns finds it; `columns` says which column holds each field ({ date, vendor, memo, amount, debit, credit,
-- account, category, reference, flipSign }); `categories` maps each category in the file to a budget item key, or
-- to 'skip'. It holds no row of any file.
CREATE TABLE "ImportMapping" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "headers" TEXT[] NOT NULL DEFAULT '{}',
    "columns" JSONB NOT NULL DEFAULT '{}',
    "categories" JSONB NOT NULL DEFAULT '{}',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ImportMapping_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ImportMapping_columns_check" CHECK (jsonb_typeof("columns") = 'object'),
    CONSTRAINT "ImportMapping_categories_check" CHECK (jsonb_typeof("categories") = 'object')
);
CREATE UNIQUE INDEX "ImportMapping_workspaceId_name_key" ON "ImportMapping"("workspaceId", "name");
-- It names its workspace itself, as a suggestion does (a real foreign key; no parent row to copy it from), and goes
-- with the workspace.
ALTER TABLE "ImportMapping" ADD CONSTRAINT "ImportMapping_workspaceId_fkey" FOREIGN KEY ("workspaceId")
  REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A saved mapping stays in its workspace.
CREATE TRIGGER "ImportMapping_3_keep" BEFORE UPDATE ON "ImportMapping"
  FOR EACH ROW EXECUTE FUNCTION "forbid_reparent"('workspaceId');

-- The workspace's members read, save and change its mappings (an auditor changes nothing: the application's rule, as
-- for every record); nobody removes one through the API, and the platform admin, with no membership, sees none.
ALTER TABLE "ImportMapping" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_read" ON "ImportMapping" FOR SELECT
  USING ("workspaceId" = ANY ((SELECT "app_workspace_ids"())::TEXT[]));
CREATE POLICY "tenant_insert" ON "ImportMapping" FOR INSERT
  WITH CHECK ("workspaceId" = ANY ((SELECT "app_workspace_ids"())::TEXT[]));
CREATE POLICY "tenant_update" ON "ImportMapping" FOR UPDATE
  USING ("workspaceId" = ANY ((SELECT "app_workspace_ids"())::TEXT[]))
  WITH CHECK ("workspaceId" = ANY ((SELECT "app_workspace_ids"())::TEXT[]));
CREATE POLICY "tenant_delete" ON "ImportMapping" FOR DELETE USING (false);
