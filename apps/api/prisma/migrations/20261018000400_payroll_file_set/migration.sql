-- One set of payroll files per workspace month (GitHub issue #22; owner's decision, 2026-10-18). The month's workspace
-- payroll files (documents filed to no engagement, for the period) are its set, and matching always comes from the whole
-- set. The owner changes it by a run (PayrollMatchRun) of one kind: replace all (the uploaded zip becomes the set), add
-- files, remove a file, or match again with the set as it is. Saving a run matches the month again from the full set and
-- writes the difference: proof links added and removed, payments from pay stubs made, changed or removed, and the staff
-- proofs rewritten. An owner's decisions on a file (a proof linked by hand, a pay marked not grant-funded) are kept while
-- that file stays as it was (its name and contents); when it changes or leaves, the decision goes and is recorded here.

-- 1. What a workspace run changes. `setDocumentIds`: the set when the run started, so a save made after someone else
-- changed the set is refused. `expectedFiles`: replace all only, how many different files the zip holds, so a save
-- before every file arrived is refused rather than removing the rest. A month's run keeps none of these.
ALTER TABLE "PayrollMatchRun" ADD COLUMN "mode" TEXT;
ALTER TABLE "PayrollMatchRun" ADD COLUMN "expectedFiles" INTEGER;
ALTER TABLE "PayrollMatchRun" ADD COLUMN "setDocumentIds" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "PayrollMatchRun" ADD CONSTRAINT "PayrollMatchRun_mode_check" CHECK (
  ("monthlyReportId" IS NOT NULL AND "mode" IS NULL AND "expectedFiles" IS NULL AND cardinality("setDocumentIds") = 0)
  OR ("monthlyReportId" IS NULL
      AND ("mode" IS NULL OR "mode" IN ('replace', 'add', 'remove', 'match'))
      AND ("expectedFiles" IS NULL OR ("mode" = 'replace' AND "expectedFiles" BETWEEN 1 AND 1000))
      AND cardinality("setDocumentIds") <= 1000));

-- 2. A proof link the workspace match made, as against one a person made (an owner's link by hand or a confirmed guess,
-- a bookkeeper's attachment). Matching again adds, changes and removes only the match's own; a person's link stays
-- while its file stays as it was.
ALTER TABLE "ExpenseDocument" ADD COLUMN "byMatch" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "WexPaymentDocument" ADD COLUMN "byMatch" BOOLEAN NOT NULL DEFAULT false;

-- 3. An owner's decision dropped because the file it was made on changed or left the month's set, for the
-- reconciliation to say so. It names its workspace itself (it outlives the file); append-only, it goes with the
-- workspace. The file name and the item's title can carry a person's name, as the reconciliation shows them: owners and
-- auditors read it, owners write it in their own name, a bookkeeper and the platform admin see none of it.
CREATE TABLE "PayrollDroppedDecision" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "why" TEXT NOT NULL,
    "itemTitle" TEXT,
    "engagementName" TEXT,
    "droppedById" TEXT NOT NULL,
    "droppedByEmail" TEXT NOT NULL,
    "droppedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PayrollDroppedDecision_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PayrollDroppedDecision_period_check" CHECK ("period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
    CONSTRAINT "PayrollDroppedDecision_kind_check" CHECK (
      "kind" IN ('timesheet', 'payroll-register', 'paystub', 'bank-statement')),
    CONSTRAINT "PayrollDroppedDecision_decision_check" CHECK ("decision" IN ('linked', 'not-funded')),
    CONSTRAINT "PayrollDroppedDecision_why_check" CHECK ("why" IN ('changed', 'left')),
    CONSTRAINT "PayrollDroppedDecision_text_check" CHECK (
      char_length("fileName") BETWEEN 1 AND 200
      AND ("itemTitle" IS NULL OR char_length("itemTitle") <= 300)
      AND ("engagementName" IS NULL OR char_length("engagementName") <= 200)
      AND ("decision" = 'linked' OR "itemTitle" IS NULL))
);
CREATE INDEX "PayrollDroppedDecision_workspaceId_period_idx" ON "PayrollDroppedDecision"("workspaceId", "period");
ALTER TABLE "PayrollDroppedDecision" ADD CONSTRAINT "PayrollDroppedDecision_workspaceId_fkey" FOREIGN KEY ("workspaceId")
  REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE FUNCTION "payroll_dropped_decision_kept"() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'A dropped decision is kept as it was recorded' USING ERRCODE = '23514';
END $$;
REVOKE ALL ON FUNCTION "payroll_dropped_decision_kept"() FROM PUBLIC;
CREATE TRIGGER "PayrollDroppedDecision_3_keep" BEFORE UPDATE ON "PayrollDroppedDecision"
  FOR EACH ROW EXECUTE FUNCTION "payroll_dropped_decision_kept"();

ALTER TABLE "PayrollDroppedDecision" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_read" ON "PayrollDroppedDecision" FOR SELECT
  USING ("workspaceId" = ANY ((SELECT "app_staff_workspace_ids"())::TEXT[]));
CREATE POLICY "tenant_insert" ON "PayrollDroppedDecision" FOR INSERT
  WITH CHECK ("workspaceId" = ANY ((SELECT "app_owned_workspace_ids"())::TEXT[])
    AND "droppedById" = (SELECT "app_user_id"()));
CREATE POLICY "tenant_update" ON "PayrollDroppedDecision" FOR UPDATE USING (false) WITH CHECK (false);
CREATE POLICY "tenant_delete" ON "PayrollDroppedDecision" FOR DELETE USING (false);
