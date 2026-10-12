/**
 * The links every visitor may need, signed in or not: what changed, how data is protected, who to write to.
 * Plain links on purpose: release notes, privacy and terms are static pages outside the app (apps/web/vite.config.ts),
 * so the privacy and terms pages open without signing in.
 */
export function SiteFooter() {
  return (
    <footer className="ad-wrap ad-footer">
      <span>audit/differently</span>
      <nav aria-label="Footer">
        <ul>
          <li>
            <a href="/release-notes/">Release notes</a>
          </li>
          <li>
            <a href="/privacy/">Privacy and Data Protection</a>
          </li>
          <li>
            <a href="/terms/">Terms</a>
          </li>
          <li>
            <a href="mailto:info@auditdifferently.tech">Contact</a>
          </li>
        </ul>
      </nav>
    </footer>
  )
}
