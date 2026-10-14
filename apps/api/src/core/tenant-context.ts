import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Who a request acts as. A request opens an empty context (TenantMiddleware); the guard that verifies the
 * caller fills it in with `identifyCaller` before anything else touches the database. Nothing outside a
 * request has a context, so background work must say what it acts as (`runAsSystem`). Phase 1's PrismaService
 * reads it to set the caller's id and workspaces on every query for row-level security.
 */
export interface TenantContext {
  userId?: string
  /** Sees every workspace: trusted background work. */
  allWorkspaces?: boolean
  /** Workspaces the caller is limited to when it is not a membership lookup. */
  fixedWorkspaceIds?: string[]
  /** The platform admin, on a route AdminGuard let through after checking the Clerk role: workspace level only. */
  admin?: boolean
}

const store = new AsyncLocalStorage<TenantContext>()

export function tenantContext(): TenantContext | undefined {
  return store.getStore()
}

/** Opens a fresh, empty context for the work done inside `fn`. */
export function withTenantContext<T>(fn: () => T, initial: TenantContext = {}): T {
  return store.run({ ...initial }, fn)
}

/**
 * Says who the current request acts as. Call it as soon as a guard has verified the caller. A request is
 * always one person in their own workspaces: nothing a guard learns can widen that (runAsSystem is for
 * code that runs outside a request).
 */
export function identifyCaller(who: { userId: string }): void {
  const ctx = store.getStore()
  if (!ctx) return
  ctx.userId = who.userId
  ctx.allWorkspaces = false
  ctx.fixedWorkspaceIds = undefined
  ctx.admin = false
}

/**
 * Marks the current request as the platform admin's. Only AdminGuard calls it, after identifyCaller and after
 * Clerk's backend said the caller's role is admin. PrismaService then sets app.admin = 'on' beside the admin's own
 * user id and workspaces (migration 20261013000200): workspaces, memberships, users and suggestions, never records.
 */
export function identifyAdmin(): void {
  const ctx = store.getStore()
  if (!ctx?.userId) return
  ctx.admin = true
}

/** Runs `fn` seeing every workspace. For audited, trusted code paths only (jobs, webhooks, startup). */
export function runAsSystem<T>(fn: () => T): T {
  return store.run({ allWorkspaces: true }, fn)
}

/** Runs `fn` limited to one workspace, with no signed-in person. */
export function runAsWorkspace<T>(workspaceId: string, fn: () => T): T {
  return store.run({ fixedWorkspaceIds: [workspaceId] }, fn)
}
