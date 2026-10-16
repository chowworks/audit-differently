-- Match receipts (GitHub issue #15): receipts and invoices uploaded to a month, read for their amount, date and
-- vendor, and matched to the month's expenses as their invoice proof (an ExpenseDocument link, as attaching by hand).

-- 1. What was read from a receipt or invoice, and by what: 'text' (the PDF's own text), 'ai' (Claude read the file),
-- 'person' (typed or corrected on the month's page). Null until something was read. `receiptDismissed` marks one the
-- person said is not for this grant, so it leaves the unmatched list; it can be brought back.
ALTER TABLE "Document" ADD COLUMN "receiptAmount" DECIMAL(12,2);
ALTER TABLE "Document" ADD COLUMN "receiptDate" DATE;
ALTER TABLE "Document" ADD COLUMN "receiptVendor" TEXT;
ALTER TABLE "Document" ADD COLUMN "receiptReadBy" TEXT;
ALTER TABLE "Document" ADD COLUMN "receiptDismissed" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Document" ADD CONSTRAINT "Document_receiptReadBy_check"
  CHECK ("receiptReadBy" IS NULL OR "receiptReadBy" IN ('text', 'ai', 'person'));
ALTER TABLE "Document" ADD CONSTRAINT "Document_receiptVendor_check"
  CHECK ("receiptVendor" IS NULL OR char_length("receiptVendor") <= 200);

-- 2. A personal document (an eligibility record, a pay stub) is never read: none of these is ever set on one.
ALTER TABLE "Document" ADD CONSTRAINT "Document_receipt_financial_only" CHECK (
  "sensitivity" = 'financial' OR (
    "receiptAmount" IS NULL AND "receiptDate" IS NULL AND "receiptVendor" IS NULL
    AND "receiptReadBy" IS NULL AND NOT "receiptDismissed"
  )
);
