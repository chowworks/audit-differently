-- Every receipts address a workspace has used (GitHub issue #24). An owner may now change the workspace's receipts
-- address; the old one is kept here with when it was removed, and mail still sent to it is refused, so a platform
-- admin can see how quiet an address has gone before releasing it for reuse (Admin tools -> Email administration ->
-- Receipts addresses). Once released, any workspace may choose it again, as a new row; the released row stays as it
-- was, with who released it and when.
--
-- How much mail still reached a previously used address is worked out, never stored: the refused emails are kept as
-- InboundReceipt rows (status 'rejected', reason 'this address is no longer in use', no workspace and no sender or
-- subject: only the email's id, the address and when), kept past the 30-day clean-up for as long as the address is
-- held here and not released (InboundService.purgeOld), and removed when it is released (section 5).
--
-- Not a tenant table, on purpose. It holds no engagement, report, expense, document, participant or check data: an
-- address's local part and dates. It must outlive its workspace (an address of a deleted workspace stays held, or the
-- old team's vendors' receipts could land in a new customer's workspace), so `workspaceId` is a plain id with no
-- foreign key, like DataAccessLog's. It is read only by the platform admin's mark, across workspaces, and by trusted
-- work (the inbound webhook and worker, before a sender is known). Members read nothing of it, owners included
-- (owner's decision, 2026-10-17), and no line of a release goes in a workspace's access log (owner's decision,
-- 2026-10-17): the row itself keeps who released it. Like PlatformRoleChange it carries a tenant_read policy, so it
-- is in src/core/tenant-tables.ts.

-- 1. The history. `address` is the local part. An address is held by at most one row not released: a current address
-- and a previously used one are both taken until released. At most one current row (removedAt null) per workspace.
CREATE TABLE "ReceiptsAddress" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "address" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "firstUsedAt" TIMESTAMP(3) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'),
  "removedAt" TIMESTAMP(3),
  "releasedAt" TIMESTAMP(3),
  "releasedById" TEXT,
  "releasedByEmail" TEXT,
  CONSTRAINT "ReceiptsAddress_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ReceiptsAddress_address_check" CHECK ("address" ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  CONSTRAINT "ReceiptsAddress_released_check" CHECK (
    ("releasedAt" IS NULL OR "removedAt" IS NOT NULL)
    AND ("releasedAt" IS NOT NULL OR ("releasedById" IS NULL AND "releasedByEmail" IS NULL)))
);
CREATE UNIQUE INDEX "ReceiptsAddress_address_held_key" ON "ReceiptsAddress"("address")
  WHERE "releasedAt" IS NULL;
CREATE UNIQUE INDEX "ReceiptsAddress_workspaceId_current_key" ON "ReceiptsAddress"("workspaceId")
  WHERE "removedAt" IS NULL;

-- Every address in use today, first used when its "Set the receipts address" line was written, else when the
-- workspace was made (the earliest it could have been set; before this migration no address ever changed hands).
INSERT INTO "ReceiptsAddress" ("address", "workspaceId", "firstUsedAt")
SELECT w."receiptsAddress", w."id",
       COALESCE((SELECT min(l."createdAt") FROM "DataAccessLog" l
                  WHERE l."workspaceId" = w."id" AND l."description" = 'Set the receipts address'),
                w."createdAt")
  FROM "Workspace" w
 WHERE w."receiptsAddress" IS NOT NULL;

-- 2. The history follows the workspace, written by the database, never by the API: a new address is added (refused by
-- ReceiptsAddress_address_held_key when an address not released holds it), the one it replaces gets its removedAt,
-- and so does a deleted workspace's. Runs as the function's owner, so it writes what no API role may.
CREATE FUNCTION "workspace_receipts_address_history"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  before TEXT := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN OLD."receiptsAddress" END;
  after TEXT := CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN NEW."receiptsAddress" END;
  ws TEXT := CASE WHEN TG_OP = 'DELETE' THEN OLD."id" ELSE NEW."id" END;
BEGIN
  IF before IS NOT DISTINCT FROM after THEN
    RETURN NULL;
  END IF;
  IF before IS NOT NULL THEN
    UPDATE "ReceiptsAddress" SET "removedAt" = now() AT TIME ZONE 'UTC'
     WHERE "address" = before AND "removedAt" IS NULL;
  END IF;
  IF after IS NOT NULL THEN
    INSERT INTO "ReceiptsAddress" ("address", "workspaceId") VALUES (after, ws);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER "Workspace_9_receipts_address_history" AFTER INSERT OR UPDATE OF "receiptsAddress" OR DELETE
  ON "Workspace" FOR EACH ROW EXECUTE FUNCTION "workspace_receipts_address_history"();
REVOKE ALL ON FUNCTION "workspace_receipts_address_history"() FROM PUBLIC;

-- 3. Workspace_6_receipts_address_kept, relaxed: an owner may now change the address (the API writes the change and
-- its access-log line in one transaction), never clear it, and the platform admin still never sets it. The table's
-- owner (migrations, scripts) and a superuser may still correct it.
CREATE OR REPLACE FUNCTION "workspace_receipts_address_kept"() RETURNS trigger
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
  IF before IS NOT NULL AND NEW."receiptsAddress" IS NULL THEN
    RAISE EXCEPTION 'A receipts address is changed, never cleared' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

-- 4. What changes on a row once written: the history function above (running as the owner) sets removedAt, and the
-- platform admin's mark releases a previously used row (section 5), which then never changes again, not even by the
-- table's owner. Not SECURITY DEFINER, so current_user is the role that runs it.
CREATE FUNCTION "receipts_address_keep"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."releasedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'A released receipts address is kept as it was released' USING ERRCODE = '42501';
  END IF;
  IF pg_has_role(current_user, (SELECT c.relowner FROM pg_class c WHERE c.oid = TG_RELID), 'MEMBER') THEN
    RETURN NEW;
  END IF;
  IF NOT "app_is_admin"() THEN
    RAISE EXCEPTION 'Only a platform admin releases a receipts address' USING ERRCODE = '42501';
  END IF;
  IF OLD."removedAt" IS NULL THEN
    RAISE EXCEPTION 'A workspace''s current receipts address is never released' USING ERRCODE = '42501';
  END IF;
  IF NEW."releasedAt" IS NULL
     OR (to_jsonb(NEW) - 'releasedAt' - 'releasedById' - 'releasedByEmail')
        IS DISTINCT FROM (to_jsonb(OLD) - 'releasedAt' - 'releasedById' - 'releasedByEmail') THEN
    RAISE EXCEPTION 'A platform admin only releases a receipts address' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ReceiptsAddress_3_keep" BEFORE UPDATE ON "ReceiptsAddress"
  FOR EACH ROW EXECUTE FUNCTION "receipts_address_keep"();
REVOKE ALL ON FUNCTION "receipts_address_keep"() FROM PUBLIC;

-- 5. Releasing. Under the admin's mark the database says who and when, never the client: the time is now, and the
-- admin is named by their own User row's email (as DataAccessLog_1_admin_name names them). No line goes in the
-- workspace's access log: its owners never see this. The address's kept refused emails go in the same statement, so
-- if it is used and removed again its count starts at zero. The reason below is REJECT.retired in
-- src/inbound/inbound.service.ts, word for word (receipts-address-history.db.spec.ts checks it). Runs as the
-- function's owner: the admin reads the User row and removes InboundReceipt rows no API role may.
CREATE FUNCTION "receipts_address_release"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD."releasedAt" IS NOT NULL OR NEW."releasedAt" IS NULL THEN
    RETURN NEW;
  END IF;
  IF "app_is_admin"() THEN
    NEW."releasedAt" := now() AT TIME ZONE 'UTC';
    NEW."releasedById" := "app_user_id"();
    NEW."releasedByEmail" := (SELECT NULLIF("email", '') FROM "User" WHERE "id" = "app_user_id"());
  END IF;
  DELETE FROM "InboundReceipt"
   WHERE "workspaceId" IS NULL AND "status" = 'rejected' AND "fromAddress" IS NULL
     AND "rejectReason" = 'this address is no longer in use'
     AND split_part("toAddress", '@', 1) = OLD."address";
  RETURN NEW;
END $$;
CREATE TRIGGER "ReceiptsAddress_4_release" BEFORE UPDATE ON "ReceiptsAddress"
  FOR EACH ROW EXECUTE FUNCTION "receipts_address_release"();
REVOKE ALL ON FUNCTION "receipts_address_release"() FROM PUBLIC;

-- 6. Row-level security, platform level only. The admin's mark and trusted work read every row; nobody inserts or
-- removes one through the API (the history function inserts, as the owner); the admin's mark releases a previously
-- used row not released yet (the triggers above), and nothing else updates one through the API.
ALTER TABLE "ReceiptsAddress" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_read" ON "ReceiptsAddress" FOR SELECT
  USING ((SELECT "app_is_admin"()) OR (SELECT "app_is_system"()));
CREATE POLICY "tenant_insert" ON "ReceiptsAddress" FOR INSERT WITH CHECK (false);
CREATE POLICY "tenant_update" ON "ReceiptsAddress" FOR UPDATE
  USING ((SELECT "app_is_admin"()) AND "removedAt" IS NOT NULL AND "releasedAt" IS NULL)
  WITH CHECK ((SELECT "app_is_admin"()) AND "releasedAt" IS NOT NULL);
CREATE POLICY "tenant_delete" ON "ReceiptsAddress" FOR DELETE USING (false);

-- 7. Whether an address is taken, current or previously used and not released, for the owner's form: the API says so
-- before it tries (the unique index above says it again). Only yes or no, which the unique index already tells anyone
-- who tries.
CREATE FUNCTION "app_receipts_address_taken"(local_part TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM "ReceiptsAddress" WHERE "address" = local_part AND "releasedAt" IS NULL)
      OR EXISTS (SELECT 1 FROM "Workspace" WHERE "receiptsAddress" = local_part)
$$;
REVOKE ALL ON FUNCTION "app_receipts_address_taken"(TEXT) FROM PUBLIC;
