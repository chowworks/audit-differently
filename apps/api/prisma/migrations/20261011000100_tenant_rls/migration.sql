-- Tenant isolation, in place from the first deploy (docs/tenant-isolation.md). Every query the API makes
-- carries two transaction-local settings:
--   app.user_id        who the caller is
--   app.workspace_ids  the workspaces the caller belongs to (comma separated)
-- A row is visible to the members of its workspace and to nobody else. With no settings the caller sees
-- nothing. The policies only bind the restricted role the API connects as (scripts/create-app-role.ts):
-- superusers, roles with BYPASSRLS and the tables' owner (migrations, the seed, scripts) are never subject to
-- them, and the API checks at startup which role it connected as (REQUIRE_TENANT_RLS=on refuses to run as one
-- that bypasses them).
SET lock_timeout = '10s';

-- Nothing the restricted role can create in its own session may stand in for a real table or function.
DO $$ BEGIN EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database()); END $$;

-- ── The caller's context ─────────────────────────────────────────────────────

CREATE FUNCTION "app_user_id"() RETURNS TEXT
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.user_id', true), '') $$;

CREATE FUNCTION "app_workspace_ids"() RETURNS TEXT[]
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(string_to_array(NULLIF(current_setting('app.workspace_ids', true), ''), ','), ARRAY[]::TEXT[])
$$;

-- Worked out by the database from the Membership table when the API opens a query, so an invitation given or
-- taken away applies to the next query. These read across workspaces, so only the owner and the role granted
-- in scripts/create-app-role.ts may call them.

-- Every workspace: what trusted background work is given.
CREATE FUNCTION "all_workspace_ids"() RETURNS TEXT[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(array_agg("id"), ARRAY[]::TEXT[]) FROM "Workspace"
$$;

-- The workspaces a person belongs to.
CREATE FUNCTION "workspaces_of_user"(uid TEXT) RETURNS TEXT[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(array_agg(DISTINCT "workspaceId"), ARRAY[]::TEXT[]) FROM "Membership" WHERE "userId" = uid
$$;

-- The workspaces the caller owns: the ones whose staff list they may change.
CREATE FUNCTION "app_owned_workspace_ids"() RETURNS TEXT[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(array_agg(DISTINCT "workspaceId"), ARRAY[]::TEXT[]) FROM "Membership"
  WHERE "userId" = "app_user_id"() AND "role" = 'owner' AND "workspaceId" = ANY ("app_workspace_ids"())
$$;

-- The people a caller may see: themselves, and everyone in their workspaces.
CREATE FUNCTION "app_visible_user_ids"() RETURNS TEXT[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(array_agg(DISTINCT u), ARRAY[]::TEXT[]) FROM (
    SELECT "app_user_id"() AS u
    UNION ALL SELECT "userId" FROM "Membership" WHERE "workspaceId" = ANY ("app_workspace_ids"())
  ) t WHERE u IS NOT NULL
$$;

REVOKE ALL ON FUNCTION "all_workspace_ids"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "workspaces_of_user"(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION "app_owned_workspace_ids"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "app_visible_user_ids"() FROM PUBLIC;

-- ── The tenant column, set by triggers ───────────────────────────────────────
-- A row's workspace is always its parent's, whatever the caller passed. A row whose parent is missing is
-- refused. Triggers fire in name order: 1 sets the tenant, 2 checks a document's workspace, 3 keeps what the
-- row belongs to. An engagement and a document name their workspace themselves (a real foreign key).

-- Rows that hang off one parent copy the column from it. Arguments: the parent table and the column that
-- points at it.
CREATE FUNCTION "set_tenant_from_parent"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  w TEXT;
BEGIN
  EXECUTE format('SELECT "workspaceId" FROM %I WHERE "id" = $1', TG_ARGV[0])
    INTO w USING to_jsonb(NEW) ->> TG_ARGV[1];
  IF w IS NULL THEN
    RAISE EXCEPTION '% refers to no %', TG_TABLE_NAME, TG_ARGV[0] USING ERRCODE = '23503';
  END IF;
  NEW."workspaceId" := w;
  RETURN NEW;
END $$;

CREATE TRIGGER "BudgetLine_1_set_tenant" BEFORE INSERT OR UPDATE ON "BudgetLine"
  FOR EACH ROW EXECUTE FUNCTION "set_tenant_from_parent"('Engagement', 'engagementId');
CREATE TRIGGER "MonthlyReport_1_set_tenant" BEFORE INSERT OR UPDATE ON "MonthlyReport"
  FOR EACH ROW EXECUTE FUNCTION "set_tenant_from_parent"('Engagement', 'engagementId');
CREATE TRIGGER "Expense_1_set_tenant" BEFORE INSERT OR UPDATE ON "Expense"
  FOR EACH ROW EXECUTE FUNCTION "set_tenant_from_parent"('MonthlyReport', 'monthlyReportId');
CREATE TRIGGER "ExpenseDocument_1_set_tenant" BEFORE INSERT OR UPDATE ON "ExpenseDocument"
  FOR EACH ROW EXECUTE FUNCTION "set_tenant_from_parent"('Expense', 'expenseId');
CREATE TRIGGER "Participant_1_set_tenant" BEFORE INSERT OR UPDATE ON "Participant"
  FOR EACH ROW EXECUTE FUNCTION "set_tenant_from_parent"('Engagement', 'engagementId');
CREATE TRIGGER "ParticipantDocument_1_set_tenant" BEFORE INSERT OR UPDATE ON "ParticipantDocument"
  FOR EACH ROW EXECUTE FUNCTION "set_tenant_from_parent"('Participant', 'participantId');
CREATE TRIGGER "WexPayment_1_set_tenant" BEFORE INSERT OR UPDATE ON "WexPayment"
  FOR EACH ROW EXECUTE FUNCTION "set_tenant_from_parent"('MonthlyReport', 'monthlyReportId');
CREATE TRIGGER "WexPaymentDocument_1_set_tenant" BEFORE INSERT OR UPDATE ON "WexPaymentDocument"
  FOR EACH ROW EXECUTE FUNCTION "set_tenant_from_parent"('WexPayment', 'wexPaymentId');
CREATE TRIGGER "Check_1_set_tenant" BEFORE INSERT OR UPDATE ON "Check"
  FOR EACH ROW EXECUTE FUNCTION "set_tenant_from_parent"('MonthlyReport', 'monthlyReportId');

-- A document that names an engagement must be of that engagement's workspace.
CREATE FUNCTION "document_engagement_workspace"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  w TEXT;
BEGIN
  IF NEW."engagementId" IS NOT NULL THEN
    SELECT "workspaceId" INTO w FROM "Engagement" WHERE "id" = NEW."engagementId";
    IF w IS NULL OR w <> NEW."workspaceId" THEN
      RAISE EXCEPTION 'Document names an engagement of another workspace' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "Document_1_engagement_workspace" BEFORE INSERT OR UPDATE ON "Document"
  FOR EACH ROW EXECUTE FUNCTION "document_engagement_workspace"();

-- A document may only be attached to rows of its own workspace. A foreign key alone would accept another
-- workspace's document id, because constraint checks are not subject to the policies.
CREATE FUNCTION "document_same_workspace"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  w TEXT;
BEGIN
  SELECT "workspaceId" INTO w FROM "Document" WHERE "id" = NEW."documentId";
  IF w IS NULL OR w <> NEW."workspaceId" THEN
    RAISE EXCEPTION 'Document % does not belong to this workspace', NEW."documentId" USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "ExpenseDocument_2_document_workspace" BEFORE INSERT OR UPDATE ON "ExpenseDocument"
  FOR EACH ROW EXECUTE FUNCTION "document_same_workspace"();
CREATE TRIGGER "ParticipantDocument_2_document_workspace" BEFORE INSERT OR UPDATE ON "ParticipantDocument"
  FOR EACH ROW EXECUTE FUNCTION "document_same_workspace"();
CREATE TRIGGER "WexPaymentDocument_2_document_workspace" BEFORE INSERT OR UPDATE ON "WexPaymentDocument"
  FOR EACH ROW EXECUTE FUNCTION "document_same_workspace"();

-- What a row belongs to cannot be re-pointed. Arguments: the columns that may not change.
CREATE FUNCTION "forbid_reparent"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  col TEXT;
BEGIN
  FOREACH col IN ARRAY TG_ARGV LOOP
    IF (to_jsonb(NEW) ->> col) IS DISTINCT FROM (to_jsonb(OLD) ->> col) THEN
      RAISE EXCEPTION '%.% cannot be changed', TG_TABLE_NAME, col USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;

CREATE TRIGGER "Membership_3_keep" BEFORE UPDATE ON "Membership"
  FOR EACH ROW EXECUTE FUNCTION "forbid_reparent"('userId', 'workspaceId');
CREATE TRIGGER "Engagement_3_keep" BEFORE UPDATE ON "Engagement"
  FOR EACH ROW EXECUTE FUNCTION "forbid_reparent"('workspaceId');
CREATE TRIGGER "BudgetLine_3_keep" BEFORE UPDATE ON "BudgetLine"
  FOR EACH ROW EXECUTE FUNCTION "forbid_reparent"('engagementId');
CREATE TRIGGER "MonthlyReport_3_keep" BEFORE UPDATE ON "MonthlyReport"
  FOR EACH ROW EXECUTE FUNCTION "forbid_reparent"('engagementId');
CREATE TRIGGER "Expense_3_keep" BEFORE UPDATE ON "Expense"
  FOR EACH ROW EXECUTE FUNCTION "forbid_reparent"('engagementId', 'monthlyReportId');
CREATE TRIGGER "Document_3_keep" BEFORE UPDATE ON "Document"
  FOR EACH ROW EXECUTE FUNCTION "forbid_reparent"('workspaceId');
CREATE TRIGGER "Suggestion_3_keep" BEFORE UPDATE ON "Suggestion"
  FOR EACH ROW EXECUTE FUNCTION "forbid_reparent"('workspaceId', 'userId');
CREATE TRIGGER "Participant_3_keep" BEFORE UPDATE ON "Participant"
  FOR EACH ROW EXECUTE FUNCTION "forbid_reparent"('engagementId');
CREATE TRIGGER "WexPayment_3_keep" BEFORE UPDATE ON "WexPayment"
  FOR EACH ROW EXECUTE FUNCTION "forbid_reparent"('monthlyReportId', 'participantId');
CREATE TRIGGER "Check_3_keep" BEFORE UPDATE ON "Check"
  FOR EACH ROW EXECUTE FUNCTION "forbid_reparent"('monthlyReportId', 'expenseId', 'wexPaymentId');

-- With the triggers in place, no row can exist without its workspace.
ALTER TABLE "BudgetLine"          ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "MonthlyReport"       ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "Expense"             ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "ExpenseDocument"     ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "Participant"         ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "ParticipantDocument" ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "WexPayment"          ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "WexPaymentDocument"  ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "Check"               ALTER COLUMN "workspaceId" SET NOT NULL;

-- Trigger functions run when a row is written, whoever writes it; nobody calls them directly.
REVOKE ALL ON FUNCTION "set_tenant_from_parent"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "document_engagement_workspace"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "document_same_workspace"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "forbid_reparent"() FROM PUBLIC;

-- ── Policies ─────────────────────────────────────────────────────────────────
-- The context functions are wrapped in (SELECT ...) so Postgres evaluates them once per statement, not once
-- per row. One set of policies per table: read, insert, update, delete, each with its own condition:
--   member    the row's workspace is one the caller belongs to
--   owner     the row's workspace is one the caller owns
--   none      nobody through the API
-- Being able to see a row never means being able to change it; what a bookkeeper may change and an auditor
-- may only read is the application's rule (roles inside the workspace), not the database's.

CREATE FUNCTION "tenant_cond"(mode TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE mode
    WHEN 'member' THEN '"workspaceId" = ANY ((SELECT "app_workspace_ids"())::TEXT[])'
    WHEN 'owner'  THEN '"workspaceId" = ANY ((SELECT "app_owned_workspace_ids"())::TEXT[])'
    WHEN 'none'   THEN 'false'
    ELSE mode
  END
$$;

CREATE FUNCTION "create_tenant_policies"(tbl TEXT, r TEXT, i TEXT, u TEXT, d TEXT) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('CREATE POLICY "tenant_read" ON %I FOR SELECT USING (%s)', tbl, "tenant_cond"(r));
  EXECUTE format('CREATE POLICY "tenant_insert" ON %I FOR INSERT WITH CHECK (%s)', tbl, "tenant_cond"(i));
  EXECUTE format('CREATE POLICY "tenant_update" ON %I FOR UPDATE USING (%s) WITH CHECK (%s)', tbl, "tenant_cond"(u), "tenant_cond"(u));
  EXECUTE format('CREATE POLICY "tenant_delete" ON %I FOR DELETE USING (%s)', tbl, "tenant_cond"(d));
END $$;

-- A workspace is visible to its members; any signed-in person may create one (the API then makes them its
-- owner as trusted work); owners edit it; the API deletes none.
SELECT "create_tenant_policies"('Workspace',
  '"id" = ANY ((SELECT "app_workspace_ids"())::TEXT[])',
  '(SELECT "app_user_id"()) IS NOT NULL',
  '"id" = ANY ((SELECT "app_owned_workspace_ids"())::TEXT[])',
  'none');

-- People see themselves and the people who work beside them; they write only their own row (an invited
-- person's placeholder row is written as trusted work).
SELECT "create_tenant_policies"('User',
  '"id" = ANY ((SELECT "app_visible_user_ids"())::TEXT[])',
  '"id" = (SELECT "app_user_id"())',
  '"id" = (SELECT "app_user_id"())',
  'none');

-- A membership is an invitation. Members see who works beside them; only an owner gives, changes or takes
-- one away, and only in a workspace they own. A person with no membership can give none, so nobody invites
-- themselves (the creator of a workspace is made its owner as trusted work; scripts do it for a first user).
SELECT "create_tenant_policies"('Membership',
  '("workspaceId" = ANY ((SELECT "app_workspace_ids"())::TEXT[]) OR "userId" = (SELECT "app_user_id"()))',
  'owner', 'owner', 'owner');

-- Everything the workspace accounts for is its members' to read and write; who may submit, record a decision
-- or open a personal document is the application's rule.
SELECT "create_tenant_policies"('Engagement',          'member', 'member', 'member', 'member');
SELECT "create_tenant_policies"('BudgetLine',          'member', 'member', 'member', 'member');
SELECT "create_tenant_policies"('MonthlyReport',       'member', 'member', 'member', 'member');
SELECT "create_tenant_policies"('Expense',             'member', 'member', 'member', 'member');
SELECT "create_tenant_policies"('Document',            'member', 'member', 'member', 'member');
SELECT "create_tenant_policies"('ExpenseDocument',     'member', 'member', 'member', 'member');
SELECT "create_tenant_policies"('Participant',         'member', 'member', 'member', 'member');
SELECT "create_tenant_policies"('ParticipantDocument', 'member', 'member', 'member', 'member');
SELECT "create_tenant_policies"('WexPayment',          'member', 'member', 'member', 'member');
SELECT "create_tenant_policies"('WexPaymentDocument',  'member', 'member', 'member', 'member');
SELECT "create_tenant_policies"('Check',               'member', 'member', 'member', 'member');

-- The access log is written by whoever acts, in their own workspace; read inside the workspace (the owner and
-- the auditor want it); never changed or removed through the API.
SELECT "create_tenant_policies"('DataAccessLog', 'member', 'member', 'none', 'none');

-- A suggestion is written by a member in their own workspace and read there; never changed or removed.
SELECT "create_tenant_policies"('Suggestion', 'member', 'member', 'none', 'none');

DROP FUNCTION "create_tenant_policies"(TEXT, TEXT, TEXT, TEXT, TEXT);
DROP FUNCTION "tenant_cond"(TEXT);
