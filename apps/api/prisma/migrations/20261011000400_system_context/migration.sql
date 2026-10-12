-- Trusted work. The API's reviewed background paths (`runAsSystem` in src/core/tenant-context.ts: making the
-- creator of a workspace its owner, the placeholder row of an invited person, and handing that placeholder's
-- memberships to the real account on its first sign-in) act with no signed-in person, so "app_user_id"() is
-- null and the policies that say "only yourself" or "only an owner" refused them. The restricted role never
-- bypasses a policy, so trusted work marks the connection instead: PrismaService sets app.system = 'on' for
-- runAsSystem and nothing else, and the six policies below admit it. Every other table keeps its policies: the
-- system context already sees every workspace there through app.workspace_ids.

CREATE FUNCTION "app_is_system"() RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$ SELECT current_setting('app.system', true) = 'on' $$;

-- People write their own row; trusted work writes a placeholder, takes it over, and removes it.
DROP POLICY "tenant_insert" ON "User";
CREATE POLICY "tenant_insert" ON "User" FOR INSERT
  WITH CHECK ("id" = (SELECT "app_user_id"()) OR (SELECT "app_is_system"()));
DROP POLICY "tenant_update" ON "User";
CREATE POLICY "tenant_update" ON "User" FOR UPDATE
  USING ("id" = (SELECT "app_user_id"()) OR (SELECT "app_is_system"()))
  WITH CHECK ("id" = (SELECT "app_user_id"()) OR (SELECT "app_is_system"()));
DROP POLICY "tenant_delete" ON "User";
CREATE POLICY "tenant_delete" ON "User" FOR DELETE
  USING ((SELECT "app_is_system"()));

-- Owners give, change and take away memberships in the workspaces they own; trusted work gives the first one.
DROP POLICY "tenant_insert" ON "Membership";
CREATE POLICY "tenant_insert" ON "Membership" FOR INSERT
  WITH CHECK ("workspaceId" = ANY ((SELECT "app_owned_workspace_ids"())::TEXT[]) OR (SELECT "app_is_system"()));
DROP POLICY "tenant_update" ON "Membership";
CREATE POLICY "tenant_update" ON "Membership" FOR UPDATE
  USING ("workspaceId" = ANY ((SELECT "app_owned_workspace_ids"())::TEXT[]) OR (SELECT "app_is_system"()))
  WITH CHECK ("workspaceId" = ANY ((SELECT "app_owned_workspace_ids"())::TEXT[]) OR (SELECT "app_is_system"()));
DROP POLICY "tenant_delete" ON "Membership";
CREATE POLICY "tenant_delete" ON "Membership" FOR DELETE
  USING ("workspaceId" = ANY ((SELECT "app_owned_workspace_ids"())::TEXT[]) OR (SELECT "app_is_system"()));
