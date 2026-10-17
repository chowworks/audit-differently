-- Spending is tracked against the engagement's own budget lines, as the contract's approved budget has them: the
-- auditor compares actual spending to that budget line by line. A budget line has its own name (until now it was a
-- workspace budget item's key, `category`); every expense belongs to one of its engagement's lines, and the line says
-- which line of the funder's monthly form it rolls up to, so an expense's `reportLine` follows its budget line.

-- 1. A budget line names itself: today's lines take the label of the workspace item they were made from.
ALTER TABLE "BudgetLine" ADD COLUMN "name" TEXT;
UPDATE "BudgetLine" b SET "name" = COALESCE(
  (SELECT i->>'label' FROM "Workspace" w, jsonb_array_elements(w."budgetItems") i
    WHERE w."id" = b."workspaceId" AND i->>'key' = b."category" LIMIT 1),
  b."category");
ALTER TABLE "BudgetLine" ALTER COLUMN "name" SET NOT NULL;
ALTER TABLE "BudgetLine" ADD CONSTRAINT "BudgetLine_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 120);
CREATE UNIQUE INDEX "BudgetLine_engagementId_name_key" ON "BudgetLine"("engagementId", lower(btrim("name")));
-- The workspace item it came from, for lines made before this; a new line has none.
ALTER TABLE "BudgetLine" ALTER COLUMN "category" DROP NOT NULL;

-- 2. An expense belongs to one budget line of its own engagement. NO ACTION (checked at the end of the statement) so
-- deleting an engagement or a month, which takes its lines and expenses together, still goes through; the API refuses
-- to remove a line that has spending.
ALTER TABLE "Expense" ADD COLUMN "budgetLineId" TEXT;
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_budgetLineId_fkey"
  FOREIGN KEY ("budgetLineId") REFERENCES "BudgetLine"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
CREATE INDEX "Expense_budgetLineId_idx" ON "Expense"("budgetLineId");

-- An expense's budget line is one of its own engagement's, and its form line is that budget line's.
CREATE FUNCTION "expense_budget_line"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE line RECORD;
BEGIN
  IF NEW."budgetLineId" IS NULL THEN RETURN NEW; END IF;
  SELECT "engagementId", "reportLine" INTO line FROM "BudgetLine" WHERE "id" = NEW."budgetLineId";
  IF NOT FOUND OR line."engagementId" IS DISTINCT FROM NEW."engagementId" THEN
    RAISE EXCEPTION 'An expense''s budget line is one of its own engagement''s' USING ERRCODE = '23514';
  END IF;
  NEW."reportLine" := line."reportLine";
  RETURN NEW;
END $$;
CREATE TRIGGER "Expense_4_budget_line" BEFORE INSERT OR UPDATE ON "Expense"
  FOR EACH ROW EXECUTE FUNCTION "expense_budget_line"();
REVOKE ALL ON FUNCTION "expense_budget_line"() FROM PUBLIC;

-- A budget line with spending keeps its form line: moving it would move every expense on it, closed months included.
CREATE FUNCTION "budget_line_report_line_kept"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."reportLine" IS DISTINCT FROM OLD."reportLine"
     AND EXISTS (SELECT 1 FROM "Expense" WHERE "budgetLineId" = OLD."id") THEN
    RAISE EXCEPTION 'A budget line with spending keeps the report line it rolls up to' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "BudgetLine_4_report_line_kept" BEFORE UPDATE ON "BudgetLine"
  FOR EACH ROW EXECUTE FUNCTION "budget_line_report_line_kept"();
REVOKE ALL ON FUNCTION "budget_line_report_line_kept"() FROM PUBLIC;

-- 3. Existing expenses take the one budget line of their engagement that rolls up to their form line; where several
-- do (or none), the expense waits for a person to choose (the check "needs a budget line"). This is a correction of
-- every month, closed and submitted ones included, so the month lock is set aside for this statement only.
ALTER TABLE "Expense" DISABLE TRIGGER "Expense_5_month_draft";
UPDATE "Expense" e SET "budgetLineId" = (
  SELECT b."id" FROM "BudgetLine" b WHERE b."engagementId" = e."engagementId" AND b."reportLine" = e."reportLine")
WHERE (SELECT count(*) FROM "BudgetLine" b
        WHERE b."engagementId" = e."engagementId" AND b."reportLine" = e."reportLine") = 1;
ALTER TABLE "Expense" ENABLE TRIGGER "Expense_5_month_draft";
