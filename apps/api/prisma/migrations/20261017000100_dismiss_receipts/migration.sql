-- An emailed receipt that needs filing but should never be filed (a personal receipt, a duplicate, not a receipt at all)
-- is dismissed by an owner or bookkeeper from the receipts inbox (inbound.service.ts `dismiss`, with its access-log line).
-- It leaves the inbox and goes with the 30-day clean-up, as a refused one does. Only a receipt that needs filing is
-- dismissed, and a dismissed one changes no further.

ALTER TABLE "InboundReceipt" DROP CONSTRAINT "InboundReceipt_status_check";
ALTER TABLE "InboundReceipt" ADD CONSTRAINT "InboundReceipt_status_check"
  CHECK ("status" IN ('received', 'processing', 'filing', 'filed', 'unmatched', 'rejected', 'failed', 'dismissed'));

CREATE FUNCTION "inbound_receipt_dismissed"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" = 'dismissed' AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'A dismissed emailed receipt stays dismissed' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" = 'dismissed' AND OLD."status" IS DISTINCT FROM 'dismissed' AND OLD."status" <> 'unmatched' THEN
    RAISE EXCEPTION 'Only an emailed receipt that needs filing is dismissed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "InboundReceipt_5_dismissed" BEFORE UPDATE ON "InboundReceipt"
  FOR EACH ROW EXECUTE FUNCTION "inbound_receipt_dismissed"();
REVOKE ALL ON FUNCTION "inbound_receipt_dismissed"() FROM PUBLIC;

-- The clean-up (trusted work) removes a dismissed row after 30 days too.
DROP POLICY "tenant_delete" ON "InboundReceipt";
CREATE POLICY "tenant_delete" ON "InboundReceipt" FOR DELETE
  USING (("workspaceId" IS NULL OR "status" IN ('rejected', 'failed', 'dismissed')) AND (SELECT "app_is_system"()));
