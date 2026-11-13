-- The month's expenses from the books (owner's decision, 2026-11-09): the payroll zip's accounting export holds the whole
-- month, and every line on an expense account that is no one's pay run is an expense line of the engagement its class
-- is, on the budget line its account maps to.

-- 1. The line Save wrote from a books line: the month, the transaction, the account, the class and its place among alike.
-- Saving again finds it by this, and a line no longer in the books goes. A payroll line is never one.
ALTER TABLE "Expense" ADD COLUMN "booksKey" TEXT;
CREATE UNIQUE INDEX "Expense_engagementId_booksKey_key" ON "Expense"("engagementId", "booksKey");
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_booksKey_check"
  CHECK ("booksKey" IS NULL OR ("payrollKey" IS NULL AND "payrollKind" IS NULL));

-- 2. An engagement's account mapping: its chart of accounts mapped to the categories its funder bills, read from the
-- zip's "Account mapping" folder (the file itself is not kept), and the budget line an owner chose for a category the
-- file does not tie to one. One per engagement; a file of no engagement waits for an owner to say whose it is. Read as
-- the payroll files are (owners and auditors), changed by owners.
CREATE TABLE "AccountMapping" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "engagementId" TEXT,
  "fileName" TEXT NOT NULL,
  "sha256" TEXT NOT NULL,
  -- AccountMappingRead in apps/api/src/expenses/account-mapping.ts
  "read" JSONB NOT NULL,
  -- category -> budget line id, or 'skip'
  "chosen" JSONB NOT NULL DEFAULT '{}',
  "changedById" TEXT NOT NULL,
  "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AccountMapping_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AccountMapping_sha256_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "AccountMapping_read_check" CHECK (jsonb_typeof("read") = 'object'),
  CONSTRAINT "AccountMapping_chosen_check" CHECK (jsonb_typeof("chosen") = 'object')
);
CREATE UNIQUE INDEX "AccountMapping_engagementId_key" ON "AccountMapping"("engagementId");
CREATE INDEX "AccountMapping_workspaceId_idx" ON "AccountMapping"("workspaceId");
ALTER TABLE "AccountMapping" ADD CONSTRAINT "AccountMapping_workspaceId_fkey" FOREIGN KEY ("workspaceId")
  REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AccountMapping" ADD CONSTRAINT "AccountMapping_engagementId_fkey" FOREIGN KEY ("engagementId")
  REFERENCES "Engagement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE TRIGGER "AccountMapping_3_keep" BEFORE UPDATE ON "AccountMapping"
  FOR EACH ROW EXECUTE FUNCTION "forbid_reparent"('workspaceId');

ALTER TABLE "AccountMapping" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_read" ON "AccountMapping" FOR SELECT
  USING ("workspaceId" = ANY ((SELECT "app_staff_workspace_ids"())::TEXT[]));
CREATE POLICY "tenant_insert" ON "AccountMapping" FOR INSERT
  WITH CHECK ("workspaceId" = ANY ((SELECT "app_owned_workspace_ids"())::TEXT[])
    AND "changedById" = (SELECT "app_user_id"()));
CREATE POLICY "tenant_update" ON "AccountMapping" FOR UPDATE
  USING ("workspaceId" = ANY ((SELECT "app_owned_workspace_ids"())::TEXT[]))
  WITH CHECK ("workspaceId" = ANY ((SELECT "app_owned_workspace_ids"())::TEXT[])
    AND "changedById" = (SELECT "app_user_id"()));
CREATE POLICY "tenant_delete" ON "AccountMapping" FOR DELETE
  USING ("workspaceId" = ANY ((SELECT "app_owned_workspace_ids"())::TEXT[]));
