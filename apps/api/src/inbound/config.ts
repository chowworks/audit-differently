/**
 * Email in receipts is on only when the email provider is set up: Resend's receiving key (RESEND_RECEIVING_API_KEY, a Full access key, to fetch a received email; the contact
 * form keeps its own sending-only RESEND_API_KEY), the
 * webhook's signing secret, and the domain the receipts addresses are on. With any of them missing the webhook answers
 * 404 and the worker never starts, so the feature is off and harmless (startup-checks.ts refuses a Railway environment
 * that sets only some of them).
 */
export interface InboundConfig {
  apiKey: string
  webhookSecret: string
  /** The receipts subdomain, lowercased, e.g. receipts.example.org (never hard-coded). */
  domain: string
}

export function inboundConfig(env: NodeJS.ProcessEnv = process.env): InboundConfig | null {
  const apiKey = env.RESEND_RECEIVING_API_KEY?.trim()
  const webhookSecret = env.RESEND_WEBHOOK_SECRET?.trim()
  const domain = env.RECEIPTS_DOMAIN?.trim().toLowerCase()
  if (!apiKey || !webhookSecret || !domain) return null
  return { apiKey, webhookSecret, domain }
}

/** The domain receipts addresses are on, when set, to show `<local part>@<domain>`. */
export const receiptsDomain = (env: NodeJS.ProcessEnv = process.env): string | null =>
  env.RECEIPTS_DOMAIN?.trim().toLowerCase() || null

/** The full receipts address, when the local part and this environment's receipts domain are both set. */
export const receiptsEmail = (local: string | null) => {
  const domain = receiptsDomain()
  return local && domain ? `${local}@${domain}` : null
}
