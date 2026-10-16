/** Public status page (Better Stack), shared with the other Differently products. The badge is served from it. */
export const STATUS_PAGE_URL = 'https://status.learndifferently.tech'

/**
 * The links every visitor may need, signed in or not: what changed, how data is protected, who to write to.
 * Plain links on purpose: release notes, privacy and terms are static pages outside the app (apps/web/vite.config.ts),
 * so the privacy and terms pages open without signing in. Ends with the live status badge.
 */
export function SiteFooter() {
  return (
    <footer className="ad-wrap ad-footer">
      <a href="/" className="ad-footer-home">
        audit/differently
      </a>
      <div className="ad-footer-end">
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
              <a href="/contact">Contact</a>
            </li>
          </ul>
        </nav>
        {/* Fixed size, so the line lays out the same if the badge is blocked or slow. */}
        <iframe
          className="ad-footer-status"
          title="Audit Differently system status"
          src={`${STATUS_PAGE_URL}/badge?theme=light`}
          width={250}
          height={30}
          loading="lazy"
          scrolling="no"
          style={{ colorScheme: 'normal' }}
        />
      </div>
    </footer>
  )
}
