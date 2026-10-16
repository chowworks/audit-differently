-- Drop the funder reviews kept from before month-end closing (migration 20261015000300).
--
-- The owner's decision (2026-10-15): the only months on file are the fictional seed's, so nothing recorded is lost.
-- Nothing ever read the column.
ALTER TABLE "MonthlyReport" DROP COLUMN "legacyReview";
