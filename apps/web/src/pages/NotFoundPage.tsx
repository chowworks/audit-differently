import { Link, useLocation } from 'react-router-dom'
import { useSession } from '@/auth/session'
import './not-found.css'

/** Any address the app does not know, signed in or out (App.tsx routes it in both trees). */
export function NotFoundPage() {
  const { pathname } = useLocation()
  const { signedIn } = useSession()
  return (
    <div className="ad-notfound">
      <p className="ad-notfound-code ad-mono" aria-hidden="true">
        404
      </p>
      <h1 className="ad-h1">This page isn't on file.</h1>
      <p className="ad-sub">
        Nothing is missing from your records, only this address. It may have moved, or the link has
        a typo.
      </p>
      <p className="ad-notfound-finding">
        <span className="ad-chip ad-chip-danger">Finding</span>
        <span className="ad-mono">{pathname}</span>
        <span>no page at this address</span>
      </p>
      <div className="ad-notfound-actions">
        {signedIn ? (
          <Link to="/overview" className="ad-btn">
            Back to the overview
          </Link>
        ) : (
          <Link to="/" className="ad-btn">
            Go to the homepage
          </Link>
        )}
        <Link
          to={`/contact?topic=broken-link&page=${encodeURIComponent(pathname)}`}
          className="ad-btn-secondary"
        >
          Tell us what you were looking for
        </Link>
      </div>
    </div>
  )
}
