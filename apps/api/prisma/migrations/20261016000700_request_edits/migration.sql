-- Edits asked for on a draft month, before its closing is approved: the Request edits button records who asked,
-- when, and the comment, without changing the month's status. On a closed month the same button sends the closing
-- back (`sentBackReason`, `sentBackAt`, `sentBackByEmail`). Approving the closing clears all three. The access log
-- names the comment's field, never the comment.
ALTER TABLE "MonthlyReport" ADD COLUMN "editsRequestedAt" TIMESTAMP(3);
ALTER TABLE "MonthlyReport" ADD COLUMN "editsRequestedByEmail" TEXT;
ALTER TABLE "MonthlyReport" ADD COLUMN "editsRequestComment" TEXT;
