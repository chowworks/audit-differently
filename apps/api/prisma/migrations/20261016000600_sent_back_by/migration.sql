-- Who sent a month's closing back, and when, beside `sentBackReason`: the Send back button names the person who
-- pressed it; a budget change that sends a closed month back names the person who changed the budget. The month's
-- page shows them; approving the closing again clears all three.
ALTER TABLE "MonthlyReport" ADD COLUMN "sentBackAt" TIMESTAMP(3);
ALTER TABLE "MonthlyReport" ADD COLUMN "sentBackByEmail" TEXT;
