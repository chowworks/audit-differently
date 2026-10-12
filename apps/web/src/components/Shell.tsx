import { Link, NavLink, useLocation } from 'react-router-dom'
import { AccountMenu } from '@/components/AccountMenu'
import { Mark } from '@/components/Mark'
import { SiteFooter } from '@/components/SiteFooter'

/** Page frame: the wordmark, the navigation and the account menu, over the page. */
export function Shell({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation()
  // Engagements and their months belong to a workspace.
  const inWorkspace = ['/workspaces', '/engagements', '/reports'].some((p) =>
    pathname.startsWith(p)
  )
  return (
    <div>
      <div className="ad-top">
        <header className="ad-wrap ad-header">
          <Link to="/" className="ad-brand">
            <Mark />
            <span className="ad-wordmark">
              audit<span className="ad-slash">/</span>differently
            </span>
          </Link>
          <nav aria-label="Main">
            <ul className="ad-nav">
              <li>
                <NavLink to="/" end>
                  Overview
                </NavLink>
              </li>
              <li>
                <NavLink to="/workspaces" aria-current={inWorkspace ? 'page' : undefined}>
                  Manage workspaces
                </NavLink>
              </li>
            </ul>
          </nav>
          <AccountMenu />
        </header>
      </div>
      <main className="ad-wrap ad-main">{children}</main>
      <SiteFooter />
    </div>
  )
}
