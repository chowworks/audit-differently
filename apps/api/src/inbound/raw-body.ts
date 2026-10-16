/** The most a webhook call may carry: Resend's `email.received` holds metadata only, no body and no files. */
export const WEBHOOK_MAX_BYTES = 256 * 1024

type Req = NodeJS.ReadableStream & { body?: unknown; headers: Record<string, unknown> }

/**
 * Keeps the request body as the exact bytes it arrived as, for the one route whose signature covers them
 * (POST /api/inbound/resend, main.ts). Mounted before Nest's JSON parser, which then finds the body read and skips it;
 * every other route keeps the usual parser.
 */
export function rawBody(limit = WEBHOOK_MAX_BYTES) {
  return (req: Req, _res: unknown, next: (err?: unknown) => void): void => {
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    const finish = (err?: unknown) => {
      if (done) return
      done = true
      if (!err) req.body = Buffer.concat(chunks)
      next(err)
    }
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        // Answered by Express's own handler, which reads `status`: 413 and no body parsed.
        finish(Object.assign(new Error('Payload too large'), { status: 413, expose: true }))
        return
      }
      if (!done) chunks.push(chunk)
    })
    req.on('end', () => finish())
    req.on('error', (e) => finish(e))
  }
}
