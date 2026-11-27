-- The QuickBooks names list (#132) filled once from what the two old mappings said, so no workspace starts with an
-- empty list. Add-only: it never changes or removes an entry, and running it again adds nothing. The old columns and
-- the AccountMapping table stay as they are.
--
-- 1. Each saved import mapping's categories (category -> budget line name, or 'skip') become the workspace's entries:
--    a line name that is no line of any of the workspace's engagements is left out (a person answers it on the next
--    import). Where two saved mappings disagree on a category, the older mapping's answer is kept.
-- 2. Each engagement's account mapping (account number -> category, and the owner's picks by category) becomes, per
--    account, the name "<number> <name>" as QuickBooks writes it, going where Month End Close sent it: the owner's pick,
--    else the line the file's side box names, else the line of the box's amount, else the line named as the category;
--    a blank account, or a pick of 'skip', is Unallowable on that engagement. The first engagement (by when its mapping
--    was saved) to name an account gives the workspace's entry; another engagement that sends it elsewhere gets its own.
--
-- Names compare as aliasKey in packages/types does: lower case, every run of other characters one space, trimmed.

CREATE OR REPLACE FUNCTION "pg_temp"."alias_key"(t TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT btrim(regexp_replace(lower(t), '[^[:alnum:]]+', ' ', 'g'))
$$;

-- Every budget line, by workspace and engagement, with its name's key.
CREATE TEMP TABLE "_lines" AS
SELECT e."workspaceId", b."engagementId", b."id", b."name", b."amount", "pg_temp"."alias_key"(b."name") AS "key"
FROM "BudgetLine" b JOIN "Engagement" e ON e."id" = b."engagementId";

-- 1. Saved import mappings.
CREATE TEMP TABLE "_from_imports" AS
SELECT DISTINCT ON (m."workspaceId", "pg_temp"."alias_key"(c.key))
  m."workspaceId",
  btrim(c.key) AS "name",
  "pg_temp"."alias_key"(c.key) AS "key",
  CASE WHEN c.value #>> '{}' = 'skip' THEN NULL
    ELSE (SELECT l."name" FROM "_lines" l WHERE l."workspaceId" = m."workspaceId"
            AND l."key" = "pg_temp"."alias_key"(c.value #>> '{}') ORDER BY l."name" LIMIT 1) END AS "line",
  c.value #>> '{}' = 'skip' AS "unallowable",
  COALESCE(m."createdById", 'migration') AS "by"
FROM "ImportMapping" m, jsonb_each(m."categories") c
WHERE jsonb_typeof(c.value) = 'string' AND "pg_temp"."alias_key"(c.key) <> ''
ORDER BY m."workspaceId", "pg_temp"."alias_key"(c.key), m."createdAt";

INSERT INTO "LineAlias" ("id", "workspaceId", "engagementId", "name", "key", "budgetLineName", "unallowable", "changedById")
SELECT gen_random_uuid()::TEXT, f."workspaceId", NULL, left(f."name", 200), left(f."key", 200), f."line", f."unallowable", f."by"
FROM "_from_imports" f
WHERE f."unallowable" OR f."line" IS NOT NULL
ON CONFLICT DO NOTHING;

-- 2. Account mappings, one row per account of each engagement's file.
CREATE TEMP TABLE "_accounts" AS
SELECT a."workspaceId", a."engagementId", a."changedById" AS "by", a."changedAt" AS "at",
  btrim(acc.key || ' ' || COALESCE(a."read" -> 'names' ->> acc.key, '')) AS "name",
  acc.value #>> '{}' AS "category",
  CASE WHEN jsonb_typeof(a."read" -> 'categories') = 'array' THEN a."read" -> 'categories' ELSE '[]'::JSONB END AS "box",
  CASE WHEN jsonb_typeof(a."chosen") = 'object' THEN a."chosen" ELSE '{}'::JSONB END AS "chosen"
FROM "AccountMapping" a, jsonb_each(a."read" -> 'accounts') acc
WHERE a."engagementId" IS NOT NULL AND jsonb_typeof(a."read" -> 'accounts') = 'object';

CREATE TEMP TABLE "_account_targets" AS
SELECT x.*, "pg_temp"."alias_key"(x."name") AS "key",
  CASE
    WHEN x."category" IS NULL OR btrim(x."category") = '' THEN NULL
    WHEN x."chosen" ->> x."category" = 'skip' THEN NULL
    WHEN x."chosen" ->> x."category" IS NOT NULL THEN
      (SELECT l."name" FROM "_lines" l WHERE l."engagementId" = x."engagementId" AND l."id" = x."chosen" ->> x."category")
    ELSE COALESCE(
      -- the line the side box names, when exactly one line is named so
      (SELECT min(l."name") FROM "_lines" l, jsonb_array_elements(x."box") bx
        WHERE l."engagementId" = x."engagementId"
          AND "pg_temp"."alias_key"(bx ->> 'category') = "pg_temp"."alias_key"(x."category")
          AND l."key" = "pg_temp"."alias_key"(bx ->> 'line')
        HAVING count(*) = 1),
      -- the line of the box's amount, when exactly one line has it
      (SELECT min(l."name") FROM "_lines" l, jsonb_array_elements(x."box") bx
        WHERE l."engagementId" = x."engagementId"
          AND "pg_temp"."alias_key"(bx ->> 'category') = "pg_temp"."alias_key"(x."category")
          AND jsonb_typeof(bx -> 'amount') = 'number'
          AND abs(l."amount" - (bx ->> 'amount')::NUMERIC) < 0.5
        HAVING count(*) = 1),
      -- the line named as the category
      (SELECT min(l."name") FROM "_lines" l
        WHERE l."engagementId" = x."engagementId" AND l."key" = "pg_temp"."alias_key"(x."category")
        HAVING count(*) = 1))
  END AS "line",
  COALESCE(x."category" IS NULL OR btrim(x."category") = '' OR x."chosen" ->> x."category" = 'skip', false)
    AS "unallowable"
FROM "_accounts" x;

-- The workspace's entry: the first engagement to send the account to a line, where the workspace has none yet.
INSERT INTO "LineAlias" ("id", "workspaceId", "engagementId", "name", "key", "budgetLineName", "unallowable", "changedById")
SELECT gen_random_uuid()::TEXT, t."workspaceId", NULL, left(t."name", 200), left(t."key", 200), t."line", false, t."by"
FROM (
  SELECT DISTINCT ON (t."workspaceId", t."key") t.*
  FROM "_account_targets" t
  WHERE t."key" <> '' AND NOT t."unallowable" AND t."line" IS NOT NULL
  ORDER BY t."workspaceId", t."key", t."at"
) t
ON CONFLICT DO NOTHING;

-- An engagement's own entry wherever it says otherwise than the workspace's entry: Unallowable, or another line.
INSERT INTO "LineAlias" ("id", "workspaceId", "engagementId", "name", "key", "budgetLineName", "unallowable", "changedById")
SELECT gen_random_uuid()::TEXT, t."workspaceId", t."engagementId", left(t."name", 200), left(t."key", 200),
  CASE WHEN t."unallowable" THEN NULL ELSE t."line" END, t."unallowable", t."by"
FROM "_account_targets" t
LEFT JOIN "LineAlias" w ON w."workspaceId" = t."workspaceId" AND w."list" = 'quickbooks'
  AND w."engagementId" IS NULL AND w."key" = t."key"
WHERE t."key" <> '' AND (t."unallowable" OR t."line" IS NOT NULL)
  AND (w."id" IS NULL
    OR w."unallowable" <> t."unallowable"
    OR "pg_temp"."alias_key"(COALESCE(w."budgetLineName", '')) <> "pg_temp"."alias_key"(COALESCE(t."line", '')))
ON CONFLICT DO NOTHING;

DROP TABLE "_lines", "_from_imports", "_accounts", "_account_targets";
