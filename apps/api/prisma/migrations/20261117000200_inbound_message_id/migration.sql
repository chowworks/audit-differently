-- The confirmation threads under the email it answers (issue #82): the email's own Message-ID, read from the raw
-- message once its sender is verified, so the reply's In-Reply-To and References name it. A column only added.
ALTER TABLE "InboundReceipt" ADD COLUMN "messageId" TEXT;
ALTER TABLE "InboundReceipt" ADD CONSTRAINT "InboundReceipt_messageId_check"
  CHECK ("messageId" IS NULL OR "messageId" ~ '^<[^<>[:space:]]{1,250}>$');
