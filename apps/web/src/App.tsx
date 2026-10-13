import { useEffect, type ReactNode } from 'react'
import { Link, Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom'
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
import { HomePage } from '@/home/HomePage'
import { ContactPage } from '@/pages/ContactPage'
import { NotFoundPage } from '@/pages/NotFoundPage'
import { Mark } from '@/components/Mark'
import { Button, Empty, ErrorNote } from '@/components/ui'

/** The app's own addresses: signed in, each renders its page; signed out, each asks for sign-in. */
const APP_ROUTES: { path: string; element: ReactNode }[] = [
  { path: '/overview', element: <OverviewPage /> },
  { path: '/workspaces', element: <WorkspacesPage /> },
  { path: '/workspaces/:id', element: <WorkspacePage /> },
  { path: '/engagements/new', element: <NewEngagementPage /> },
  { path: '/engagements/:id', element: <EngagementPage /> },
  { path: '/reports/:id', element: <ReportPage /> },
  { path: '/reports/:id/form', element: <ReportFormPage /> },
  // Older links.
  { path: '/contracts', element: <Navigate to="/workspaces" replace /> },
  { path: '/contracts/:id', element: <ToEngagement /> },
  { path: '/grants', element: <Navigate to="/workspaces" replace /> },
  { path: '/grants/:id', element: <ToEngagement /> },
]

export default function App() {
  const session = useSession()
  const { pathname } = useLocation()
  if (!session.ready) return <Empty>Loading…</Empty>
  // The public homepage is / for everyone, outside the app's frame; the app starts at /overview.
  if (pathname === '/') return <HomePage />
  if (pathname === '/home') return <Navigate to="/" replace />
  if (!session.signedIn) {
    return (
      <Routes>
        <Route
          path="/sign-in/*"
          element={
            <div className="min-h-screen flex flex-col">
              <div className="flex flex-1 items-center justify-center p-6">
                <SignIn routing="path" path="/sign-in" fallbackRedirectUrl="/overview" />
              </div>
              <SiteFooter />
            </div>
          }
        />
        <Route
          path="/contact"
          element={
            <PublicFrame>
              <ContactPage />
            </PublicFrame>
          }
        />
        {/* The app's own addresses ask for sign-in; anything else is not a page. */}
        {APP_ROUTES.map(({ path }) => (
          <Route key={path} path={path} element={<Navigate to="/sign-in" replace />} />
        ))}
        <Route
          path="*"
          element={
            <PublicFrame>
              <NotFoundPage />
            </PublicFrame>
          }
        />
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
          {APP_ROUTES.map(({ path, element }) => (
            <Route key={path} path={path} element={element} />
          ))}
          <Route path="/sign-in/*" element={<Navigate to="/overview" replace />} />
          <Route path="/contact" element={<ContactPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </Shell>
    </TermsVersionProvider>
  )
}

function ToEngagement() {
  const { id } = useParams()
  return <Navigate to={`/engagements/${id}`} replace />
}

/** The frame for public pages outside the app: the brand, the page, the footer. */
function PublicFrame({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col">
      <div className="ad-top">
        <header className="ad-wrap ad-header">
          <Link to="/" className="ad-brand">
            <Mark />
            <span className="ad-wordmark">
              audit<span className="ad-slash">/</span>differently
            </span>
          </Link>
        </header>
      </div>
      <main className="ad-wrap ad-main flex-1">{children}</main>
      <SiteFooter />
    </div>
  )
}
