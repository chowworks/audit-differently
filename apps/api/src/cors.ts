type OriginCallback = (err: Error | null, allow?: boolean) => void

/**
 * The web app's addresses, from FRONTEND_URL: comma-separated, each an exact address, or one with a `*` in its first
 * label for Vercel's per-branch previews, e.g. `https://audit-differently-git-*-ludakhris-projects.vercel.app`. The `*`
 * stands for letters, digits and hyphens only, so it never reaches past a dot into another domain. Only dev lists a
 * pattern; production refuses one (startup-checks.ts). Throws on a `*` anywhere else.
 */
export function frontendOrigins(frontendUrl: string | undefined): (string | RegExp)[] {
  return (frontendUrl ?? 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
    .map((o) => {
      if (!o.includes('*')) return o
      const m = /^(https:\/\/)([^./]*\*[^./]*)(\.[^/*]+)$/.exec(o)
      if (!m)
        throw new Error(
          `FRONTEND_URL: a * may only stand in the first part of an https address: ${o}`
        )
      const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const label = m[2].split('*').map(escape).join('[a-z0-9-]+')
      return new RegExp(`^${escape(m[1])}${label}${escape(m[3])}$`)
    })
}

/** A check of a browser origin against FRONTEND_URL's addresses and patterns (frontendOrigins). */
export function frontendOriginCheck(frontendUrl: string | undefined): (origin: string) => boolean {
  const allowed = frontendOrigins(frontendUrl)
  return (origin) => allowed.some((o) => (typeof o === 'string' ? o === origin : o.test(origin)))
}

/** CORS origin check, against FRONTEND_URL. */
export function corsOrigin(frontendUrl: string | undefined) {
  const allowed = frontendOriginCheck(frontendUrl)
  return (origin: string | undefined, callback: OriginCallback) => {
    // No Origin header: not a browser cross-origin request.
    if (!origin) return callback(null, true)
    callback(null, allowed(origin))
  }
}
