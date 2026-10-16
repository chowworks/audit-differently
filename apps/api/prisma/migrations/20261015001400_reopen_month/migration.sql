-- Reopen a submitted month to correct it (a typo, say): it goes back to a draft, its closing is approved again and
-- it is submitted again. `reopenReason` is why, shown on the month's page while it is a draft and cleared when its
-- closing is approved again, as `sentBackReason` is. The access log names the field, never the reason.
ALTER TABLE "MonthlyReport" ADD COLUMN "reopenReason" TEXT;
