import { Injectable } from '@nestjs/common'
import { authenticate, type DNSResolver } from 'mailauth'

/** What our own check of a raw message found. */
export interface SenderVerdict {
  /** DMARC passed: the From domain itself vouched for the message. */
  dmarcPass: boolean
  /** The addresses of its From header. */
  headerFrom: string[]
  /** How many To and Subject headers it has: a second one is how a signed message is replayed to another address. */
  toHeaders: number
  subjectHeaders: number
  /** The addresses in the To and Cc headers that a passing DKIM signature aligned with From covers (its h= tag). */
  signedRecipients: string[]
}

const NOT_PASSED: SenderVerdict = {
  dmarcPass: false,
  headerFrom: [],
  toHeaders: 0,
  subjectHeaders: 0,
  signedRecipients: [],
}

/** The addresses in a header line such as `To: Pat <pat@example.org>, lee@example.org`, lowercased. */
export function addressesIn(line: string): string[] {
  const value = line.slice(line.indexOf(':') + 1)
  return (value.match(/[^\s<>,;:"()[\]]+@[^\s<>,;:"()[\]]+/g) ?? []).map((a) => a.toLowerCase())
}

/** A DKIM result as mailauth returns it at runtime: the header lines a signature covers are not in its types. */
type SignatureResult = {
  status?: { result?: string; aligned?: string | false }
  signingHeaders?: { headers?: string[] }
}

/**
 * Our own check of an emailed receipt's sender, beside the provider's: SPF, DKIM and DMARC over the raw message with
 * `mailauth` (SPF reads the client address from the Received header the provider's server added, `trustReceived`).
 * Only a DMARC pass counts: it means the From domain itself vouched for the message. If the check cannot run, the
 * answer is "did not pass", never "passed". It also says which recipients the sender's own signature vouches for, so
 * a message signed for one address cannot be replayed to another.
 */
@Injectable()
export class SenderCheck {
  async verify(raw: Buffer, mta: string, resolver?: DNSResolver): Promise<SenderVerdict> {
    try {
      const r = await authenticate(raw, {
        trustReceived: true,
        mta,
        disableArc: true,
        disableBimi: true,
        ...(resolver && { resolver }),
      })
      const parsed = r.dkim?.headers?.parsed ?? []
      const signed = ((r.dkim?.results ?? []) as SignatureResult[])
        .filter((s) => s.status?.result === 'pass' && !!s.status.aligned)
        .flatMap((s) => s.signingHeaders?.headers ?? [])
        .filter((line) => /^\s*(to|cc)\s*:/i.test(line))
        .flatMap(addressesIn)
      return {
        dmarcPass: !!r.dmarc && r.dmarc.status?.result === 'pass',
        headerFrom: (r.dkim?.headerFrom ?? []).map((a) => a.toLowerCase()),
        toHeaders: parsed.filter((h) => h.key === 'to').length,
        subjectHeaders: parsed.filter((h) => h.key === 'subject').length,
        signedRecipients: [...new Set(signed)].sort(),
      }
    } catch {
      return NOT_PASSED
    }
  }
}
