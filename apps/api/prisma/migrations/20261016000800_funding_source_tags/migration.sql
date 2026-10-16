-- Funding source becomes an ordinary tag type (packages/types, "Tags"). Until now a workspace's sources of funds were
-- their own list ("Workspace"."fundingSources"), shown as a built-in tag type whose values were keyed by their words
-- (`funding-source:Youth Workforce Fund`), and an engagement ticked them in its own column. From here on they are a
-- tag type in "Workspace"."tagTypes" like any other, keyed `funding-source`, with stable value keys, and an engagement
-- holds them as tags. The data so far is the fictional seed, so the conversion is plain.

-- 1. Each workspace's sources of funds, with the key each becomes: its words in lowercase and hyphens, then its place.
CREATE TEMP TABLE "funding_source_keys" AS
SELECT w."id" AS "workspaceId",
       s."label",
       s."ord",
       COALESCE(NULLIF(left(trim(both '-' FROM regexp_replace(lower(s."label"), '[^a-z0-9]+', '-', 'g')), 40), ''),
                'source') || '-' || s."ord" AS "key"
FROM "Workspace" w,
     unnest(w."fundingSources") WITH ORDINALITY AS s("label", "ord")
WHERE trim(s."label") <> '';

-- 2. They become the first tag type of the workspace, applying to engagements and to every kind of record.
UPDATE "Workspace" w
SET "tagTypes" = jsonb_build_array(jsonb_build_object(
      'key', 'funding-source',
      'label', 'Funding source',
      'appliesTo', '["engagement", "expense", "payroll", "participant"]'::jsonb,
      'values', (SELECT jsonb_agg(jsonb_build_object('key', k."key", 'label', k."label") ORDER BY k."ord")
                 FROM "funding_source_keys" k WHERE k."workspaceId" = w."id")
    )) || w."tagTypes"
WHERE EXISTS (SELECT 1 FROM "funding_source_keys" k WHERE k."workspaceId" = w."id");

-- 3. A record's `funding-source:<words>` tag becomes `funding-source:<value key>`; one whose words are not in the list
-- is dropped. A closed or submitted month's expenses and payroll items change too (the conversion is not a change of
-- the ledger), so the month lock is off for this one statement each.
ALTER TABLE "Expense" DISABLE TRIGGER "Expense_5_month_draft";
ALTER TABLE "WexPayment" DISABLE TRIGGER "WexPayment_5_month_draft";

UPDATE "Expense" r SET "tags" = ARRAY(
  SELECT COALESCE('funding-source:' || k."key", u."t")
  FROM unnest(r."tags") WITH ORDINALITY AS u("t", "ord")
  LEFT JOIN "funding_source_keys" k ON k."workspaceId" = r."workspaceId" AND u."t" = 'funding-source:' || k."label"
  WHERE u."t" NOT LIKE 'funding-source:%' OR k."key" IS NOT NULL
  ORDER BY u."ord")
WHERE EXISTS (SELECT 1 FROM unnest(r."tags") t WHERE t LIKE 'funding-source:%');

UPDATE "WexPayment" r SET "tags" = ARRAY(
  SELECT COALESCE('funding-source:' || k."key", u."t")
  FROM unnest(r."tags") WITH ORDINALITY AS u("t", "ord")
  LEFT JOIN "funding_source_keys" k ON k."workspaceId" = r."workspaceId" AND u."t" = 'funding-source:' || k."label"
  WHERE u."t" NOT LIKE 'funding-source:%' OR k."key" IS NOT NULL
  ORDER BY u."ord")
WHERE EXISTS (SELECT 1 FROM unnest(r."tags") t WHERE t LIKE 'funding-source:%');

UPDATE "Participant" r SET "tags" = ARRAY(
  SELECT COALESCE('funding-source:' || k."key", u."t")
  FROM unnest(r."tags") WITH ORDINALITY AS u("t", "ord")
  LEFT JOIN "funding_source_keys" k ON k."workspaceId" = r."workspaceId" AND u."t" = 'funding-source:' || k."label"
  WHERE u."t" NOT LIKE 'funding-source:%' OR k."key" IS NOT NULL
  ORDER BY u."ord")
WHERE EXISTS (SELECT 1 FROM unnest(r."tags") t WHERE t LIKE 'funding-source:%');

ALTER TABLE "Expense" ENABLE TRIGGER "Expense_5_month_draft";
ALTER TABLE "WexPayment" ENABLE TRIGGER "WexPayment_5_month_draft";

-- 4. An engagement holds tags like the other records (`<type key>:<value key>`, of the types that apply to
-- engagements), checked against the workspace's list by the API on every write. Its ticked sources become tags.
ALTER TABLE "Engagement" ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT '{}';

UPDATE "Engagement" e SET "tags" = ARRAY(
  SELECT 'funding-source:' || k."key"
  FROM "funding_source_keys" k
  WHERE k."workspaceId" = e."workspaceId" AND k."label" = ANY (e."fundingSources")
  ORDER BY k."ord")
WHERE cardinality(e."fundingSources") > 0;

ALTER TABLE "Engagement" DROP COLUMN "fundingSources";

-- 5. The platform admin keeps the lists as before (migration 20261015001000), now without the sources of funds: in a
-- workspace it does not own, the admin changes the name, the budget items, the tag types and the receipts address
-- (and Prisma's updatedAt) and nothing else.
CREATE OR REPLACE FUNCTION "workspace_admin_lists_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF "app_is_admin"() AND NOT (OLD."id" = ANY ("app_owned_workspace_ids"()))
     AND (to_jsonb(NEW) - 'name' - 'budgetItems' - 'tagTypes' - 'receiptsAddress' - 'updatedAt')
         IS DISTINCT FROM (to_jsonb(OLD) - 'name' - 'budgetItems' - 'tagTypes' - 'receiptsAddress' - 'updatedAt') THEN
    RAISE EXCEPTION 'The platform admin changes only the name and lists of a workspace' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION "workspace_admin_lists_only"() FROM PUBLIC;

ALTER TABLE "Workspace" DROP COLUMN "fundingSources";

DROP TABLE "funding_source_keys";
