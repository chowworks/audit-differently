import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common'
import { createClerkClient, verifyToken, type ClerkClient, type User } from '@clerk/backend'

/**
 * The address an account may act under: the primary one if verified, else the first verified one, else none.
 * An unverified address is never used, because the invitation claim (me.controller.ts) matches on it and
 * anyone can add an address they do not own to their own account. A dev-instance user made by hand may have
 * no primary set, which is why the first verified one counts.
 */
export function verifiedEmail(user: {
  primaryEmailAddressId: string | null
  emailAddresses: { id: string; emailAddress: string; verification: { status: string } | null }[]
}): string | null {
  const verified = user.emailAddresses.filter((e) => e.verification?.status === 'verified')
  const primary = verified.find((e) => e.id === user.primaryEmailAddressId)
  return (primary ?? verified[0])?.emailAddress ?? null
}

/** What an admin sees when Clerk's backend fails on an admin tool call. */
export const CLERK_DOWN = 'Clerk is not answering; try again'

/** The HTTP status of a Clerk backend error (ClerkAPIResponseError carries it), if any. */
const clerkStatus = (err: unknown): number | undefined => {
  const status = (err as { status?: unknown } | null)?.status
  return typeof status === 'number' ? status : undefined
}

/** The browser origins a session token may come from: the comma-separated FRONTEND_URL list. */
export function authorizedParties(frontendUrl: string | undefined): string[] {
  return (frontendUrl ?? 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
}

/**
 * Thin wrapper around the Clerk backend SDK for this product's own Clerk instance.
 * verifyBearerToken(token) validates a session JWT and returns the Clerk userId.
 */
@Injectable()
export class ClerkService {
  private readonly logger = new Logger(ClerkService.name)
  private readonly client: ClerkClient | null
  private readonly secretKey: string | null

  constructor() {
    this.secretKey = process.env.CLERK_SECRET_KEY ?? null
    if (!this.secretKey) {
      this.client = null
      this.logger.warn('CLERK_SECRET_KEY not set: auth checks will reject all requests')
    } else {
      this.client = createClerkClient({ secretKey: this.secretKey })
    }
  }

  /** Returns the Clerk userId from a Bearer JWT, or null if invalid, expired or no key is configured. */
  async verifyBearerToken(token: string): Promise<string | null> {
    if (!this.secretKey) return null
    try {
      // The session must have been created by this product's web app: the token's azp claim must be one of
      // the browser origins FRONTEND_URL names (Clerk calls these authorized parties).
      const payload = await verifyToken(token, {
        secretKey: this.secretKey,
        authorizedParties: authorizedParties(process.env.FRONTEND_URL),
      })
      return payload.sub ?? null
    } catch (err) {
      this.logger.debug(
        `Token verification failed: ${err instanceof Error ? err.message : 'unknown'}`
      )
      return null
    }
  }

  /** The user's email and name from Clerk, for the User row and the access log's actor name. */
  async profile(userId: string): Promise<{ email: string | null; displayName: string | null }> {
    if (!this.client) return { email: null, displayName: null }
    const user = await this.client.users.getUser(userId)
    const name = [user.firstName, user.lastName].filter(Boolean).join(' ')
    return { email: verifiedEmail(user), displayName: name || null }
  }

  /**
   * The user's `publicMetadata.role` (today only 'admin', the platform admin), or null if none or Clerk cannot say:
   * a failure answers null, so an admin route refuses rather than lets through. Same convention as Interview Differently.
   */
  async getRole(userId: string): Promise<string | null> {
    if (!this.client) return null
    try {
      const user = await this.client.users.getUser(userId)
      return (user.publicMetadata as { role?: unknown } | null)?.role === 'admin' ? 'admin' : null
    } catch (err) {
      this.logger.warn(
        `Failed to fetch Clerk user ${userId}: ${err instanceof Error ? err.message : 'unknown'}`
      )
      return null
    }
  }

  /**
   * One user as the admin tool shows them, or null if Clerk does not know them (a Clerk 404). Any other failure is a
   * 503: "Clerk did not answer" is not "no such person".
   */
  async getUserSummary(userId: string): Promise<ClerkUserSummary | null> {
    if (!this.client) return null
    try {
      return toSummary(await this.client.users.getUser(userId))
    } catch (err) {
      if (clerkStatus(err) === 404) return null
      throw this.down('getUser', err)
    }
  }

  /**
   * Every verified email address on the account, lowercased: how the admin path knows an address it names is the
   * admin's own (WorkspacesService), so the admin is seated as themself rather than as an invitation's placeholder.
   */
  async verifiedEmails(userId: string): Promise<string[]> {
    if (!this.client) return []
    const user = await this.clerkCall('getUser', (c) => c.users.getUser(userId))
    return user.emailAddresses
      .filter((e) => e.verification?.status === 'verified')
      .map((e) => e.emailAddress.toLowerCase())
  }

  /** Users by email or name (Clerk's own `query` match), newest first; an empty query lists the latest sign-ups. */
  async searchUsers(query: string, limit = 20): Promise<ClerkUserSummary[]> {
    const page = await this.clerkCall('getUserList', (c) =>
      c.users.getUserList({ query: query || undefined, limit, orderBy: '-created_at' })
    )
    return page.data.map(toSummary)
  }

  /**
   * Every platform admin. Clerk cannot filter by metadata, so this reads the users a page at a time, up to `max`
   * (plenty for this product's one instance; the admin tool says so if the list was cut short).
   */
  async listAdmins(max = 2000): Promise<{ admins: ClerkUserSummary[]; complete: boolean }> {
    const admins: ClerkUserSummary[] = []
    for (let offset = 0; offset < max; offset += 100) {
      const page = await this.clerkCall('getUserList', (c) =>
        c.users.getUserList({ limit: 100, offset, orderBy: 'created_at' })
      )
      admins.push(...page.data.map(toSummary).filter((u) => u.role === 'admin'))
      if (page.data.length < 100) return { admins, complete: true }
    }
    return { admins, complete: false }
  }

  /**
   * Gives or clears the user's role. `updateUserMetadata` merges into the existing publicMetadata (a null value
   * removes that key), so every other key on the account is kept.
   */
  async setRole(userId: string, role: 'admin' | null): Promise<void> {
    await this.clerkCall('updateUserMetadata', (c) =>
      c.users.updateUserMetadata(userId, { publicMetadata: { role } })
    )
  }

  /** Runs a call to Clerk's backend for the admin tools; any failure is a 503 (CLERK_DOWN), logged here. */
  private async clerkCall<T>(what: string, call: (client: ClerkClient) => Promise<T>): Promise<T> {
    if (!this.client) throw new Error('Clerk secret key not set')
    try {
      return await call(this.client)
    } catch (err) {
      throw this.down(what, err)
    }
  }

  private down(what: string, err: unknown): ServiceUnavailableException {
    this.logger.warn(
      `Clerk ${what} failed (${clerkStatus(err) ?? 'no status'}): ${err instanceof Error ? err.message : 'unknown'}`
    )
    return new ServiceUnavailableException(CLERK_DOWN)
  }
}

/** A Clerk user reduced to what the admin tool needs. */
export interface ClerkUserSummary {
  id: string
  email: string | null
  displayName: string | null
  role: string | null
}

/** A Clerk user as the admin tool shows them: by a verified address only (`verifiedEmail`), never an unverified one. */
function toSummary(user: User): ClerkUserSummary {
  const role = (user.publicMetadata as { role?: unknown } | null)?.role
  return {
    id: user.id,
    email: verifiedEmail(user),
    displayName: [user.firstName, user.lastName].filter(Boolean).join(' ') || null,
    role: typeof role === 'string' ? role : null,
  }
}
