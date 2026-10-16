-- Emailed receipts, corrections after review (migration 20261015001000 stays as written).

-- 1. "filing": a receipt a person is filing by hand from the receipts inbox. The worker's claim takes only "received"
-- and "processing", so it never files the same email beside them; a hand filing that stopped half way goes back to
-- "unmatched" once its lease runs out (the worker's pass, InboundService.expire).
ALTER TABLE "InboundReceipt" DROP CONSTRAINT "InboundReceipt_status_check";
ALTER TABLE "InboundReceipt" ADD CONSTRAINT "InboundReceipt_status_check"
  CHECK ("status" IN ('received', 'processing', 'filing', 'filed', 'unmatched', 'rejected', 'failed'));

-- 2. The engagement a row was filed into is a real foreign key: deleting the engagement clears it (and, by the trigger
-- below, the documents it listed, which went with the engagement), so the inbox keeps no pointer to a deleted record.
-- A row that names an engagement deleted before this migration is cleared first.
UPDATE "InboundReceipt" r SET "engagementId" = NULL, "documentIds" = '{}'
 WHERE r."engagementId" IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM "Engagement" e WHERE e."id" = r."engagementId");
ALTER TABLE "InboundReceipt" ADD CONSTRAINT "InboundReceipt_engagementId_fkey" FOREIGN KEY ("engagementId")
  REFERENCES "Engagement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 3. Whose a row is, said once and only when it is known: trusted work names the workspace together with the member
-- who sent it (a verified owner or bookkeeper, after DMARC passed), never the workspace alone. Junk (an unknown
-- address, an unverified sender, someone who is not a member) keeps no workspace, so it stays trusted work's to purge.
CREATE OR REPLACE FUNCTION "inbound_receipt_keep"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."emailId", NEW."fromAddress", NEW."toAddress", NEW."subject", NEW."receivedAt")
     IS DISTINCT FROM (OLD."emailId", OLD."fromAddress", OLD."toAddress", OLD."subject", OLD."receivedAt") THEN
    RAISE EXCEPTION 'What an emailed receipt came as cannot be changed' USING ERRCODE = '23514';
  END IF;
  IF OLD."workspaceId" IS NOT NULL AND NEW."workspaceId" IS DISTINCT FROM OLD."workspaceId" THEN
    RAISE EXCEPTION 'InboundReceipt.workspaceId cannot be changed' USING ERRCODE = '23514';
  END IF;
  IF OLD."senderUserId" IS NOT NULL AND NEW."senderUserId" IS DISTINCT FROM OLD."senderUserId" THEN
    RAISE EXCEPTION 'InboundReceipt.senderUserId cannot be changed' USING ERRCODE = '23514';
  END IF;
  IF NOT "app_is_system"() AND (NEW."workspaceId" IS DISTINCT FROM OLD."workspaceId"
     OR NEW."senderUserId" IS DISTINCT FROM OLD."senderUserId") THEN
    RAISE EXCEPTION 'Only trusted work says whose an emailed receipt is' USING ERRCODE = '42501';
  END IF;
  IF OLD."workspaceId" IS NULL AND NEW."workspaceId" IS NOT NULL AND NEW."senderUserId" IS NULL THEN
    RAISE EXCEPTION 'An emailed receipt names its workspace only with its verified sender' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- 4. The engagement a row names is one of the row's own workspace (the update policy alone would let a member write
-- any id), and clearing it clears the documents it listed. Reads Engagement as the function's owner, so the answer
-- does not depend on what the caller may see.
CREATE FUNCTION "inbound_receipt_engagement"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."engagementId" IS NOT NULL AND NEW."engagementId" IS NULL THEN
    NEW."documentIds" := '{}';
  END IF;
  IF NEW."engagementId" IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM "Engagement" e
        WHERE e."id" = NEW."engagementId" AND e."workspaceId" = NEW."workspaceId") THEN
    RAISE EXCEPTION 'InboundReceipt.engagementId must be an engagement of its workspace' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "InboundReceipt_4_engagement" BEFORE INSERT OR UPDATE ON "InboundReceipt"
  FOR EACH ROW EXECUTE FUNCTION "inbound_receipt_engagement"();
REVOKE ALL ON FUNCTION "inbound_receipt_engagement"() FROM PUBLIC;

-- 5. Trusted work removes what nobody needs after 30 days: a row with no workspace (as before), and a row that was
-- refused or failed for good. Nothing else is removed but with its workspace.
DROP POLICY "tenant_delete" ON "InboundReceipt";
CREATE POLICY "tenant_delete" ON "InboundReceipt" FOR DELETE
  USING (("workspaceId" IS NULL OR "status" IN ('rejected', 'failed')) AND (SELECT "app_is_system"()));

-- 6. A workspace's receipts address is set once, by its owners: once set it never moves (mail sent to it must never
-- reach another workspace), so it is not changed or cleared through the API, and the platform admin never sets it
-- (on create or after). The table's owner (migrations, scripts) and a superuser may still correct it, as with the
-- Terms (Workspace_5_terms_kept): the function is not SECURITY DEFINER, so current_user is the role that runs it.
CREATE FUNCTION "workspace_receipts_address_kept"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  before TEXT := CASE WHEN TG_OP = 'UPDATE' THEN OLD."receiptsAddress" END;
BEGIN
  IF NEW."receiptsAddress" IS NOT DISTINCT FROM before
     OR pg_has_role(current_user, (SELECT c.relowner FROM pg_class c WHERE c.oid = TG_RELID), 'MEMBER') THEN
    RETURN NEW;
  END IF;
  IF "app_is_admin"() THEN
    RAISE EXCEPTION 'Only the owners of a workspace set its receipts address' USING ERRCODE = '42501';
  END IF;
  IF before IS NOT NULL THEN
    RAISE EXCEPTION 'A receipts address, once set, is kept' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "Workspace_6_receipts_address_kept" BEFORE INSERT OR UPDATE ON "Workspace"
  FOR EACH ROW EXECUTE FUNCTION "workspace_receipts_address_kept"();
REVOKE ALL ON FUNCTION "workspace_receipts_address_kept"() FROM PUBLIC;
