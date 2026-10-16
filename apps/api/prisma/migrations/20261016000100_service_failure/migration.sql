-- Failures people hit through no fault of their own, counted by the public health checks
-- /api/health/upload-failures and /api/health/server-errors (apps/api/src/core/service-failure-log.ts) and watched by
-- Better Stack (ops/monitoring.ts). Kept in a table, not in memory, so a deploy or a second instance does not hide them.
--
-- A row names when it happened, which kind it was and the route it happened on (`POST /api/documents`, the route's
-- pattern, never its ids), and nothing else: no workspace, no person, no file name, no error message. The reason
-- goes to the API's log only. So it is not a tenant table: no workspaceId, no set_tenant trigger, no policies, and the
-- restricted role reads, inserts and deletes it with the table grants (the API deletes rows older than 30 days).
CREATE TABLE "ServiceFailure" (
  "id" TEXT NOT NULL,
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "kind" TEXT NOT NULL,
  "route" TEXT NOT NULL,
  CONSTRAINT "ServiceFailure_pkey" PRIMARY KEY ("id"),
  -- upload: storing a proof upload or saving its record failed; server: any request answered 500
  CONSTRAINT "ServiceFailure_kind_check" CHECK ("kind" IN ('upload', 'server')),
  -- a method and a route pattern; the bound keeps a row small whatever the router hands over
  CONSTRAINT "ServiceFailure_route_check" CHECK (char_length("route") <= 200)
);
CREATE INDEX "ServiceFailure_kind_at_idx" ON "ServiceFailure"("kind", "at");
