-- The budget items a workspace's owners keep (DEFAULT_BUDGET_ITEMS in packages/types): each a stable key that
-- survives a rename, the owners' label, and the monthly-report line it rolls into. An engagement uses an item when it
-- has a BudgetLine whose "category" is the item's key. Every workspace starts with the defaults, existing ones
-- included (ADD COLUMN fills them); their keys are the old budget categories, so existing BudgetLine rows keep
-- working unchanged.
ALTER TABLE "Workspace" ADD COLUMN "budgetItems" JSONB NOT NULL DEFAULT '[
  {"key": "personnel", "label": "Personnel", "reportLine": "staff-salaries"},
  {"key": "fringe", "label": "Fringe Benefits", "reportLine": "staff-fringe"},
  {"key": "travel", "label": "Travel", "reportLine": "program-costs"},
  {"key": "equipment", "label": "Equipment", "reportLine": "program-costs"},
  {"key": "supplies", "label": "Supplies", "reportLine": "program-costs"},
  {"key": "contractual", "label": "Contractual / Subawards", "reportLine": "program-costs"},
  {"key": "participant-training", "label": "Participant / Training Costs", "reportLine": "program-costs"},
  {"key": "other", "label": "Other Costs", "reportLine": "program-costs"},
  {"key": "indirect", "label": "Indirect Costs", "reportLine": "indirect"},
  {"key": "wex", "label": "Work Experience (WEX)", "reportLine": "wex"}
]'::JSONB;
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_budgetItems_check" CHECK (jsonb_typeof("budgetItems") = 'array');

-- The platform admin keeps this list too, like the sources of funds (migration 20261013000200): in a workspace it
-- does not own, the admin changes the name and the lists (and Prisma's updatedAt) and nothing else.
CREATE OR REPLACE FUNCTION "workspace_admin_lists_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF "app_is_admin"() AND NOT (OLD."id" = ANY ("app_owned_workspace_ids"()))
     AND (to_jsonb(NEW) - 'name' - 'fundingSources' - 'budgetItems' - 'updatedAt')
         IS DISTINCT FROM (to_jsonb(OLD) - 'name' - 'fundingSources' - 'budgetItems' - 'updatedAt') THEN
    RAISE EXCEPTION 'The platform admin changes only the name and lists of a workspace' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION "workspace_admin_lists_only"() FROM PUBLIC;
