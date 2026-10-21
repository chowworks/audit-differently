-- The pay the payroll match proves is the engagement's payroll on its budget (owner's decision, 2026-10-20, #22): staff
-- pay and its employer taxes and benefits from payroll details, and the participants' pay from their pay stubs. Each
-- engagement says once, on its budget lines, which line holds each.

-- 1. What payroll each budget line holds: staff pay, staff taxes and benefits, participant pay, participant taxes. One
-- line of an engagement holds each kind; the API moves a kind when another line takes it.
ALTER TABLE "BudgetLine" ADD COLUMN "payroll" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "BudgetLine" ADD CONSTRAINT "BudgetLine_payroll_check" CHECK (
  "payroll" <@ ARRAY['staff-pay', 'staff-taxes', 'participant-pay', 'participant-taxes']::TEXT[]
);

-- Today's lines take the kinds their report line names, the first such line of each engagement:
-- Staff Salaries holds staff pay, Staff Fringe its taxes (else the staff pay line), WEX or Participant Wages the
-- participants' pay, Participant Fringes their taxes (else the participants' pay line, as the team's books keep it).
UPDATE "BudgetLine" b SET "payroll" = b."payroll" || 'staff-pay'::TEXT
WHERE b."id" IN (
  SELECT DISTINCT ON (x."engagementId") x."id" FROM "BudgetLine" x
  WHERE x."reportLine" = ANY (ARRAY['staff-salaries'])
  ORDER BY x."engagementId", array_position(ARRAY['staff-salaries'], x."reportLine"), x."sortOrder", x."id"
);
UPDATE "BudgetLine" b SET "payroll" = b."payroll" || 'staff-taxes'::TEXT
WHERE b."id" IN (
  SELECT DISTINCT ON (x."engagementId") x."id" FROM "BudgetLine" x
  WHERE x."reportLine" = ANY (ARRAY['staff-fringe', 'staff-salaries'])
  ORDER BY x."engagementId", array_position(ARRAY['staff-fringe', 'staff-salaries'], x."reportLine"), x."sortOrder", x."id"
);
UPDATE "BudgetLine" b SET "payroll" = b."payroll" || 'participant-pay'::TEXT
WHERE b."id" IN (
  SELECT DISTINCT ON (x."engagementId") x."id" FROM "BudgetLine" x
  WHERE x."reportLine" = ANY (ARRAY['wex', 'participant-wages'])
  ORDER BY x."engagementId", array_position(ARRAY['wex', 'participant-wages'], x."reportLine"), x."sortOrder", x."id"
);
UPDATE "BudgetLine" b SET "payroll" = b."payroll" || 'participant-taxes'::TEXT
WHERE b."id" IN (
  SELECT DISTINCT ON (x."engagementId") x."id" FROM "BudgetLine" x
  WHERE x."reportLine" = ANY (ARRAY['participant-fringes', 'wex', 'participant-wages'])
  ORDER BY x."engagementId", array_position(ARRAY['participant-fringes', 'wex', 'participant-wages'], x."reportLine"), x."sortOrder", x."id"
);

-- 2. The lines Save writes from the payroll match carry their key (whose pay, which run, pay or taxes), so saving
-- again replaces them and never adds a second; a person's or an import's own line has none.
ALTER TABLE "Expense" ADD COLUMN "payrollKey" TEXT;
CREATE UNIQUE INDEX "Expense_monthlyReportId_payrollKey_key" ON "Expense"("monthlyReportId", "payrollKey");
