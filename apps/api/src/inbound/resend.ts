import { Injectable } from '@nestjs/common'
import { inboundConfig } from './config'

/**
 * A received email as Resend's "Retrieve Received Email" returns it (GET /emails/receiving/{id};
 * resend.com/docs/api-reference/emails/retrieve-received-email), the fields this flow reads. `authentication` is what
 * Resend found for SPF, DKIM and DMARC, each 'pass' | 'fail' | 'gray' | 'processing_failed' | 'unknown', or null as a
 * whole for older emails; `raw.download_url` is a signed link to the original message.
 */
export interface ReceivedEmail {
  id: string
  from: string
  to: string[]
  subject: string | null
  created_at: string
  authentication: { spf?: string; dkim?: string; dmarc?: string } | null
  raw: { download_url: string; expires_at?: string } | null
  attachments?: ReceivedAttachmentMeta[]
}

export interface ReceivedAttachmentMeta {
  id: string
  filename: string | null
  content_type: string | null
  /** 'inline' for a picture in the email's body (a logo, a signature), else 'attachment'. */
  content_disposition?: string | null
  size: number | null
}

/** An attachment with its download link (GET /emails/receiving/{id}/attachments; the link lasts an hour). */
export interface ReceivedAttachment extends ReceivedAttachmentMeta {
  download_url: string
}

/** A failure talking to Resend: worth trying again later. */
export class ProviderError extends Error {
  override name = 'ProviderError'
}

/** The most one download may be: a raw message carries every attachment, base64 encoded. */
export const MAX_RAW_BYTES = 40 * 1024 * 1024

/**
 * Resend's inbound API, read only: the received email, its attachments and their bytes. Nothing here sends an email
 * (CLAUDE.md: no document leaves the system by email; the sender gets no reply).
 */
@Injectable()
export class ResendInbound {
  private async call<T>(path: string): Promise<T> {
    const cfg = inboundConfig()
    if (!cfg) throw new ProviderError('The email provider is not set up')
    const res = await fetch(`https://api.resend.com${path}`, {
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
    }).catch(() => null)
    if (!res?.ok) {
      // Resend names the error in its body (e.g. restricted_api_key for a sending-only key); never the key itself.
      const name = res
        ? await res
            .json()
            .then((b: { name?: unknown }) => (typeof b?.name === 'string' ? b.name : null))
            .catch(() => null)
        : null
      throw new ProviderError(
        `The email provider answered ${res?.status ?? 'nothing'}${name ? ` (${name.slice(0, 60)})` : ''}`
      )
    }
    return (await res.json()) as T
  }

  async email(id: string): Promise<ReceivedEmail> {
    return this.call<ReceivedEmail>(`/emails/receiving/${encodeURIComponent(id)}`)
  }

  async attachments(id: string): Promise<ReceivedAttachment[]> {
    const list = await this.call<{ data?: ReceivedAttachment[] }>(
      `/emails/receiving/${encodeURIComponent(id)}/attachments?limit=100`
    )
    return list.data ?? []
  }

  /** The bytes behind a signed link Resend gave, refused past `max` bytes (null: too large). */
  async download(url: string, max: number): Promise<Buffer | null> {
    if (!/^https:\/\//.test(url))
      throw new ProviderError('The email provider gave a link that is not https')
    const res = await fetch(url).catch(() => null)
    if (!res?.ok || !res.body)
      throw new ProviderError(`The email provider's download answered ${res?.status ?? 'nothing'}`)
    const declared = Number(res.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > max) {
      await res.body.cancel().catch(() => undefined)
      return null
    }
    const chunks: Buffer[] = []
    let size = 0
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > max) {
        await reader.cancel().catch(() => undefined)
        return null
      }
      chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks)
  }
}
