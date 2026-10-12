import { useState } from 'react'
import { useClerk } from '@clerk/clerk-react'
import type { AcceptTermsRequest, Me } from '@ad/types'
import { useApi } from '@/hooks/useApi'
import { Mark } from '@/components/Mark'
import { SiteFooter } from '@/components/SiteFooter'
import { TermsBox } from '@/components/TermsBox'
import { termsGateCopy } from '@/components/termsGateCopy'
import { Button, ErrorNote } from '@/components/ui'

/**
 * Everyone accepts the Terms before anything else: at first sign-in, and again whenever their wording changes.
 * Shown instead of the app (no navigation) while GET /me says `termsAccepted` is false.
 */
export function TermsGate({ me, onAccepted }: { me: Me; onAccepted: () => Promise<void> }) {
  const api = useApi()
  const { signOut } = useClerk()
  const [readAll, setReadAll] = useState(false)
  const [accepted, setAccepted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const copy = termsGateCopy(me.termsPreviouslyAccepted)
  const accept = async (ev: React.FormEvent) => {
    ev.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const body: AcceptTermsRequest = { version: me.termsVersion }
      await api.post('/me/terms', body)
      await onAccepted()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }
  return (
    <div className="min-h-screen flex flex-col">
      <div className="ad-top">
        <header className="ad-wrap ad-header">
          <span className="ad-brand">
            <Mark />
            <span className="ad-wordmark">
              audit<span className="ad-slash">/</span>differently
            </span>
          </span>
        </header>
      </div>
      <main className="ad-wrap ad-main flex-1">
        <form onSubmit={accept} className="grid gap-4">
          <h1 className="text-xl font-semibold">{copy.heading}</h1>
          <p>{copy.intro}</p>
          <ErrorNote message={error} />
          <TermsBox onReadAll={() => setReadAll(true)} />
          {readAll ? (
            <p className="ad-terms-done">
              ✓ You have reached the end of the Terms &amp; Conditions.
            </p>
          ) : (
            <p className="ad-terms-scroll" role="status">
              ↓ Scroll to the bottom of the Terms &amp; Conditions to continue
            </p>
          )}
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={accepted}
              disabled={!readAll}
              onChange={(e) => setAccepted(e.target.checked)}
              required
            />
            <span>I have read and accept the Terms &amp; Conditions</span>
          </label>
          <div className="flex items-center gap-3">
            <Button type="submit" kind="primary" disabled={busy || !accepted}>
              Accept and continue
            </Button>
            <button type="button" className="text-sm underline" onClick={() => void signOut()}>
              Sign out
            </button>
          </div>
        </form>
      </main>
      <SiteFooter />
    </div>
  )
}
