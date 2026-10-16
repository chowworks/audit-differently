-- Email administration (Admin tools): the platform admin views and runs again the emailed receipts that went nowhere,
-- or were refused or failed (owner's decision, 2026-10-16). Metadata only: the row holds the envelope (to, from,
-- subject) and what became of it, never a file or the raw message.
--
-- What the mark sees: a row with no workspace (an unknown address, a sender who could not be verified, or an email
-- that failed before anyone knew whose it was, e.g. the provider refused the API's key), and a row of any workspace
-- that was refused ('rejected') or failed for good ('failed'). Nothing else of a workspace's receipts inbox: never a
-- row waiting, being worked on, needing filing or filed. Until now the mark admitted nothing here (migration
-- 20261015001000).
--
-- What the mark changes: "Run again" puts one of those rows back in the queue, due now, with its attempts counted
-- afresh. Only the status, the attempts, when it is next due, the last error and the reason it was refused (and
-- Prisma's updatedAt). A rerun of a workspace's row needs the admin's line in that workspace's access log, written first
-- in the same transaction (below); a row with no workspace has no log to write to (the API's own log says it).

-- ── Read and run again ──────────────────────────────────────────────────────
-- Postgres checks an updated row against the read policy too, so a workspace's row the admin puts back in the queue
-- ('received') must stay readable in that transaction: it is, only when this transaction has already written the
-- admin's line for it in that workspace's access log (its xmin is the transaction's id; a line written inside a
-- savepoint has the savepoint's id and does not count, which fails closed). So a workspace's row is never run again
-- without its line, and once that transaction ends the row is the workspace's alone again. The admin cannot read the
-- log, so the check runs as the function's owner.
CREATE FUNCTION "app_admin_reran"(receipt_id TEXT, workspace_id TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT "app_is_admin"() AND EXISTS (
    SELECT 1 FROM "DataAccessLog" l
     WHERE l."actorId" = "app_user_id"() AND l."workspaceId" = workspace_id AND l."subjectId" = receipt_id
       AND l.xmin = pg_current_xact_id()::xid)
$$;
REVOKE ALL ON FUNCTION "app_admin_reran"(TEXT, TEXT) FROM PUBLIC;

-- What the mark reads and may leave behind: a row with no workspace; a workspace's refused or failed one; and, in the
-- transaction that logged it, a workspace's row it just put back in the queue.
CREATE FUNCTION "app_admin_sees_receipt"(receipt_id TEXT, workspace_id TEXT, receipt_status TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT "app_is_admin"() AND (workspace_id IS NULL OR receipt_status IN ('rejected', 'failed')
    OR (receipt_status = 'received' AND "app_admin_reran"(receipt_id, workspace_id)))
$$;
REVOKE ALL ON FUNCTION "app_admin_sees_receipt"(TEXT, TEXT, TEXT) FROM PUBLIC;

DROP POLICY "tenant_read" ON "InboundReceipt";
CREATE POLICY "tenant_read" ON "InboundReceipt" FOR SELECT
  USING (("workspaceId" IS NULL AND (SELECT "app_is_system"()))
    OR "workspaceId" = ANY ((SELECT "app_workspace_ids"())::TEXT[])
    OR "app_admin_sees_receipt"("id", "workspaceId", "status"));
DROP POLICY "tenant_update" ON "InboundReceipt";
-- The rows the mark may rerun are those it sees as they are now (never a workspace's row already back in the queue);
-- what it leaves behind must be one it may see.
CREATE POLICY "tenant_update" ON "InboundReceipt" FOR UPDATE
  USING (("workspaceId" IS NULL AND (SELECT "app_is_system"()))
    OR "workspaceId" = ANY ((SELECT "app_workspace_ids"())::TEXT[])
    OR ((SELECT "app_is_admin"()) AND ("workspaceId" IS NULL OR "status" IN ('rejected', 'failed'))))
  WITH CHECK (("workspaceId" IS NULL AND (SELECT "app_is_system"()))
    OR "workspaceId" = ANY ((SELECT "app_workspace_ids"())::TEXT[])
    OR "app_admin_sees_receipt"("id", "workspaceId", "status"));
-- Insert and delete are unchanged: the mark adds no email and removes none.

-- The keep trigger as migration 20261015001200 left it, plus: under the mark, only what a rerun changes. The workspace
-- and the sender stay trusted work's (the clause above it already refuses the mark).
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
  IF "app_is_admin"()
     AND (to_jsonb(NEW) - 'status' - 'attempts' - 'nextAttemptAt' - 'error' - 'rejectReason' - 'updatedAt')
         IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'attempts' - 'nextAttemptAt' - 'error' - 'rejectReason' - 'updatedAt') THEN
    RAISE EXCEPTION 'The platform admin only runs an emailed receipt again' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION "inbound_receipt_keep"() FROM PUBLIC;
