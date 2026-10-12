type OriginCallback = (err: Error | null, allow?: boolean) => void

/** CORS origin check. FRONTEND_URL is a comma-separated list of browser origins. */
export function corsOrigin(frontendUrl: string | undefined) {
  const allowed = (frontendUrl ?? 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
  return (origin: string | undefined, callback: OriginCallback) => {
    // No Origin header: not a browser cross-origin request.
    if (!origin) return callback(null, true)
    callback(null, allowed.includes(origin))
  }
}
