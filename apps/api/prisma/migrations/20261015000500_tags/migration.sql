-- Tags (packages/types, "Tags"). A workspace's owners keep their own tag types: each a stable key that survives a
-- rename, a label, the records it applies to ('expense', 'payroll', 'participant') and its values, each a stable key
-- and a label. The built-in type "Funding source" is not stored here: its values are "fundingSources", the one list.
ALTER TABLE "Workspace" ADD COLUMN "tagTypes" JSONB NOT NULL DEFAULT '[]'::JSONB;
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_tagTypes_check" CHECK (jsonb_typeof("tagTypes") = 'array');

-- The tags applied to a record, each `<type key>:<value key>`, checked against the workspace's list by the API on
-- every write. A value removed from the list later stays on the records that have it.
ALTER TABLE "Expense" ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "WexPayment" ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "Participant" ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT '{}';

-- The platform admin keeps the tag types too, like the other lists (migration 20261015000400): in a workspace it does
-- not own, the admin changes the name and the lists (and Prisma's updatedAt) and nothing else.
CREATE OR REPLACE FUNCTION "workspace_admin_lists_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF "app_is_admin"() AND NOT (OLD."id" = ANY ("app_owned_workspace_ids"()))
     AND (to_jsonb(NEW) - 'name' - 'fundingSources' - 'budgetItems' - 'tagTypes' - 'updatedAt')
         IS DISTINCT FROM (to_jsonb(OLD) - 'name' - 'fundingSources' - 'budgetItems' - 'tagTypes' - 'updatedAt') THEN
    RAISE EXCEPTION 'The platform admin changes only the name and lists of a workspace' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION "workspace_admin_lists_only"() FROM PUBLIC;
