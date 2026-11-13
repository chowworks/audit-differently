-- The receipts of the books' bills (owner's decision, 2026-11-12): a books line on an engagement is a share of one or
-- more bills (its own transaction, or each bill of the pool an allocation entry shares out), and the month's workspace
-- receipts (the zip's "Receipts" folder, filed to no engagement) prove the bills, never the share.

-- 1. The bills a books line was saved with, and the receipt of each: BooksBillSaved[] in packages/types.
ALTER TABLE "Expense" ADD COLUMN "booksBills" JSONB;
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_booksBills_check"
  CHECK ("booksBills" IS NULL OR ("booksKey" IS NOT NULL AND jsonb_typeof("booksBills") = 'array'));

-- 2. An owner's word on one bill of a month: the receipt that proves it, or dropped for want of one (its share then comes
-- off the lines that bill it). Read as the expenses are (owners and auditors), changed by owners.
CREATE TABLE "BooksBill" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "period" TEXT NOT NULL,
  "transactionId" TEXT NOT NULL,
  "documentId" TEXT,
  "dropped" BOOLEAN NOT NULL DEFAULT false,
  "changedById" TEXT NOT NULL,
  "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BooksBill_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BooksBill_period_check" CHECK ("period" ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT "BooksBill_transactionId_check" CHECK (length("transactionId") BETWEEN 1 AND 100),
  -- A bill is proved or dropped, never both.
  CONSTRAINT "BooksBill_one_check" CHECK (NOT ("dropped" AND "documentId" IS NOT NULL))
);
CREATE UNIQUE INDEX "BooksBill_workspaceId_period_transactionId_key"
  ON "BooksBill"("workspaceId", "period", "transactionId");
CREATE INDEX "BooksBill_documentId_idx" ON "BooksBill"("documentId");
ALTER TABLE "BooksBill" ADD CONSTRAINT "BooksBill_workspaceId_fkey" FOREIGN KEY ("workspaceId")
  REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BooksBill" ADD CONSTRAINT "BooksBill_documentId_fkey" FOREIGN KEY ("documentId")
  REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE TRIGGER "BooksBill_3_keep" BEFORE UPDATE ON "BooksBill"
  FOR EACH ROW EXECUTE FUNCTION "forbid_reparent"('workspaceId');

-- Its receipt is one of the same workspace's documents.
CREATE FUNCTION "BooksBill_document_same_workspace"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."documentId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "Document" d WHERE d."id" = NEW."documentId" AND d."workspaceId" = NEW."workspaceId"
  ) THEN
    RAISE EXCEPTION 'A bill''s receipt is a document of its own workspace';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION "BooksBill_document_same_workspace"() FROM PUBLIC;
CREATE TRIGGER "BooksBill_4_document" BEFORE INSERT OR UPDATE ON "BooksBill"
  FOR EACH ROW EXECUTE FUNCTION "BooksBill_document_same_workspace"();

ALTER TABLE "BooksBill" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_read" ON "BooksBill" FOR SELECT
  USING ("workspaceId" = ANY ((SELECT "app_staff_workspace_ids"())::TEXT[]));
CREATE POLICY "tenant_insert" ON "BooksBill" FOR INSERT
  WITH CHECK ("workspaceId" = ANY ((SELECT "app_owned_workspace_ids"())::TEXT[])
    AND "changedById" = (SELECT "app_user_id"()));
CREATE POLICY "tenant_update" ON "BooksBill" FOR UPDATE
  USING ("workspaceId" = ANY ((SELECT "app_owned_workspace_ids"())::TEXT[]))
  WITH CHECK ("workspaceId" = ANY ((SELECT "app_owned_workspace_ids"())::TEXT[])
    AND "changedById" = (SELECT "app_user_id"()));
CREATE POLICY "tenant_delete" ON "BooksBill" FOR DELETE
  USING ("workspaceId" = ANY ((SELECT "app_owned_workspace_ids"())::TEXT[]));
