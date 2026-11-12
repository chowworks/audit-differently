-- The payments of the books' bills (owner's decision, 2026-11-12): each bill behind a books line is paid by a line of
-- the month's bank or card statements (the zip's "Bank & card statements" folder, saved with the month's payroll). A bill
-- with no payment found holds the month until an owner finds it or drops the bill.

-- 1. An owner's word on a bill's payment: the statement and the line on it ({ page, text }). A dropped bill has none.
ALTER TABLE "BooksBill" ADD COLUMN "paymentDocumentId" TEXT;
ALTER TABLE "BooksBill" ADD COLUMN "paymentLine" JSONB;
ALTER TABLE "BooksBill" ADD CONSTRAINT "BooksBill_payment_check" CHECK (
  ("paymentDocumentId" IS NULL) = ("paymentLine" IS NULL)
  AND ("paymentLine" IS NULL OR jsonb_typeof("paymentLine") = 'object')
  AND NOT ("dropped" AND "paymentDocumentId" IS NOT NULL));
CREATE INDEX "BooksBill_paymentDocumentId_idx" ON "BooksBill"("paymentDocumentId");
ALTER TABLE "BooksBill" ADD CONSTRAINT "BooksBill_paymentDocumentId_fkey" FOREIGN KEY ("paymentDocumentId")
  REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Its statement, as its receipt, is one of the same workspace's documents. A statement removed takes the line with it.
CREATE OR REPLACE FUNCTION "BooksBill_document_same_workspace"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."documentId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "Document" d WHERE d."id" = NEW."documentId" AND d."workspaceId" = NEW."workspaceId"
  ) THEN
    RAISE EXCEPTION 'A bill''s receipt is a document of its own workspace';
  END IF;
  IF NEW."paymentDocumentId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "Document" d WHERE d."id" = NEW."paymentDocumentId" AND d."workspaceId" = NEW."workspaceId"
  ) THEN
    RAISE EXCEPTION 'A bill''s payment is a statement of its own workspace';
  END IF;
  IF NEW."paymentDocumentId" IS NULL THEN
    NEW."paymentLine" := NULL;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION "BooksBill_document_same_workspace"() FROM PUBLIC;

-- 2. How many days a receipt's date and a statement line's date may be from a bill's, for the whole system: set by a
-- platform admin in Admin tools → File Matching, beside the payroll reading and apart from it. Append-only, as
-- PayrollReadingSetting: each save is a new row holding both, the newest is in force, and with none the defaults are
-- (DEFAULT_EXPENSE_MATCHING). Everyone signed in reads it; only a platform admin adds a row, in their own name; nobody
-- changes or removes one.
CREATE TABLE "ExpenseMatchingSetting" (
  "id" TEXT NOT NULL,
  "matching" JSONB NOT NULL,
  "changedById" TEXT NOT NULL,
  "changedByEmail" TEXT,
  "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ExpenseMatchingSetting_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ExpenseMatchingSetting_matching_check" CHECK (jsonb_typeof("matching") = 'object')
);
CREATE INDEX "ExpenseMatchingSetting_changedAt_idx" ON "ExpenseMatchingSetting"("changedAt");

ALTER TABLE "ExpenseMatchingSetting" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_read" ON "ExpenseMatchingSetting" FOR SELECT USING (true);
CREATE POLICY "tenant_insert" ON "ExpenseMatchingSetting" FOR INSERT
  WITH CHECK ((SELECT "app_is_admin"()) AND "changedById" = (SELECT "app_user_id"()));
CREATE POLICY "tenant_update" ON "ExpenseMatchingSetting" FOR UPDATE USING (false);
CREATE POLICY "tenant_delete" ON "ExpenseMatchingSetting" FOR DELETE USING (false);
