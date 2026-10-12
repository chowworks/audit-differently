import { SetMetadata } from '@nestjs/common'

export const SKIP_TERMS_GATE = 'skipTermsGate'

/**
 * Lets a signed-in person who has not accepted the current Terms through AuthenticatedGuard. For the two routes
 * the Terms screen itself needs, GET /me and POST /me/terms, and nothing else.
 */
export const SkipTermsGate = () => SetMetadata(SKIP_TERMS_GATE, true)
