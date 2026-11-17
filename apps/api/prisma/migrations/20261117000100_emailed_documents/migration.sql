-- Emailed documents (issue #82): a word in the subject says what the files are, and the month, so an emailed timesheet,
-- register, pay stub, statement or QuickBooks export lands in Month End Close's File Management, not in receipts.
-- Columns only added.

-- 1. What the email is filed as, and the month, worked out once from its subject (or chosen by a person filing it by
-- hand), so running it again files it the same way and the inbox can say where it went. Null kind: a receipt, as every
-- email was before. The confirmation sent back to its verified sender is claimed once per filing (a retry or a second
-- worker never sends it twice); Run again clears it, so a rerun gets its own. Filing by hand sends none: the person is
-- on the screen and sees where it went.
ALTER TABLE "InboundReceipt"
  ADD COLUMN "intendedKind" TEXT,
  ADD COLUMN "period" TEXT,
  ADD COLUMN "confirmationSentAt" TIMESTAMP(3);
ALTER TABLE "InboundReceipt" ADD CONSTRAINT "InboundReceipt_intendedKind_check"
  CHECK ("intendedKind" IS NULL OR "intendedKind" IN
    ('receipt', 'timesheet', 'payroll-register', 'paystub', 'bank-statement', 'payroll-details'));
ALTER TABLE "InboundReceipt" ADD CONSTRAINT "InboundReceipt_period_check"
  CHECK ("period" IS NULL OR "period" ~ '^\d{4}-(0[1-9]|1[0-2])$');

-- 2. A workspace payroll file added to the month's set outside a match (emailed in, or moved there in File Management)
-- waits for the owner to match the month again; each Save of the month's match clears it for the whole set.
ALTER TABLE "Document" ADD COLUMN "addedSinceMatch" BOOLEAN NOT NULL DEFAULT false;
