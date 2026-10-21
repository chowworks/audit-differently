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
  'app_is_admin()',
  // Email administration (migration 20261016000100): which emailed receipts the admin's mark reads and reruns.
  'app_admin_sees_receipt(text,text,text)',
  'app_admin_reran(text,text)',
  // Receipts addresses (migration 20261017000400): whether an address is in use or was used before, for the owner's form.
  'app_receipts_address_taken(text)',
  // The staff list (migration 20261018000100): the workspaces whose staff the caller reads (owners and auditors).
  'app_staff_workspace_ids()',
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
