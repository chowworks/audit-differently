-- Reading back what trusted work writes. Prisma returns the row it inserts (INSERT ... RETURNING), and Postgres
-- applies the SELECT policy to those rows too: a row the writer may not see makes the insert fail with the same
-- "violates row-level security" error. Trusted work (app.system, migration 20261011000400) writes two kinds
-- of row it could not see yet: a User with no membership (an invitation's placeholder, a first sign-in) and a
-- Workspace nobody belongs to yet (its creator becomes its owner one statement later). It may now read both.
--
-- Creating a workspace moves to trusted work as a whole for the same reason: the creator cannot see the
-- workspace until the membership exists, so the API creates it and the first membership as one trusted step
-- (workspaces.service.ts). A signed-in person still cannot read a workspace they do not belong to.

DROP POLICY "tenant_read" ON "User";
CREATE POLICY "tenant_read" ON "User" FOR SELECT
  USING ("id" = ANY ((SELECT "app_visible_user_ids"())::TEXT[]) OR (SELECT "app_is_system"()));

DROP POLICY "tenant_read" ON "Workspace";
CREATE POLICY "tenant_read" ON "Workspace" FOR SELECT
  USING ("id" = ANY ((SELECT "app_workspace_ids"())::TEXT[]) OR (SELECT "app_is_system"()));
DROP POLICY "tenant_insert" ON "Workspace";
CREATE POLICY "tenant_insert" ON "Workspace" FOR INSERT
  WITH CHECK ((SELECT "app_user_id"()) IS NOT NULL OR (SELECT "app_is_system"()));
