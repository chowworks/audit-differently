-- The full demo workspace (owner's decision, 2026-10-16, as Learn Differently's `featuredDemo`): the one workspace of
-- fictional data that shows every feature, marked "Full demo" wherever a workspace or its engagements are named. The
-- demo seed sets it (scripts/demo-seed.ts, as the database owner); no API route changes it.
ALTER TABLE "Workspace" ADD COLUMN "featuredDemo" BOOLEAN NOT NULL DEFAULT false;
