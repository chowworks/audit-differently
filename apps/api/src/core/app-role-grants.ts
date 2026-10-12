/**
 * What the restricted database role the API connects as (scripts/create-app-role.ts) may execute. Policies call
 * these as the caller, and the API's context statement calls workspaces_of_user and all_workspace_ids. Every other function (the triggers,
 * the helpers that look across workspaces) runs only as the database owner. The database specs grant exactly this
 * list, so they test the real privileges.
 */
export const APP_ROLE_FUNCTIONS: readonly string[] = [
  'app_user_id()',
  'app_workspace_ids()',
  'app_owned_workspace_ids()',
  'app_visible_user_ids()',
  'workspaces_of_user(text)',
  'all_workspace_ids()',
  'app_is_system()',
]

/** SQL that gives `role` its table access and exactly the functions above, and nothing else. `role` is a plain identifier. */
export function appRoleGrantsSql(role: string): string[] {
  return [
    `GRANT USAGE ON SCHEMA public TO ${role}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`,
    `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM ${role}`,
    ...APP_ROLE_FUNCTIONS.map((f) => `GRANT EXECUTE ON FUNCTION ${f} TO ${role}`),
  ]
}
