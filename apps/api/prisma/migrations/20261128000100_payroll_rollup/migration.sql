-- Payroll budget line items (#138, owner's decisions, 2026-11-27): which budget line holds each kind of payroll from
-- the match (staff pay, staff taxes, participant pay, participant taxes), kept in "LineAlias" as the list 'payroll'. A
-- row's name is the kind (PAYROLL_BUDGET_KINDS). The workspace's rows list the line NAMES that hold the kind (several,
-- no order; key '<kind>|<name as lines compare>'), or one row "Not on the budget" (unallowable, key '<kind>'); an
-- engagement's own row (key '<kind>') names one of its lines or Not on the budget, and wins (payrollPlace in
-- packages/types). BudgetLine.payroll stays, now written only from this list, so every reader keeps reading it.
--
-- Filled once from today's ticks, add-only, so every engagement's pay lands exactly where it lands now: for each kind of
-- each workspace with an engagement, the workspace lists every line name ticked for it (or Not on the budget when none
-- is), and an engagement gets its own row wherever the list alone would not give it today's line: the line it ticks,
-- or Not on the budget. Line names compare case aside, punctuation kept (lineKey).

ALTER TABLE "LineAlias" DROP CONSTRAINT "LineAlias_list_check";
ALTER TABLE "LineAlias" ADD CONSTRAINT "LineAlias_list_check" CHECK ("list" IN ('quickbooks', 'payroll'));

CREATE TEMP TABLE "_held" AS
SELECT DISTINCT ON (b."engagementId", k)
  e."workspaceId", b."engagementId", k AS "kind", b."name", lower(btrim(b."name")) AS "lk"
FROM "BudgetLine" b JOIN "Engagement" e ON e."id" = b."engagementId", unnest(b."payroll") k
WHERE k IN ('staff-pay', 'staff-taxes', 'participant-pay', 'participant-taxes')
ORDER BY b."engagementId", k, b."sortOrder", b."id";

-- Every ticked name per kind of each workspace with an engagement; a null name where none is ticked.
CREATE TEMP TABLE "_ws" AS
SELECT k."workspaceId", k."kind", n."name", n."lk"
FROM (
  SELECT DISTINCT e."workspaceId", t."kind"
  FROM "Engagement" e,
    unnest(ARRAY['staff-pay', 'staff-taxes', 'participant-pay', 'participant-taxes']) AS t("kind")
) k
LEFT JOIN LATERAL (
  SELECT min(h."name") AS "name", h."lk"
  FROM "_held" h WHERE h."workspaceId" = k."workspaceId" AND h."kind" = k."kind"
  GROUP BY h."lk"
) n ON true;

INSERT INTO "LineAlias" ("id", "workspaceId", "engagementId", "list", "name", "key", "budgetLineName", "unallowable", "changedById")
SELECT gen_random_uuid()::TEXT, w."workspaceId", NULL, 'payroll', w."kind",
  CASE WHEN w."lk" IS NULL THEN w."kind" ELSE w."kind" || '|' || w."lk" END,
  w."name", w."name" IS NULL, 'migration'
FROM "_ws" w
ON CONFLICT DO NOTHING;

-- An engagement's own row unless the list alone gives today's line: Not on the budget for every engagement, or exactly
-- one of its lines listed and that one ticked.
INSERT INTO "LineAlias" ("id", "workspaceId", "engagementId", "list", "name", "key", "budgetLineName", "unallowable", "changedById")
SELECT gen_random_uuid()::TEXT, e."workspaceId", e."id", 'payroll', k."kind", k."kind", h."name", h."name" IS NULL,
  'migration'
FROM "Engagement" e
JOIN (SELECT DISTINCT "workspaceId", "kind" FROM "_ws") k ON k."workspaceId" = e."workspaceId"
LEFT JOIN "_held" h ON h."engagementId" = e."id" AND h."kind" = k."kind"
LEFT JOIN LATERAL (
  SELECT count(*) AS "n", min(lower(btrim(b."name"))) AS "lk"
  FROM "BudgetLine" b
  WHERE b."engagementId" = e."id"
    AND lower(btrim(b."name")) IN (
      SELECT w."lk" FROM "_ws" w WHERE w."workspaceId" = e."workspaceId" AND w."kind" = k."kind")
) hits ON true
WHERE NOT (
  -- Not on the budget for every engagement (nothing ticked anywhere), and nothing ticked here.
  (h."lk" IS NULL AND NOT EXISTS (
    SELECT 1 FROM "_ws" w WHERE w."workspaceId" = e."workspaceId" AND w."kind" = k."kind" AND w."lk" IS NOT NULL))
  -- Exactly one listed line, the one ticked.
  OR (h."lk" IS NOT NULL AND hits."n" = 1 AND hits."lk" = h."lk")
)
ON CONFLICT DO NOTHING;

DROP TABLE "_held";
DROP TABLE "_ws";
