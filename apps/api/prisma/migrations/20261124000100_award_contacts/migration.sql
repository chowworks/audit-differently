-- Several contacts per award (G-09, issue #94, Chow's decision 2026-11-24): an award holds many contacts, each
-- with name, organization, job title, email and phone. The one free-text "funderContact" becomes one contact and
-- the column goes. No shared contacts list: a contact belongs to one award.

-- 1. The new table. A child of the engagement, as the budget lines are: members read and write at the database
-- line, and the application lets owners and bookkeepers change it and auditors read only (WRITE_ROLES).
CREATE TABLE "EngagementContact" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT, -- set by the trigger below, then NOT NULL
  "engagementId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "organization" TEXT,
  "jobTitle" TEXT,
  "email" TEXT,
  "phone" TEXT,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EngagementContact_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "EngagementContact_workspaceId_idx" ON "EngagementContact"("workspaceId");
CREATE INDEX "EngagementContact_engagementId_idx" ON "EngagementContact"("engagementId");
ALTER TABLE "EngagementContact" ADD CONSTRAINT "EngagementContact_engagementId_fkey" FOREIGN KEY ("engagementId")
  REFERENCES "Engagement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 2. The tenant column is set from the parent engagement and never chosen by the application; it cannot be moved
-- to another workspace afterwards.
CREATE TRIGGER "EngagementContact_1_set_tenant" BEFORE INSERT OR UPDATE ON "EngagementContact"
  FOR EACH ROW EXECUTE FUNCTION "set_tenant_from_parent"('Engagement', 'engagementId');
CREATE TRIGGER "EngagementContact_3_keep" BEFORE UPDATE ON "EngagementContact"
  FOR EACH ROW EXECUTE FUNCTION "forbid_reparent"('workspaceId');

-- 3. The one free-text funder contact becomes a contact, so no award loses the contact it has. The whole text is
-- the name (it cannot be parsed into parts); when the text is an email address, the email field takes it too.
INSERT INTO "EngagementContact" ("id", "engagementId", "name", "email", "updatedAt")
SELECT gen_random_uuid()::text,
       "id",
       btrim("funderContact"),
       CASE WHEN btrim("funderContact") ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
            THEN btrim("funderContact") END,
       CURRENT_TIMESTAMP
FROM "Engagement"
WHERE "funderContact" IS NOT NULL AND btrim("funderContact") <> '';

-- 4. The column is gone; the contact carries it now.
ALTER TABLE "Engagement" DROP COLUMN "funderContact";

-- 5. The tenant column is filled for every row (the trigger set it on insert), so it is NOT NULL from here.
ALTER TABLE "EngagementContact" ALTER COLUMN "workspaceId" SET NOT NULL;

-- 6. Row-level security: members of the workspace read and write at the database line; the application decides the
-- role (create_tenant_policies and tenant_cond were dropped by the first migration, so the conditions are written
-- out here, as the other tables added since do).
ALTER TABLE "EngagementContact" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_read" ON "EngagementContact" FOR SELECT
  USING ("workspaceId" = ANY ((SELECT "app_workspace_ids"())::TEXT[]));
CREATE POLICY "tenant_insert" ON "EngagementContact" FOR INSERT
  WITH CHECK ("workspaceId" = ANY ((SELECT "app_workspace_ids"())::TEXT[]));
CREATE POLICY "tenant_update" ON "EngagementContact" FOR UPDATE
  USING ("workspaceId" = ANY ((SELECT "app_workspace_ids"())::TEXT[]))
  WITH CHECK ("workspaceId" = ANY ((SELECT "app_workspace_ids"())::TEXT[]));
CREATE POLICY "tenant_delete" ON "EngagementContact" FOR DELETE
  USING ("workspaceId" = ANY ((SELECT "app_workspace_ids"())::TEXT[]));
