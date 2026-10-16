-- The step an engagement's workflow starts at (ENGAGEMENT_STARTS in packages/types). A team that keeps no
-- proposal or award letter here starts at the contract; the steps before it are not used.
ALTER TABLE "Engagement" ADD COLUMN "startsAt" TEXT NOT NULL DEFAULT 'proposal';
ALTER TABLE "Engagement" ADD CONSTRAINT "Engagement_startsAt_check"
  CHECK ("startsAt" IN ('proposal', 'award-letter', 'budget-narrative', 'contract'));
