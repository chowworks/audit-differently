-- Reporting configuration and the participant-file checklist, per engagement (2026-10-11).
-- The funder's form names who the report goes to and who signs it; programs differ in which eligibility
-- items a participant file must hold. Both now live on the engagement. Empty checklist = the defaults.
ALTER TABLE "Engagement"
  ADD COLUMN "reportTo" TEXT,
  ADD COLUMN "submissionMethod" TEXT,
  ADD COLUMN "preparerName" TEXT,
  ADD COLUMN "preparerOrganization" TEXT,
  ADD COLUMN "authorizerName" TEXT,
  ADD COLUMN "authorizerOrganization" TEXT,
  ADD COLUMN "eligibilityItems" JSONB NOT NULL DEFAULT '[]';
