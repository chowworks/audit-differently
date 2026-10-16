-- The records an engagement keeps besides its financials (ENGAGEMENT_TRACKS in packages/types), replacing the
-- single start step of 20261015000100: the proposal, the award letter and the signed contract are each kept or not.
ALTER TABLE "Engagement" ADD COLUMN "tracks" TEXT[] NOT NULL
  DEFAULT ARRAY['proposal', 'award-letter', 'contract']::TEXT[];
ALTER TABLE "Engagement" ADD CONSTRAINT "Engagement_tracks_check"
  CHECK ("tracks" <@ ARRAY['proposal', 'award-letter', 'contract']::TEXT[]);

-- A start step kept every record from it on.
UPDATE "Engagement" SET "tracks" = CASE "startsAt"
  WHEN 'award-letter' THEN ARRAY['award-letter', 'contract']::TEXT[]
  WHEN 'budget-narrative' THEN ARRAY['contract']::TEXT[]
  WHEN 'contract' THEN ARRAY['contract']::TEXT[]
  ELSE ARRAY['proposal', 'award-letter', 'contract']::TEXT[]
END;

ALTER TABLE "Engagement" DROP CONSTRAINT "Engagement_startsAt_check";
ALTER TABLE "Engagement" DROP COLUMN "startsAt";
