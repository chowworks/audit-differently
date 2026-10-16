import { Prisma } from '@prisma/client'

/**
 * The tables that carry row-level security (the ones with a `tenant_read` policy, see
 * prisma/migrations/20261011000100_tenant_rls). A spec keeps this list equal to the database. A query that
 * cannot reach any of them skips the per-query transaction that sets the tenant context. Today that is every
 * table; the list exists so a table without tenant data (settings, say) can be added without that cost.
 */
export const TENANT_TABLES: ReadonlySet<string> = new Set([
  'Workspace',
  'User',
  'Membership',
  'Engagement',
  'BudgetLine',
  'MonthlyReport',
  'Expense',
  'Document',
  'ExpenseDocument',
  'Participant',
  'ParticipantDocument',
  'WexPayment',
  'WexPaymentDocument',
  'Check',
  // A month's reopenings (migration 20261015001500): append-only, they go only with their month.
  'ReportReopening',
  // A payroll zip staged while its matches are checked (migration 20261016001000).
  'PayrollMatchRun',
  'PayrollMatchFile',
  // One finished match run, for Admin tools → Matching statistics (migration 20261016001500): counts only.
  'MatchRunStat',
  'DataAccessLog',
  'Suggestion',
  'ImportMapping',
  // Emailed receipts (migration 20261015001000). Its rows with no workspace yet are trusted work's alone (app.system),
  // so like every table here a query on it must set the request's context.
  'InboundReceipt',
  'DeletionRecord',
  'TermsAcceptance',
  // No workspace: who made or unmade a platform admin. It is here because its policies read the request's context
  // (app.admin, app.user_id), so a query on it must set that context like any other.
  'PlatformRoleChange',
  // No workspace: what a platform admin set to highlight on payroll proof. Its insert policy reads app.admin and app.user_id.
  'HighlightSetting',
])

type Fields = Map<string, string> // relation field name -> the model it points at
const relations = new Map<string, Fields>()
for (const m of Prisma.dmmf.datamodel.models) {
  relations.set(
    m.name,
    new Map(m.fields.filter((f) => f.kind === 'object').map((f) => [f.name, f.type]))
  )
}

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' &&
  v !== null &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)

/**
 * Whether a query on `model` with these arguments can read or write a tenant table: the model itself is
 * one, or a relation followed anywhere in its select, include, where or nested writes leads to one. When in
 * doubt (an unknown model) it says yes, which only costs speed.
 */
export function touchesTenantTable(model: string, args: unknown): boolean {
  if (TENANT_TABLES.has(model)) return true
  const fields = relations.get(model)
  if (!fields) return true
  const walk = (node: unknown, current: string): boolean => {
    if (Array.isArray(node)) return node.some((n) => walk(n, current))
    if (!isPlain(node)) return false
    const own = relations.get(current)
    for (const [key, value] of Object.entries(node)) {
      const target = own?.get(key)
      if (target) {
        if (TENANT_TABLES.has(target) || walk(value, target)) return true
      } else if (walk(value, current)) {
        return true
      }
    }
    return false
  }
  return walk(args, model)
}
