-- The QuickBooks names list (owner's decision, 2026-11-27, GitHub issue #132): one list on the workspace says which
-- budget line each QuickBooks account or category goes to, read by Import transactions and Month End Close alike. It
-- replaces the categories saved on an import mapping and the account mapping's own store; those columns and the
-- AccountMapping table stay as they are, unread, until they are dropped once nothing is lost.
--
-- A row is a name as QuickBooks writes it ("60901 Rent Expense"), the budget line's NAME it goes to (so it carries to
-- every engagement with a line of that name) or Unallowable, and, on an engagement's override, that engagement.
-- `list` says which list the row is on: 'quickbooks' today; the payroll rollup joins it next.

-- Owners and bookkeepers of a workspace (an auditor sees only the final report, and the platform admin, who reads no
-- engagement or budget line, is left out).
CREATE FUNCTION "app_writer_workspace_ids"() RETURNS TEXT[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(array_agg(DISTINCT "workspaceId"), ARRAY[]::TEXT[]) FROM "Membership"
  WHERE "userId" = "app_user_id"() AND "role" IN ('owner', 'bookkeeper') AND "workspaceId" = ANY ("app_workspace_ids"())
$$;
REVOKE ALL ON FUNCTION "app_writer_workspace_ids"() FROM PUBLIC;

CREATE TABLE "LineAlias" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "engagementId" TEXT,
    "list" TEXT NOT NULL DEFAULT 'quickbooks',
    "name" TEXT NOT NULL,
    -- The name as the list compares it (aliasKey in packages/types): case, spacing and punctuation aside.
    "key" TEXT NOT NULL,
    "budgetLineName" TEXT,
    "unallowable" BOOLEAN NOT NULL DEFAULT false,
    "changedById" TEXT NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LineAlias_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "LineAlias_list_check" CHECK ("list" IN ('quickbooks')),
    CONSTRAINT "LineAlias_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 200 AND length("key") BETWEEN 1 AND 200),
    -- A budget line or Unallowable, never both and never neither.
    CONSTRAINT "LineAlias_target_check" CHECK (
      ("unallowable" AND "budgetLineName" IS NULL)
      OR (NOT "unallowable" AND "budgetLineName" IS NOT NULL AND length(btrim("budgetLineName")) BETWEEN 1 AND 200))
);
-- One entry per name on the workspace, and one override per name on each engagement.
CREATE UNIQUE INDEX "LineAlias_name_key" ON "LineAlias"("workspaceId", "list", COALESCE("engagementId", ''), "key");
CREATE INDEX "LineAlias_engagementId_idx" ON "LineAlias"("engagementId");
ALTER TABLE "LineAlias" ADD CONSTRAINT "LineAlias_workspaceId_fkey" FOREIGN KEY ("workspaceId")
  REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LineAlias" ADD CONSTRAINT "LineAlias_engagementId_fkey" FOREIGN KEY ("engagementId")
  REFERENCES "Engagement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- It names its workspace itself (a workspace entry has no parent row) and never moves to another.
CREATE TRIGGER "LineAlias_3_keep" BEFORE UPDATE ON "LineAlias"
  FOR EACH ROW EXECUTE FUNCTION "forbid_reparent"('workspaceId');

-- An override names an engagement of its own workspace.
CREATE FUNCTION "LineAlias_engagement_workspace"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  w TEXT;
BEGIN
  IF NEW."engagementId" IS NOT NULL THEN
    SELECT "workspaceId" INTO w FROM "Engagement" WHERE "id" = NEW."engagementId";
    IF w IS NULL OR w <> NEW."workspaceId" THEN
      RAISE EXCEPTION 'A QuickBooks name names an engagement of its own workspace' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION "LineAlias_engagement_workspace"() FROM PUBLIC;
CREATE TRIGGER "LineAlias_4_engagement" BEFORE INSERT OR UPDATE ON "LineAlias"
  FOR EACH ROW EXECUTE FUNCTION "LineAlias_engagement_workspace"();

-- Owners and bookkeepers read and keep the list; each write is made in the writer's own name.
ALTER TABLE "LineAlias" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_read" ON "LineAlias" FOR SELECT
  USING ("workspaceId" = ANY ((SELECT "app_writer_workspace_ids"())::TEXT[]));
CREATE POLICY "tenant_insert" ON "LineAlias" FOR INSERT
  WITH CHECK ("workspaceId" = ANY ((SELECT "app_writer_workspace_ids"())::TEXT[])
    AND "changedById" = (SELECT "app_user_id"()));
CREATE POLICY "tenant_update" ON "LineAlias" FOR UPDATE
  USING ("workspaceId" = ANY ((SELECT "app_writer_workspace_ids"())::TEXT[]))
  WITH CHECK ("workspaceId" = ANY ((SELECT "app_writer_workspace_ids"())::TEXT[])
    AND "changedById" = (SELECT "app_user_id"()));
CREATE POLICY "tenant_delete" ON "LineAlias" FOR DELETE
  USING ("workspaceId" = ANY ((SELECT "app_writer_workspace_ids"())::TEXT[]));
