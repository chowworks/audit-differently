import { Link, NavLink, useLocation } from 'react-router-dom'
import { AccountMenu } from '@/components/AccountMenu'
import { Mark } from '@/components/Mark'
import { SiteFooter } from '@/components/SiteFooter'

/**
 * Page frame: the wordmark, the navigation and the account menu, over the page. `adminOnly` is a platform admin in
 * no workspace: Admin tools is all there is (reached from the account menu).
 */
export function Shell({ children, adminOnly }: { children: React.ReactNode; adminOnly?: boolean }) {
  const { pathname } = useLocation()
  // Engagements and their months belong to a workspace.
  const inWorkspace = ['/workspaces', '/engagements', '/reports'].some((p) =>
    pathname.startsWith(p)
  )
  return (
    <div>
      <div className="ad-top">
        <header className="ad-wrap ad-header">
          <Link to={adminOnly ? '/admin' : '/overview'} className="ad-brand">
            <Mark />
            <span className="ad-wordmark">
              audit<span className="ad-slash">/</span>differently
            </span>
          </Link>
          <nav aria-label="Main">
            {/* Not rendered at all for an admin in no workspace: `hidden` would lose to .ad-nav's display. */}
            {!adminOnly && (
              <ul className="ad-nav">
                <li>
                  <NavLink to="/overview" end>
                    Overview
                  </NavLink>
                </li>
                <li>
                  <NavLink to="/workspaces" aria-current={inWorkspace ? 'page' : undefined}>
                    Workspace Manager
                  </NavLink>
                </li>
              </ul>
            )}
          </nav>
          <AccountMenu />
        </header>
      </div>
      <main className="ad-wrap ad-main">{children}</main>
      <SiteFooter />
    </div>
  )
}
