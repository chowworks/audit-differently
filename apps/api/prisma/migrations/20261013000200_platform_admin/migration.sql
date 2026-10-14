-- The platform admin: a person whose Clerk publicMetadata.role is 'admin'. The API checks that role with Clerk's
-- backend on every admin request (AdminGuard), then marks the connection app.admin = 'on' beside the admin's own
-- app.user_id and app.workspace_ids (their own memberships, as for anyone). The mark is never set with app.system.
--
-- The admin works at the workspace level only: it sees every workspace, its people and its suggestions, creates a
-- workspace with its first owner (an invitation's placeholder when the owner has not signed in), renames any
-- workspace, manages any workspace's people and lists, and writes the access-log line of what it did there. Nothing
-- else admits the mark: every engagement-level table (Engagement, BudgetLine, MonthlyReport, Expense, Document, the
-- document joins, Participant, WexPayment, Check), the access log's reads, deletion records and Terms acceptances
-- keep their policies, so the admin sees there only what its own memberships give it. It deletes no workspace.
--
-- An admin may seat itself in a workspace (owner's decision, 2026-10-14) and then read its records as that member.
-- What keeps that visible: every membership change made under the mark needs its access-log line in the same
-- transaction (Membership_9_admin_logged), and every line written under the mark names the admin by the email on
-- its own User row (DataAccessLog_1_admin_name). Who is made or unmade an admin is kept in PlatformRoleChange.
--
-- Sections: the mark; Workspace (read, create, rename and lists, and the first owner's Terms record kept);
-- Membership (and the access-log backstop); User; Suggestion; DataAccessLog (insert, and the admin's name pinned);
-- PlatformRoleChange.

-- The mark counts only beside a person: it never stands in for trusted work, which has none.
CREATE FUNCTION "app_is_admin"() RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('app.admin', true), '') = 'on' AND "app_user_id"() IS NOT NULL
$$;

-- ── Workspace: read, create, and change the lists ───────────────────────────
-- Creating a workspace is the admin's alone: trusted work no longer creates one (it did for a self-serve creator,
-- migration 20261011000600), and a signed-in person never did.
DROP POLICY "tenant_read" ON "Workspace";
CREATE POLICY "tenant_read" ON "Workspace" FOR SELECT
  USING ("id" = ANY ((SELECT "app_workspace_ids"())::TEXT[]) OR (SELECT "app_is_system"()) OR (SELECT "app_is_admin"()));
DROP POLICY "tenant_insert" ON "Workspace";
CREATE POLICY "tenant_insert" ON "Workspace" FOR INSERT
  WITH CHECK ((SELECT "app_is_admin"()));
DROP POLICY "tenant_update" ON "Workspace";
CREATE POLICY "tenant_update" ON "Workspace" FOR UPDATE
  USING ("id" = ANY ((SELECT "app_owned_workspace_ids"())::TEXT[]) OR (SELECT "app_is_admin"()))
  WITH CHECK ("id" = ANY ((SELECT "app_owned_workspace_ids"())::TEXT[]) OR (SELECT "app_is_admin"()));

-- A policy cannot name columns, so a trigger keeps the admin's updates to the name and the lists: in a workspace it
-- does not own, the admin changes name and fundingSources (and Prisma's updatedAt) and nothing else (not the Terms on
-- file, not when it was made).
CREATE FUNCTION "workspace_admin_lists_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF "app_is_admin"() AND NOT (OLD."id" = ANY ("app_owned_workspace_ids"()))
     AND (to_jsonb(NEW) - 'name' - 'fundingSources' - 'updatedAt')
         IS DISTINCT FROM (to_jsonb(OLD) - 'name' - 'fundingSources' - 'updatedAt') THEN
    RAISE EXCEPTION 'The platform admin changes only the name and lists of a workspace' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "Workspace_4_admin_lists" BEFORE UPDATE ON "Workspace"
  FOR EACH ROW EXECUTE FUNCTION "workspace_admin_lists_only"();
REVOKE ALL ON FUNCTION "workspace_admin_lists_only"() FROM PUBLIC;

-- The Terms on file are the first owner's onboarding acceptance (MeController), recorded once: after that nobody
-- changes them through the API, an owner or the admin included. Later versions are accepted per person in
-- TermsAcceptance and never touch the workspace. The table's owner (migrations, scripts) and a superuser may still
-- correct them: the function is not SECURITY DEFINER, so current_user is the role that runs the update.
CREATE FUNCTION "workspace_terms_kept"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."termsAcceptedById" IS NOT NULL
     AND (NEW."termsVersion", NEW."termsAcceptedAt", NEW."termsAcceptedById")
         IS DISTINCT FROM (OLD."termsVersion", OLD."termsAcceptedAt", OLD."termsAcceptedById")
     AND NOT pg_has_role(current_user, (SELECT c.relowner FROM pg_class c WHERE c.oid = TG_RELID), 'MEMBER') THEN
    RAISE EXCEPTION 'The Terms accepted by the first owner of a workspace cannot be changed' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "Workspace_5_terms_kept" BEFORE UPDATE ON "Workspace"
  FOR EACH ROW EXECUTE FUNCTION "workspace_terms_kept"();
REVOKE ALL ON FUNCTION "workspace_terms_kept"() FROM PUBLIC;

-- ── Membership: everyone's, in every workspace ──────────────────────────────
DROP POLICY "tenant_read" ON "Membership";
CREATE POLICY "tenant_read" ON "Membership" FOR SELECT
  USING ("workspaceId" = ANY ((SELECT "app_workspace_ids"())::TEXT[]) OR "userId" = (SELECT "app_user_id"()) OR (SELECT "app_is_admin"()));
DROP POLICY "tenant_insert" ON "Membership";
CREATE POLICY "tenant_insert" ON "Membership" FOR INSERT
  WITH CHECK ("workspaceId" = ANY ((SELECT "app_owned_workspace_ids"())::TEXT[]) OR (SELECT "app_is_system"()) OR (SELECT "app_is_admin"()));
DROP POLICY "tenant_update" ON "Membership";
CREATE POLICY "tenant_update" ON "Membership" FOR UPDATE
  USING ("workspaceId" = ANY ((SELECT "app_owned_workspace_ids"())::TEXT[]) OR (SELECT "app_is_system"()) OR (SELECT "app_is_admin"()))
  WITH CHECK ("workspaceId" = ANY ((SELECT "app_owned_workspace_ids"())::TEXT[]) OR (SELECT "app_is_system"()) OR (SELECT "app_is_admin"()));
DROP POLICY "tenant_delete" ON "Membership";
CREATE POLICY "tenant_delete" ON "Membership" FOR DELETE
  USING ("workspaceId" = ANY ((SELECT "app_owned_workspace_ids"())::TEXT[]) OR (SELECT "app_is_system"()) OR (SELECT "app_is_admin"()));

-- Every change the admin makes to a workspace's people is in that workspace's access log: at commit, a membership
-- inserted, updated or deleted under the mark needs a DataAccessLog line in the same workspace, in the admin's name,
-- written by this transaction (its xmin is the transaction's id; a line written inside a savepoint has the
-- savepoint's id and does not count, which fails closed). The API writes both in one AccessLogService.change. The
-- admin cannot read the log, so the check runs as the function's owner.
CREATE FUNCTION "membership_admin_logged"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ws TEXT := CASE WHEN TG_OP = 'DELETE' THEN OLD."workspaceId" ELSE NEW."workspaceId" END;
BEGIN
  IF "app_is_admin"() AND NOT EXISTS (
    SELECT 1 FROM "DataAccessLog" l
     WHERE l."actorId" = "app_user_id"() AND l."workspaceId" = ws AND l.xmin = pg_current_xact_id()::xid
  ) THEN
    RAISE EXCEPTION 'A platform admin changed the people of workspace % without a line in its access log', ws
      USING ERRCODE = '42501';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "Membership_9_admin_logged" AFTER INSERT OR UPDATE OR DELETE ON "Membership"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "membership_admin_logged"();
REVOKE ALL ON FUNCTION "membership_admin_logged"() FROM PUBLIC;

-- ── User: read everyone, and leave an invitation's placeholder ──────────────
DROP POLICY "tenant_read" ON "User";
CREATE POLICY "tenant_read" ON "User" FOR SELECT
  USING ("id" = ANY ((SELECT "app_visible_user_ids"())::TEXT[]) OR (SELECT "app_is_system"()) OR (SELECT "app_is_admin"()));
DROP POLICY "tenant_insert" ON "User";
CREATE POLICY "tenant_insert" ON "User" FOR INSERT
  WITH CHECK ("id" = (SELECT "app_user_id"()) OR (SELECT "app_is_system"()) OR ((SELECT "app_is_admin"()) AND "id" LIKE 'pending-%'));

-- ── Suggestion: read in every workspace ─────────────────────────────────────
DROP POLICY "tenant_read" ON "Suggestion";
CREATE POLICY "tenant_read" ON "Suggestion" FOR SELECT
  USING ("workspaceId" = ANY ((SELECT "app_workspace_ids"())::TEXT[]) OR (SELECT "app_is_admin"()));

-- ── DataAccessLog: write a line in any workspace, in its own name; read none ─
-- The read policy is unchanged: the log describes record activity, which is below the workspace. The API writes the
-- admin's lines without reading them back (AccessLogService), since Postgres applies the read policy to RETURNING.
DROP POLICY "tenant_insert" ON "DataAccessLog";
CREATE POLICY "tenant_insert" ON "DataAccessLog" FOR INSERT
  WITH CHECK ("workspaceId" = ANY ((SELECT "app_workspace_ids"())::TEXT[])
    OR ((SELECT "app_is_admin"()) AND "actorId" = (SELECT "app_user_id"())));

-- A line written under the mark names the admin by the email on its own User row, whatever the API passed, so the
-- workspace's log always shows which admin it was. Same rule as staffName: the account id when there is no email.
CREATE FUNCTION "access_log_admin_name"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF "app_is_admin"() THEN
    NEW."actorName" := COALESCE(
      (SELECT NULLIF("email", '') FROM "User" WHERE "id" = "app_user_id"()), "app_user_id"());
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "DataAccessLog_1_admin_name" BEFORE INSERT ON "DataAccessLog"
  FOR EACH ROW EXECUTE FUNCTION "access_log_admin_name"();
REVOKE ALL ON FUNCTION "access_log_admin_name"() FROM PUBLIC;

-- ── PlatformRoleChange: who made or unmade a platform admin ─────────────────
-- Append-only, one row per attempt that reached Clerk, kept or failed. It belongs to no workspace and has no foreign
-- keys (like DeletionRecord), so it outlives the people it names. Only the mark reads it or adds to it, in the
-- admin's own name; nobody changes or removes a row through the API. It carries a tenant_read policy like every
-- table the API's context must be set for (src/core/tenant-tables.ts).
CREATE TABLE "PlatformRoleChange" (
  "id" TEXT NOT NULL,
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "actorId" TEXT NOT NULL,
  "actorEmail" TEXT,
  "targetId" TEXT NOT NULL,
  "targetEmail" TEXT,
  "oldRole" TEXT,
  "newRole" TEXT,
  "outcome" TEXT NOT NULL,
  "error" TEXT,
  CONSTRAINT "PlatformRoleChange_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PlatformRoleChange_outcome_check" CHECK ("outcome" IN ('done', 'failed'))
);
CREATE INDEX "PlatformRoleChange_at_idx" ON "PlatformRoleChange"("at");

ALTER TABLE "PlatformRoleChange" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_read" ON "PlatformRoleChange" FOR SELECT
  USING ((SELECT "app_is_admin"()));
CREATE POLICY "tenant_insert" ON "PlatformRoleChange" FOR INSERT
  WITH CHECK ((SELECT "app_is_admin"()) AND "actorId" = (SELECT "app_user_id"()));
CREATE POLICY "tenant_update" ON "PlatformRoleChange" FOR UPDATE
  USING (false);
CREATE POLICY "tenant_delete" ON "PlatformRoleChange" FOR DELETE
  USING (false);
