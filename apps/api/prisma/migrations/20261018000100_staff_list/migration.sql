-- The staff list and engagement staffing (GitHub issue #22; owner's decisions, 2026-10-18). The owner keeps a list of
-- the company's staff (records, not accounts: a name, the employee number as the register prints it, a role) and tags
-- each person to the engagements they work on. The workspace payroll match then links each person's timesheet,
-- register row and bank line to the staff payroll lines of every engagement they are tagged to, and keeps what it
-- found of each person in each file (StaffPayProof) for the engagement cards. No hours, rates or split are kept.
-- Owners change all of it; owners and auditors read it; a bookkeeper reads none of it (theirs is the participant
-- list); the platform admin's mark is admitted nowhere here.

-- The workspaces whose staff list the caller reads: those they own or audit.
CREATE FUNCTION "app_staff_workspace_ids"() RETURNS TEXT[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(array_agg(DISTINCT "workspaceId"), ARRAY[]::TEXT[]) FROM "Membership"
  WHERE "userId" = "app_user_id"() AND "role" IN ('owner', 'auditor') AND "workspaceId" = ANY ("app_workspace_ids"())
$$;
REVOKE ALL ON FUNCTION "app_staff_workspace_ids"() FROM PUBLIC;

-- 1. A person on the staff list. It names its workspace itself, as an engagement does (there is no parent row to take
-- it from); it never moves to another.
CREATE TABLE "StaffMember" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "employeeNumber" TEXT,
    "role" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StaffMember_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StaffMember_name_check" CHECK ("name" = btrim("name") AND char_length("name") BETWEEN 1 AND 120),
    -- As the API's idLike: letters, digits, #, &, ., /, - and spaces.
    CONSTRAINT "StaffMember_employeeNumber_check" CHECK (
      "employeeNumber" IS NULL OR ("employeeNumber" = btrim("employeeNumber") AND "employeeNumber" ~ '^[A-Za-z0-9#&./ -]{1,40}$')),
    CONSTRAINT "StaffMember_role_check" CHECK (
      "role" IS NULL OR ("role" = btrim("role") AND char_length("role") BETWEEN 1 AND 80))
);
-- One person per employee number in a workspace (a person without one is matched by name).
CREATE UNIQUE INDEX "StaffMember_workspaceId_employeeNumber_key" ON "StaffMember"("workspaceId", "employeeNumber");
ALTER TABLE "StaffMember" ADD CONSTRAINT "StaffMember_workspaceId_fkey" FOREIGN KEY ("workspaceId")
  REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE TRIGGER "StaffMember_3_keep" BEFORE UPDATE ON "StaffMember"
  FOR EACH ROW EXECUTE FUNCTION "forbid_reparent"('workspaceId');

-- 2. A person tagged to an engagement they work on. It takes its workspace from the person, and the engagement must be
-- of that workspace (one message for another workspace's engagement and none at all).
CREATE TABLE "StaffAssignment" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "staffMemberId" TEXT NOT NULL,
    "engagementId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StaffAssignment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StaffAssignment_staffMemberId_engagementId_key" ON "StaffAssignment"("staffMemberId", "engagementId");
CREATE INDEX "StaffAssignment_engagementId_idx" ON "StaffAssignment"("engagementId");
CREATE INDEX "StaffAssignment_workspaceId_idx" ON "StaffAssignment"("workspaceId");
ALTER TABLE "StaffAssignment" ADD CONSTRAINT "StaffAssignment_staffMemberId_fkey" FOREIGN KEY ("staffMemberId")
  REFERENCES "StaffMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StaffAssignment" ADD CONSTRAINT "StaffAssignment_engagementId_fkey" FOREIGN KEY ("engagementId")
  REFERENCES "Engagement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A row that hangs off a person on the staff list takes its workspace from them. Read as the caller (not SECURITY
-- DEFINER), so a person of another workspace and no person at all are refused with one message: an owner learns nothing
-- of another workspace's staff from the wording.
CREATE FUNCTION "staff_row_tenant"() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  w TEXT;
BEGIN
  SELECT "workspaceId" INTO w FROM "StaffMember" WHERE "id" = NEW."staffMemberId";
  IF w IS NULL THEN
    RAISE EXCEPTION '% names a person on the staff list of its workspace', TG_TABLE_NAME USING ERRCODE = '23514';
  END IF;
  NEW."workspaceId" := w;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION "staff_row_tenant"() FROM PUBLIC;
CREATE TRIGGER "StaffAssignment_1_set_tenant" BEFORE INSERT OR UPDATE ON "StaffAssignment"
  FOR EACH ROW EXECUTE FUNCTION "staff_row_tenant"();

CREATE FUNCTION "staff_assignment_engagement"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  w TEXT;
BEGIN
  SELECT "workspaceId" INTO w FROM "Engagement" WHERE "id" = NEW."engagementId";
  IF w IS NULL OR w <> NEW."workspaceId" THEN
    RAISE EXCEPTION 'StaffAssignment names an engagement of another workspace' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION "staff_assignment_engagement"() FROM PUBLIC;
CREATE TRIGGER "StaffAssignment_2_engagement" BEFORE INSERT OR UPDATE ON "StaffAssignment"
  FOR EACH ROW EXECUTE FUNCTION "staff_assignment_engagement"();
CREATE TRIGGER "StaffAssignment_3_keep" BEFORE UPDATE ON "StaffAssignment"
  FOR EACH ROW EXECUTE FUNCTION "forbid_reparent"('staffMemberId', 'engagementId', 'workspaceId');

-- 3. What the workspace payroll match found of one person in one saved workspace payroll file: their timesheet, a
-- register row (with this period's gross pay on it) or a bank line (with what it paid). A bank line found by its amount
-- alone, naming nobody, is `guessed`: shown in the reconciliation for the owner to confirm, never counted as proof on the
-- engagement cards. Rewritten each time the period is matched; read for the engagement cards and the reconciliation. A person named here stays on the
-- list (Restrict): the API refuses to remove them first. It goes with its document. Staff pay is personal: logged by
-- field name only.
CREATE TABLE "StaffPayProof" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "staffMemberId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amount" DECIMAL(12,2),
    -- The person's line, { page, x, y, width, height, text } in PDF points; null for a timesheet found by its file name.
    "mark" JSONB,
    "guessed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StaffPayProof_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StaffPayProof_guessed_check" CHECK (NOT "guessed" OR "kind" = 'bank-statement'),
    CONSTRAINT "StaffPayProof_kind_check" CHECK ("kind" IN ('timesheet', 'payroll-register', 'bank-statement')),
    CONSTRAINT "StaffPayProof_period_check" CHECK ("period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
    CONSTRAINT "StaffPayProof_amount_check" CHECK ("amount" IS NULL OR "amount" >= 0),
    -- The numbers are cast only once they are known to be numbers (CASE keeps the order), so a bad box is a check
    -- violation, never a cast error.
    CONSTRAINT "StaffPayProof_mark_check" CHECK ("mark" IS NULL OR (CASE
      WHEN jsonb_typeof("mark") = 'object'
        AND jsonb_typeof("mark" -> 'page') = 'number' AND jsonb_typeof("mark" -> 'x') = 'number'
        AND jsonb_typeof("mark" -> 'y') = 'number' AND jsonb_typeof("mark" -> 'width') = 'number'
        AND jsonb_typeof("mark" -> 'height') = 'number'
        AND (NOT "mark" ? 'text' OR jsonb_typeof("mark" -> 'text') = 'string')
      THEN ("mark" ->> 'page')::numeric >= 1
        AND ("mark" ->> 'page')::numeric = floor(("mark" ->> 'page')::numeric)
        AND ("mark" ->> 'width')::numeric > 0 AND ("mark" ->> 'height')::numeric > 0
        AND (NOT "mark" ? 'text' OR char_length("mark" ->> 'text') <= 300)
      ELSE false END))
);
CREATE INDEX "StaffPayProof_workspaceId_period_idx" ON "StaffPayProof"("workspaceId", "period");
CREATE INDEX "StaffPayProof_staffMemberId_idx" ON "StaffPayProof"("staffMemberId");
CREATE INDEX "StaffPayProof_documentId_idx" ON "StaffPayProof"("documentId");
ALTER TABLE "StaffPayProof" ADD CONSTRAINT "StaffPayProof_staffMemberId_fkey" FOREIGN KEY ("staffMemberId")
  REFERENCES "StaffMember"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StaffPayProof" ADD CONSTRAINT "StaffPayProof_documentId_fkey" FOREIGN KEY ("documentId")
  REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TRIGGER "StaffPayProof_1_set_tenant" BEFORE INSERT OR UPDATE ON "StaffPayProof"
  FOR EACH ROW EXECUTE FUNCTION "staff_row_tenant"();

-- The document is a workspace payroll file (filed to no engagement) of the person's workspace, of the proof's kind and
-- month. Read as the caller (not SECURITY DEFINER), so another workspace's document and none at all read alike.
CREATE FUNCTION "staff_pay_proof_document"() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "Document" WHERE "id" = NEW."documentId" AND "workspaceId" = NEW."workspaceId"
      AND "engagementId" IS NULL AND "kind" = NEW."kind" AND "period" = NEW."period"
  ) THEN
    RAISE EXCEPTION 'A staff proof is of a workspace payroll file of its kind and month' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION "staff_pay_proof_document"() FROM PUBLIC;
CREATE TRIGGER "StaffPayProof_2_document" BEFORE INSERT OR UPDATE ON "StaffPayProof"
  FOR EACH ROW EXECUTE FUNCTION "staff_pay_proof_document"();
CREATE TRIGGER "StaffPayProof_3_keep" BEFORE UPDATE ON "StaffPayProof"
  FOR EACH ROW EXECUTE FUNCTION "forbid_reparent"('staffMemberId', 'documentId', 'workspaceId', 'period', 'kind');

-- A payroll file whose pays or staff proofs are saved stays where they were found (migration 20261017000500, now for
-- staff proofs too).
CREATE OR REPLACE FUNCTION "document_keep_pay_lines"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF (NEW."kind", NEW."period", NEW."engagementId", NEW."storageKey")
       IS DISTINCT FROM (OLD."kind", OLD."period", OLD."engagementId", OLD."storageKey")
     AND (EXISTS (SELECT 1 FROM "PayrollPayLine" WHERE "documentId" = OLD."id")
          OR EXISTS (SELECT 1 FROM "StaffPayProof" WHERE "documentId" = OLD."id")) THEN
    RAISE EXCEPTION 'Document %: a payroll file with saved pays keeps its kind, month and place', OLD."id"
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION "document_keep_pay_lines"() FROM PUBLIC;

-- 4. The policies: owners and auditors read; owners alone add, change and remove.
ALTER TABLE "StaffMember" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_read" ON "StaffMember" FOR SELECT
  USING ("workspaceId" = ANY ((SELECT "app_staff_workspace_ids"())::TEXT[]));
CREATE POLICY "tenant_insert" ON "StaffMember" FOR INSERT
  WITH CHECK ("workspaceId" = ANY ((SELECT "app_owned_workspace_ids"())::TEXT[]));
CREATE POLICY "tenant_update" ON "StaffMember" FOR UPDATE
  USING ("workspaceId" = ANY ((SELECT "app_owned_workspace_ids"())::TEXT[]))
  WITH CHECK ("workspaceId" = ANY ((SELECT "app_owned_workspace_ids"())::TEXT[]));
CREATE POLICY "tenant_delete" ON "StaffMember" FOR DELETE
  USING ("workspaceId" = ANY ((SELECT "app_owned_workspace_ids"())::TEXT[]));

ALTER TABLE "StaffAssignment" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_read" ON "StaffAssignment" FOR SELECT
  USING ("workspaceId" = ANY ((SELECT "app_staff_workspace_ids"())::TEXT[]));
CREATE POLICY "tenant_insert" ON "StaffAssignment" FOR INSERT
  WITH CHECK ("workspaceId" = ANY ((SELECT "app_owned_workspace_ids"())::TEXT[]));
CREATE POLICY "tenant_update" ON "StaffAssignment" FOR UPDATE
  USING ("workspaceId" = ANY ((SELECT "app_owned_workspace_ids"())::TEXT[]))
  WITH CHECK ("workspaceId" = ANY ((SELECT "app_owned_workspace_ids"())::TEXT[]));
CREATE POLICY "tenant_delete" ON "StaffAssignment" FOR DELETE
  USING ("workspaceId" = ANY ((SELECT "app_owned_workspace_ids"())::TEXT[]));

ALTER TABLE "StaffPayProof" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_read" ON "StaffPayProof" FOR SELECT
  USING ("workspaceId" = ANY ((SELECT "app_staff_workspace_ids"())::TEXT[]));
CREATE POLICY "tenant_insert" ON "StaffPayProof" FOR INSERT
  WITH CHECK ("workspaceId" = ANY ((SELECT "app_owned_workspace_ids"())::TEXT[]));
CREATE POLICY "tenant_update" ON "StaffPayProof" FOR UPDATE
  USING ("workspaceId" = ANY ((SELECT "app_owned_workspace_ids"())::TEXT[]))
  WITH CHECK ("workspaceId" = ANY ((SELECT "app_owned_workspace_ids"())::TEXT[]));
CREATE POLICY "tenant_delete" ON "StaffPayProof" FOR DELETE
  USING ("workspaceId" = ANY ((SELECT "app_owned_workspace_ids"())::TEXT[]));
