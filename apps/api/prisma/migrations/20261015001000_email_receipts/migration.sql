-- Email in receipts (GitHub issue #15). Each workspace has one fixed receipts address, `<local part>@<RECEIPTS_DOMAIN>`;
-- a member who files receipts (an owner or bookkeeper) emails a receipt there, the email provider (Resend inbound)
-- calls the API's webhook, and the API queues the email and files it later, in the member's name.

-- 1. The workspace's address: its local part only (the domain is the environment's RECEIPTS_DOMAIN), lowercase
-- letters, digits and hyphens, 3 to 40 characters, unique across workspaces. Null until an owner sets it.
ALTER TABLE "Workspace" ADD COLUMN "receiptsAddress" TEXT;
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_receiptsAddress_check"
  CHECK ("receiptsAddress" IS NULL OR "receiptsAddress" ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$');
CREATE UNIQUE INDEX "Workspace_receiptsAddress_key" ON "Workspace"("receiptsAddress");

-- The platform admin sets the address like the lists (migrations 20261013000200, 20261015000400, 20261015000500): in a
-- workspace it does not own, the admin changes the name, the lists and the receipts address (and Prisma's updatedAt)
-- and nothing else.
CREATE OR REPLACE FUNCTION "workspace_admin_lists_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF "app_is_admin"() AND NOT (OLD."id" = ANY ("app_owned_workspace_ids"()))
     AND (to_jsonb(NEW) - 'name' - 'fundingSources' - 'budgetItems' - 'tagTypes' - 'receiptsAddress' - 'updatedAt')
         IS DISTINCT FROM (to_jsonb(OLD) - 'name' - 'fundingSources' - 'budgetItems' - 'tagTypes' - 'receiptsAddress' - 'updatedAt') THEN
    RAISE EXCEPTION 'The platform admin changes only the name and lists of a workspace' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION "workspace_admin_lists_only"() FROM PUBLIC;

-- 2. An engagement's code: what a subject line names to pick the engagement ("Receipt CP26"). Stored in capitals,
-- 2 to 20 letters, digits and hyphens, unique in its workspace. Null when the team does not use one.
ALTER TABLE "Engagement" ADD COLUMN "code" TEXT;
ALTER TABLE "Engagement" ADD CONSTRAINT "Engagement_code_check"
  CHECK ("code" IS NULL OR "code" ~ '^[A-Z0-9][A-Z0-9-]{1,19}$');
CREATE UNIQUE INDEX "Engagement_workspaceId_code_key" ON "Engagement"("workspaceId", "code");

-- 3. InboundReceipt: the queue of emailed receipts. The webhook writes a row the moment the provider calls (one per
-- provider email id, so a repeated call adds nothing) before anyone knows whose it is; a worker in the API then
-- processes it: received -> processing -> filed | unmatched | rejected, or back to received with a later
-- nextAttemptAt after a failure, and failed after five attempts. It holds the email's envelope (who sent it, to which
-- address, its subject) and what became of it, never a file: the attachments become Document rows like any upload.
CREATE TABLE "InboundReceipt" (
    "id" TEXT NOT NULL,
    "emailId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'received',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "error" TEXT,
    "fromAddress" TEXT,
    "toAddress" TEXT,
    "subject" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "workspaceId" TEXT,
    "senderUserId" TEXT,
    "engagementId" TEXT,
    "documentIds" TEXT[] NOT NULL DEFAULT '{}',
    "filedAttachments" TEXT[] NOT NULL DEFAULT '{}',
    "rejectReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InboundReceipt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "InboundReceipt_status_check"
      CHECK ("status" IN ('received', 'processing', 'filed', 'unmatched', 'rejected', 'failed')),
    CONSTRAINT "InboundReceipt_subject_check" CHECK ("subject" IS NULL OR char_length("subject") <= 300),
    CONSTRAINT "InboundReceipt_error_check" CHECK ("error" IS NULL OR char_length("error") <= 2000)
);
CREATE UNIQUE INDEX "InboundReceipt_emailId_key" ON "InboundReceipt"("emailId");
CREATE INDEX "InboundReceipt_status_nextAttemptAt_idx" ON "InboundReceipt"("status", "nextAttemptAt");
CREATE INDEX "InboundReceipt_workspaceId_receivedAt_idx" ON "InboundReceipt"("workspaceId", "receivedAt");
-- A row goes with its workspace. The engagement and documents it names are plain ids, like the access log's subject:
-- deleting an engagement leaves the inbox's history of it.
ALTER TABLE "InboundReceipt" ADD CONSTRAINT "InboundReceipt_workspaceId_fkey" FOREIGN KEY ("workspaceId")
  REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- What a row came as never changes, and whose it is is said once, by trusted work: the workspace (from the address)
-- and the member who sent it may go from unknown to known under app.system, and never change after. A member of the
-- workspace changes only what became of it (status, engagement, attempts, the documents filed, the notes).
CREATE FUNCTION "inbound_receipt_keep"() RETURNS trigger
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
  RETURN NEW;
END $$;
CREATE TRIGGER "InboundReceipt_3_keep" BEFORE UPDATE ON "InboundReceipt"
  FOR EACH ROW EXECUTE FUNCTION "inbound_receipt_keep"();
REVOKE ALL ON FUNCTION "inbound_receipt_keep"() FROM PUBLIC;

-- Row-level security. A row with no workspace yet is trusted work's alone (app.system): the webhook writes it, the
-- worker reads it, resolves it or rejects it, and removes it after 30 days. Once a row names a workspace it is that
-- workspace's, like any record: its members read it (an auditor reads; what an owner or bookkeeper may change is the
-- application's rule), and trusted work keeps processing it (app.system sees every workspace). Nobody but trusted work
-- inserts one, and a row with a workspace is removed only with the workspace. The platform admin's mark admits nothing
-- here.
ALTER TABLE "InboundReceipt" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_read" ON "InboundReceipt" FOR SELECT
  USING (("workspaceId" IS NULL AND (SELECT "app_is_system"()))
    OR "workspaceId" = ANY ((SELECT "app_workspace_ids"())::TEXT[]));
CREATE POLICY "tenant_insert" ON "InboundReceipt" FOR INSERT
  WITH CHECK ("workspaceId" IS NULL AND (SELECT "app_is_system"()));
CREATE POLICY "tenant_update" ON "InboundReceipt" FOR UPDATE
  USING (("workspaceId" IS NULL AND (SELECT "app_is_system"()))
    OR "workspaceId" = ANY ((SELECT "app_workspace_ids"())::TEXT[]))
  WITH CHECK (("workspaceId" IS NULL AND (SELECT "app_is_system"()))
    OR "workspaceId" = ANY ((SELECT "app_workspace_ids"())::TEXT[]));
CREATE POLICY "tenant_delete" ON "InboundReceipt" FOR DELETE
  USING ("workspaceId" IS NULL AND (SELECT "app_is_system"()));
