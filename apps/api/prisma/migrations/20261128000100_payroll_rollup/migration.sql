-- The payroll budget rollup (#138, owner's decisions, 2026-11-27): which budget line holds each kind of payroll from
-- the match (staff pay, staff taxes, participant pay, participant taxes) is a list on the workspace, by the line's NAME,
-- with an engagement's own override, kept in "LineAlias" as the list 'payroll'. A row's name is the kind
-- (PAYROLL_BUDGET_KINDS); its budgetLineName the line, or "unallowable" for "Not on the budget". BudgetLine.payroll stays, now
-- written only from this list (PayrollRollupService), so every reader keeps reading it.
--
-- Filled once from today's ticks, add-only, so every engagement's lines hold exactly what they hold now: for each
-- kind of each workspace with an engagement, the line name most engagements tick is the workspace's entry (ties: the
-- name first in order), or "Not on the budget" when none ticks it; an engagement whose tick differs gets its own entry:
-- the line it ticks, or "Not on the budget" when it has a line of the workspace's name but ticks none. Line names
-- compare case aside, punctuation kept (lineKey). A workspace with no entry for a kind (a new one) puts it on each
-- engagement's line of its report line, as a new line took it before (payrollDefaults).

ALTER TABLE "LineAlias" DROP CONSTRAINT "LineAlias_list_check";
ALTER TABLE "LineAlias" ADD CONSTRAINT "LineAlias_list_check" CHECK ("list" IN ('quickbooks', 'payroll'));

CREATE TEMP TABLE "_held" AS
SELECT e."workspaceId", b."engagementId", k AS "kind", b."name", lower(btrim(b."name")) AS "lk"
FROM "BudgetLine" b JOIN "Engagement" e ON e."id" = b."engagementId", unnest(b."payroll") k
WHERE k IN ('staff-pay', 'staff-taxes', 'participant-pay', 'participant-taxes');

CREATE TEMP TABLE "_ws" AS
SELECT k."workspaceId", k."kind", top."name", top."lk"
FROM (
  SELECT DISTINCT e."workspaceId", t."kind"
  FROM "Engagement" e,
    unnest(ARRAY['staff-pay', 'staff-taxes', 'participant-pay', 'participant-taxes']) AS t("kind")
) k
LEFT JOIN LATERAL (
  SELECT min(h."name") AS "name", h."lk"
  FROM "_held" h WHERE h."workspaceId" = k."workspaceId" AND h."kind" = k."kind"
  GROUP BY h."lk" ORDER BY count(*) DESC, h."lk" LIMIT 1
) top ON true;

INSERT INTO "LineAlias" ("id", "workspaceId", "engagementId", "list", "name", "key", "budgetLineName", "unallowable", "changedById")
SELECT gen_random_uuid()::TEXT, w."workspaceId", NULL, 'payroll', w."kind", replace(w."kind", '-', ' '), w."name",
  w."name" IS NULL, 'migration'
FROM "_ws" w
ON CONFLICT DO NOTHING;

-- An engagement's own entry wherever the workspace's would put the kind elsewhere than it is today.
INSERT INTO "LineAlias" ("id", "workspaceId", "engagementId", "list", "name", "key", "budgetLineName", "unallowable", "changedById")
SELECT gen_random_uuid()::TEXT, w."workspaceId", e."id", 'payroll', w."kind", replace(w."kind", '-', ' '), h."name",
  h."name" IS NULL,
  'migration'
FROM "_ws" w
JOIN "Engagement" e ON e."workspaceId" = w."workspaceId"
LEFT JOIN "_held" h ON h."engagementId" = e."id" AND h."kind" = w."kind"
WHERE (h."lk" IS NOT NULL AND h."lk" IS DISTINCT FROM w."lk")
   OR (h."lk" IS NULL AND EXISTS (
        SELECT 1 FROM "BudgetLine" b WHERE b."engagementId" = e."id" AND lower(btrim(b."name")) = w."lk"))
ON CONFLICT DO NOTHING;

DROP TABLE "_held";
DROP TABLE "_ws";
