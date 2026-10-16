-- Month-end closing replaces "the funder's decision" (issue #15).
--
-- The approval a month needs is the company's own, before the report goes to the funder: the CEO (or whoever
-- approves for the company) approves the month-end closing, often offline, and the bookkeeper records it. The
-- funder's answer is no longer recorded. A month is now `draft`, `closed` (closing approved; the ledger is locked)
-- or `submitted`.
--
-- authorizedByName and authorizedAt keep their columns with the new meaning: who approved the month-end closing
-- and on what day (that person signs the form as "Authorized by"). deniedReason becomes sentBackReason: why the
-- closing was sent back.

-- The funder's review as it was recorded (received date, verification boxes, invoice number), who recorded it and
-- when, with the month's status at the time: kept in `legacyReview` before those columns go, so no recorded
-- decision is lost. Nothing reads it yet.
ALTER TABLE "MonthlyReport" ADD COLUMN "legacyReview" JSONB;
UPDATE "MonthlyReport"
   SET "legacyReview" = jsonb_build_object(
     'review', "review",
     'reviewedById', "reviewedById",
     'reviewedAt', to_jsonb("reviewedAt"),
     'status', "status"
   )
 WHERE "review" IS NOT NULL OR "reviewedById" IS NOT NULL OR "reviewedAt" IS NOT NULL;

-- Existing months. A month already a draft (one `reopen` sent back before this migration) kept the old closing's
-- approver and date and the funder's earlier denial reason: a draft has no closing on file, so they go first.
UPDATE "MonthlyReport" SET "authorizedByName" = NULL, "authorizedAt" = NULL, "deniedReason" = NULL
 WHERE "status" = 'draft';
-- Every month that reached the funder stays submitted; a month the funder denied goes back to a
-- draft with its reason kept as the reason it was sent back, and no closing on file.
UPDATE "MonthlyReport" SET "status" = 'submitted' WHERE "status" IN ('under-review', 'approved', 'paid');
UPDATE "MonthlyReport"
   SET "status" = 'draft', "submittedAt" = NULL, "authorizedByName" = NULL, "authorizedAt" = NULL
 WHERE "status" = 'denied';

ALTER TABLE "MonthlyReport" RENAME COLUMN "deniedReason" TO "sentBackReason";
ALTER TABLE "MonthlyReport" ADD COLUMN "closingNote" TEXT;

-- The funder's review section (received date, verification boxes, invoice number) and who recorded it.
ALTER TABLE "MonthlyReport" DROP COLUMN "review";
ALTER TABLE "MonthlyReport" DROP COLUMN "reviewedById";
ALTER TABLE "MonthlyReport" DROP COLUMN "reviewedAt";

ALTER TABLE "MonthlyReport"
  ADD CONSTRAINT "MonthlyReport_status_check" CHECK ("status" IN ('draft', 'closed', 'submitted'));
