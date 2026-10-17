-- The workspace's list of budget items is gone: each engagement keeps its own budget lines, named as its contract
-- names them (migration 20261017000200). The list, its check, and the item a budget line was made from go.

-- The platform admin still changes only a workspace's name and lists (now its tags), as before.
CREATE OR REPLACE FUNCTION "workspace_admin_lists_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF "app_is_admin"() AND NOT (OLD."id" = ANY ("app_owned_workspace_ids"()))
     AND (to_jsonb(NEW) - 'name' - 'tagTypes' - 'receiptsAddress' - 'updatedAt')
         IS DISTINCT FROM (to_jsonb(OLD) - 'name' - 'tagTypes' - 'receiptsAddress' - 'updatedAt') THEN
    RAISE EXCEPTION 'The platform admin changes only the name and lists of a workspace' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

ALTER TABLE "Workspace" DROP CONSTRAINT "Workspace_budgetItems_check";
ALTER TABLE "Workspace" DROP COLUMN "budgetItems";

DROP INDEX "BudgetLine_engagementId_category_key";
ALTER TABLE "BudgetLine" DROP COLUMN "category";
