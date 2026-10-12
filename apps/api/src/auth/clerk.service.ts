import { Injectable, Logger } from '@nestjs/common'
import { createClerkClient, verifyToken, type ClerkClient } from '@clerk/backend'

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
}
