-- Fixes from the review of the books' expenses (2026-11-12).

-- 1. A bill's receipt and statement are checked when they are set, not on every change of the bill. Deleting a
-- workspace (or an engagement's shared files) removes a bill's receipt and its statement in one statement; each foreign
-- key then sets its own column to null in an update of its own, and the old check, run on that update, found the other
-- document already gone and refused, so the whole deletion failed.
CREATE OR REPLACE FUNCTION "BooksBill_document_same_workspace"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."documentId" IS NOT NULL
    AND (TG_OP = 'INSERT' OR NEW."documentId" IS DISTINCT FROM OLD."documentId"
      OR NEW."workspaceId" IS DISTINCT FROM OLD."workspaceId")
    AND NOT EXISTS (
      SELECT 1 FROM "Document" d WHERE d."id" = NEW."documentId" AND d."workspaceId" = NEW."workspaceId"
    ) THEN
    RAISE EXCEPTION 'A bill''s receipt is a document of its own workspace';
  END IF;
  IF NEW."paymentDocumentId" IS NOT NULL
    AND (TG_OP = 'INSERT' OR NEW."paymentDocumentId" IS DISTINCT FROM OLD."paymentDocumentId"
      OR NEW."workspaceId" IS DISTINCT FROM OLD."workspaceId")
    AND NOT EXISTS (
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

-- 2. An account mapping names an engagement of its own workspace only. The foreign key is checked past row-level
-- security, so without this an owner could name another workspace's engagement and, the engagement taking one mapping,
-- keep that workspace from keeping its own.
CREATE FUNCTION "AccountMapping_engagement_workspace"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  w TEXT;
BEGIN
  IF NEW."engagementId" IS NOT NULL THEN
    SELECT "workspaceId" INTO w FROM "Engagement" WHERE "id" = NEW."engagementId";
    IF w IS NULL OR w <> NEW."workspaceId" THEN
      RAISE EXCEPTION 'An account mapping names an engagement of its own workspace' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION "AccountMapping_engagement_workspace"() FROM PUBLIC;
CREATE TRIGGER "AccountMapping_4_engagement" BEFORE INSERT OR UPDATE ON "AccountMapping"
  FOR EACH ROW EXECUTE FUNCTION "AccountMapping_engagement_workspace"();

-- 3. The receipts Save linked to a books line before Save marked its own links: marked Save's now, so Save may remove
-- one that no longer proves a bill, and a person's own links stay theirs. Months still a draft only (a submitted
-- month's links are kept as they are).
UPDATE "ExpenseDocument" ed SET "byMatch" = true
FROM "Expense" e, "MonthlyReport" m, "Document" d
WHERE ed."expenseId" = e."id" AND e."monthlyReportId" = m."id" AND ed."documentId" = d."id"
  AND e."booksKey" IS NOT NULL AND ed."purpose" = 'invoice' AND d."kind" = 'receipt'
  AND ed."byMatch" = false AND m."status" = 'draft';
