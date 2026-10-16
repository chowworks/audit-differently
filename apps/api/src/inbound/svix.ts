import { createHmac, timingSafeEqual } from 'node:crypto'

/** How far a webhook's timestamp may be from this clock, either way: an older call is a replay. */
export const SVIX_TOLERANCE_SECONDS = 5 * 60

/**
 * Whether a webhook call is the email provider's: Resend signs with Svix (docs: resend.com/docs/dashboard/webhooks/
 * verify-webhooks-requests, and docs.svix.com/receiving/verifying-payloads/how-manual). The signed content is
 * `${svix-id}.${svix-timestamp}.${raw body}`, signed with HMAC-SHA256 under the base64 key after the secret's `whsec_`
 * prefix; `svix-signature` holds space-separated `v1,<base64>` signatures, any one of which may match. Compared in
 * constant time, and a timestamp more than five minutes off is refused.
 */
export function verifySvix(
  secret: string,
  headers: { id?: string; timestamp?: string; signature?: string },
  rawBody: Buffer,
  nowSeconds = Math.floor(Date.now() / 1000)
): boolean {
  const { id, timestamp, signature } = headers
  if (!id || !timestamp || !signature) return false
  if (!/^\d{1,12}$/.test(timestamp)) return false
  if (Math.abs(nowSeconds - Number(timestamp)) > SVIX_TOLERANCE_SECONDS) return false
  const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64')
  if (!key.length) return false
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.`).update(rawBody).digest()
  return signature.split(' ').some((part) => {
    const [version, sig] = part.split(',', 2)
    if (version !== 'v1' || !sig) return false
    const given = Buffer.from(sig, 'base64')
    return given.length === expected.length && timingSafeEqual(given, expected)
  })
}
