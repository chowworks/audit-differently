import { useEffect, useState } from 'react'
import { API_URL } from '@/services/api'

/**
 * A small tag in the corner when this page's API is not production, so a preview or a test system can never
 * be mistaken for the real one. It asks the API itself (GET /api/health) which environment it is. Production,
 * a local API and any failure show nothing.
 */
export function EnvironmentBanner({ healthUrl = `${API_URL}/api/health` }: { healthUrl?: string }) {
  const [environment, setEnvironment] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch(healthUrl)
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { environment?: string } | null) => {
        const env = body?.environment
        if (!cancelled && env && env !== 'production' && env !== 'local') setEnvironment(env)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [healthUrl])

  if (!environment) return null
  return (
    <div
      role="status"
      title={`This page is talking to the ${environment} API, not production.`}
      className="fixed right-4 bottom-4 z-50 rounded-full border-2 border-white bg-orange-700 px-4 py-2 text-sm font-extrabold uppercase tracking-wider text-white shadow-lg pointer-events-none"
    >
      Test system · {environment} · not production
    </div>
  )
}
