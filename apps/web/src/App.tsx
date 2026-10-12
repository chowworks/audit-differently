import { useEffect } from 'react'
import { Navigate, Route, Routes, useParams } from 'react-router-dom'
import { SignIn, useClerk } from '@clerk/clerk-react'
import type { Me } from '@ad/types'
import { useLoad } from '@/hooks/useApi'
import { useSession } from '@/auth/session'
import { TermsVersionProvider } from '@/auth/me'
import { TermsGate } from '@/components/TermsGate'
import { TERMS_REQUIRED_EVENT } from '@/services/api'
import { Shell } from '@/components/Shell'
import { SiteFooter } from '@/components/SiteFooter'
import { OverviewPage } from '@/pages/OverviewPage'
import { WorkspacesPage } from '@/pages/WorkspacesPage'
import { WorkspacePage } from '@/pages/WorkspacePage'
import { EngagementPage } from '@/pages/EngagementPage'
import { NewEngagementPage } from '@/pages/NewEngagementPage'
import { ReportPage } from '@/pages/ReportPage'
import { ReportFormPage } from '@/pages/ReportFormPage'
import { Button, Empty, ErrorNote } from '@/components/ui'

export default function App() {
  const session = useSession()
  if (!session.ready) return <Empty>Loading…</Empty>
  if (!session.signedIn) {
    return (
      <Routes>
        <Route
          path="/sign-in/*"
          element={
            <div className="min-h-screen flex flex-col">
              <div className="flex flex-1 items-center justify-center p-6">
                <SignIn routing="path" path="/sign-in" fallbackRedirectUrl="/" />
              </div>
              <SiteFooter />
            </div>
          }
        />
        <Route path="*" element={<Navigate to="/sign-in" replace />} />
      </Routes>
    )
  }
  return <SignedIn />
}

/**
 * The first call after sign-in is GET /me: it creates the User row on first sight and, when an invitation left
 * a placeholder under this email, hands its memberships to this account. Pages render once that has happened,
 * so a brand-new person sees their workspace on the first load rather than an empty overview.
 */
function SignedIn() {
  const { data: me, error, reload } = useLoad<Me>('/me')
  const { signOut } = useClerk()
  const { displayName } = useSession()
  // The Terms changed while this tab was open: any call the API refused says so, and /me then shows the gate.
  useEffect(() => {
    const again = () => void reload()
    window.addEventListener(TERMS_REQUIRED_EVENT, again)
    return () => window.removeEventListener(TERMS_REQUIRED_EVENT, again)
  }, [reload])
  if (error) return <ErrorNote message={error} />
  if (!me) return <Empty>Loading…</Empty>
  if (!me.termsAccepted) return <TermsGate me={me} onAccepted={reload} />
  if (me.memberships.length === 0)
    return (
      <div className="ad-wrap ad-main">
        <div className="ad-empty">
          <p className="font-semibold">You are not in a workspace yet.</p>
          <p className="mt-1">
            Ask the owner of your team's workspace to invite {displayName || 'you'}; the invitation
            uses the email you signed in with.
          </p>
          <div className="mt-3">
            <Button size="sm" onClick={() => void signOut()}>
              Sign out
            </Button>
          </div>
        </div>
      </div>
    )
  return (
    <TermsVersionProvider value={me.termsVersion}>
      <Shell>
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/sign-in/*" element={<Navigate to="/" replace />} />
          <Route path="/workspaces" element={<WorkspacesPage />} />
          <Route path="/workspaces/:id" element={<WorkspacePage />} />
          <Route path="/engagements/new" element={<NewEngagementPage />} />
          <Route path="/engagements/:id" element={<EngagementPage />} />
          <Route path="/reports/:id" element={<ReportPage />} />
          <Route path="/reports/:id/form" element={<ReportFormPage />} />
          {/* Older links. */}
          <Route path="/contracts" element={<Navigate to="/workspaces" replace />} />
          <Route path="/contracts/:id" element={<ToEngagement />} />
          <Route path="/grants" element={<Navigate to="/workspaces" replace />} />
          <Route path="/grants/:id" element={<ToEngagement />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Shell>
    </TermsVersionProvider>
  )
}

function ToEngagement() {
  const { id } = useParams()
  return <Navigate to={`/engagements/${id}`} replace />
}
