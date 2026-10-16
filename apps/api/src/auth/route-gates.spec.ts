import 'reflect-metadata'
import { RequestMethod } from '@nestjs/common'
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants'
import { AppModule } from '../app.module'
import { AdminGuard } from './admin.guard'
import { AuthenticatedGuard } from './authenticated.guard'
import { SKIP_TERMS_GATE } from './skip-terms-gate.decorator'

/**
 * Every HTTP route of the API, read from the controllers' decorators, and whether AuthenticatedGuard applies
 * to it. This data holds payroll and eligibility records: a route without the guard is a public one, and the
 * list of those is four long and written down here. Adding a route means adding it to the list below.
 */
type Ctor = { new (...args: never[]): unknown; prototype: Record<string, unknown> }

/** The controllers reachable from AppModule through its imports. */
function controllersOf(mod: Ctor, seen = new Set<Ctor>()): Ctor[] {
  if (seen.has(mod)) return []
  seen.add(mod)
  const own = (Reflect.getMetadata('controllers', mod) ?? []) as Ctor[]
  const imports = (Reflect.getMetadata('imports', mod) ?? []) as Ctor[]
  return [...own, ...imports.flatMap((m) => controllersOf(m, seen))]
}

const join = (...parts: (string | undefined)[]) =>
  '/' +
  parts
    .map((p) => (p ?? '').replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/')

/** Each route as "GET /api/path", with whether the guard runs for it (on the class or the handler). */
function routes(): { route: string; gated: boolean; admin: boolean; skipsTerms: boolean }[] {
  const out: { route: string; gated: boolean; admin: boolean; skipsTerms: boolean }[] = []
  for (const ctrl of controllersOf(AppModule as unknown as Ctor)) {
    const base = Reflect.getMetadata(PATH_METADATA, ctrl) as string | undefined
    const classGuards = (Reflect.getMetadata(GUARDS_METADATA, ctrl) ?? []) as unknown[]
    for (const name of Object.getOwnPropertyNames(ctrl.prototype)) {
      const handler = ctrl.prototype[name]
      if (typeof handler !== 'function' || name === 'constructor') continue
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined
      if (method === undefined) continue
      const path = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined
      const guards = [
        ...classGuards,
        ...((Reflect.getMetadata(GUARDS_METADATA, handler) ?? []) as unknown[]),
      ]
      out.push({
        route: `${RequestMethod[method]} ${join('api', base, path)}`,
        gated: guards.includes(AuthenticatedGuard),
        // AdminGuard reads the caller AuthenticatedGuard verified, so it must come after it.
        admin:
          guards.includes(AdminGuard) &&
          guards.indexOf(AuthenticatedGuard) < guards.indexOf(AdminGuard),
        skipsTerms: !!(
          Reflect.getMetadata(SKIP_TERMS_GATE, handler) ??
          Reflect.getMetadata(SKIP_TERMS_GATE, ctrl)
        ),
      })
    }
  }
  return out
}

/** The routes that answer without a signed-in caller, and why each may. */
const PUBLIC = [
  // Which system this is; the answer holds no configuration (health.controller.spec).
  'GET /api/health',
  // The file behind a signed, expiring token that the gated (and logged) /documents/:id/url issued; local disk
  // only, 404 when R2 is configured. The signature is the credential, as with an R2 signed URL.
  'GET /api/documents/local/:token',
  // The contact form a visitor fills in before having an account: validated, throttled to 5 per 10 minutes, honeypot.
  'POST /api/contact',
  // The email provider's webhook for emailed receipts (Resend inbound): its credential is the provider's Svix signature
  // over the raw body, checked in constant time with a five-minute window; it only queues the email (once per provider
  // id) and answers at once, nothing is read back; throttled to 60 a minute; 404 while the feature is not set up.
  'POST /api/inbound/resend',
]

/** The gated routes a person who has not accepted the current Terms may still call: the Terms screen's own. */
const OPEN_BEFORE_TERMS = ['GET /api/me', 'POST /api/me/terms']

/**
 * The platform admin's routes: AdminGuard after AuthenticatedGuard, which checks the Clerk role and sets the admin's
 * database flag. Workspace level only: people, name, lists, suggestions, creating a workspace, who is an admin, and the emailed
 * receipts that went nowhere or were refused or failed. No
 * route below the workspace (engagements, months, documents, participants, the access log, deletion) is here, so
 * the flag is never set there and an admin is only what their memberships make them (404 elsewhere).
 */
const ADMIN = [
  'POST /api/workspaces',
  'GET /api/admin/workspaces',
  'GET /api/admin/workspaces/:id',
  'PATCH /api/admin/workspaces/:id',
  'PATCH /api/admin/workspaces/:id/lists',
  'POST /api/admin/workspaces/:id/members',
  'PATCH /api/admin/workspaces/:id/members/:userId',
  'DELETE /api/admin/workspaces/:id/members/:userId',
  'GET /api/admin/users',
  'GET /api/admin/admins',
  'GET /api/admin/role-changes',
  'PUT /api/admin/users/:id/role',
  // Email administration: emailed receipts that reached no workspace, or were refused or failed. Metadata only.
  'GET /api/admin/inbound',
  'POST /api/admin/inbound/:id/run-again',
  // Highlights: what is highlighted on each payroll proof type, for the whole system.
  'GET /api/admin/highlights',
  'PUT /api/admin/highlights/:kind',
  // Matching statistics: counts, sizes and durations of finished match runs, across workspaces.
  'GET /api/admin/match-stats',
]

/** Every other route. A member of another workspace gets 404 from each; the role checks are in the specs beside each service. */
const GATED = [
  ...ADMIN,
  'GET /api/me',
  'POST /api/me/terms',
  'GET /api/workspaces',
  'GET /api/workspaces/:id',
  'PATCH /api/workspaces/:id',
  'PATCH /api/workspaces/:id/lists',
  'GET /api/workspaces/:id/activity',
  'POST /api/workspaces/:id/suggestions',
  'POST /api/workspaces/:id/members',
  'PATCH /api/workspaces/:id/members/:userId',
  'DELETE /api/workspaces/:id/members/:userId',
  'GET /api/workspaces/:id/deletion-summary',
  'POST /api/workspaces/:id/deletion',
  'GET /api/workspaces/:id/deletion/:deletionId/parts/:n',
  'DELETE /api/workspaces/:id',
  'GET /api/engagements',
  'POST /api/engagements',
  'GET /api/engagements/:id',
  'PATCH /api/engagements/:id',
  'GET /api/engagements/:id/audit-package',
  'GET /api/engagements/:id/deletion-summary',
  'POST /api/engagements/:id/deletion',
  'GET /api/engagements/:id/deletion/:deletionId/parts/:n',
  'DELETE /api/engagements/:id',
  'POST /api/engagements/:id/reports',
  'POST /api/engagements/:id/participants',
  'POST /api/engagements/:id/budget-lines',
  'PATCH /api/engagements/:id/budget-lines/:lineId',
  'DELETE /api/engagements/:id/budget-lines/:lineId',
  'POST /api/engagements/:id/imports/read',
  'POST /api/engagements/:id/imports/suggest',
  'POST /api/engagements/:id/imports/preview',
  'POST /api/engagements/:id/imports',
  'GET /api/reports/:id',
  'GET /api/reports/:id/bundle',
  'POST /api/reports/:id/expenses',
  'PATCH /api/expenses/:id',
  'DELETE /api/expenses/:id',
  'POST /api/expenses/:id/documents',
  'DELETE /api/expenses/:id/documents/:documentId',
  'POST /api/reports/:id/wex',
  'PATCH /api/wex/:id',
  'DELETE /api/wex/:id',
  'POST /api/wex/:id/documents',
  'POST /api/reports/:id/closing',
  'POST /api/reports/:id/send-back',
  'POST /api/reports/:id/request-edits',
  'DELETE /api/reports/:id',
  'POST /api/reports/:id/reopen',
  'POST /api/reports/:id/submit',
  'POST /api/reports/:id/receipts',
  'PATCH /api/receipts/:id',
  'POST /api/receipts/:id/match',
  'DELETE /api/receipts/:id/match/:expenseId',
  'POST /api/receipts/:id/dismiss',
  'GET /api/workspaces/:id/receipts-inbox',
  'POST /api/inbound-receipts/:id/run-again',
  'POST /api/inbound-receipts/:id/file',
  'POST /api/reports/:id/payroll-documents',
  'POST /api/reports/:id/payroll-documents/replace',
  'GET /api/payroll/:target/:id/lines',
  'GET /api/payroll/statements/:documentId/file',
  'PUT /api/payroll/:target/:id/statement',
  'GET /api/payroll/:target/:id/proof/:documentId',
  'GET /api/payroll-match/:runId/files/:fileId/copy',
  'POST /api/reports/:id/payroll-match',
  'GET /api/reports/:id/payroll-match',
  'GET /api/payroll-match/:runId/progress',
  'POST /api/payroll-match/:runId/files',
  'GET /api/payroll-match/:runId',
  'GET /api/payroll-match/:runId/files/:fileId',
  'POST /api/payroll-match/:runId/save',
  'DELETE /api/payroll-match/:runId',
  'POST /api/documents',
  'GET /api/documents/of-workspace/:workspaceId',
  'DELETE /api/documents/:id',
  'GET /api/documents/:id/url',
  'PATCH /api/participants/:id/tags',
  'POST /api/participants/:id/documents',
  'DELETE /api/participants/:id/documents/:documentId',
]

describe('route gates', () => {
  const all = routes()

  it('finds every route', () => {
    expect(all).toHaveLength(PUBLIC.length + GATED.length)
    expect(new Set(all.map((r) => r.route))).toEqual(new Set([...PUBLIC, ...GATED]))
  })

  it('puts AuthenticatedGuard on every route but the four public ones', () => {
    expect(
      all
        .filter((r) => !r.gated)
        .map((r) => r.route)
        .sort()
    ).toEqual([...PUBLIC].sort())
  })

  it('guards each listed route', () => {
    const gated = new Set(all.filter((r) => r.gated).map((r) => r.route))
    for (const route of GATED) expect([route, gated.has(route)]).toEqual([route, true])
  })

  it('puts AdminGuard, after AuthenticatedGuard, on exactly the admin routes', () => {
    expect(
      all
        .filter((r) => r.admin)
        .map((r) => r.route)
        .sort()
    ).toEqual([...ADMIN].sort())
  })

  it('asks for accepted Terms on every gated route but the two the Terms screen needs', () => {
    expect(
      all
        .filter((r) => r.gated && r.skipsTerms)
        .map((r) => r.route)
        .sort()
    ).toEqual([...OPEN_BEFORE_TERMS].sort())
  })
})
