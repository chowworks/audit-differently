import { Link } from 'react-router-dom'

/** "Need a hand?": a short, plain-words note for the bookkeeper, tied to where they are. Navy, like the header. */
export function HandCard({
  title = 'Need a hand?',
  icon = '?',
  lead,
  children,
  more,
}: {
  title?: string
  /** The sign in the yellow circle; "?" unless the card is about one thing (an envelope for email). */
  icon?: string
  /** The one-line takeaway, in bold. */
  lead: string
  children: React.ReactNode
  /** Where to read more, when there is somewhere. */
  more?: { label: string; href: string }
}) {
  return (
    <aside className="ad-hand" aria-label={title}>
      <div className="ad-hand-head">
        <span
          className={`ad-hand-icon ${icon === '?' ? '' : 'ad-hand-icon-emoji'}`}
          aria-hidden="true"
        >
          {icon}
        </span>
        <h3>{title}</h3>
      </div>
      <p>
        <b>{lead}</b>
      </p>
      {children}
      {more && (
        <Link to={more.href} className="ad-hand-more">
          {more.label} →
        </Link>
      )}
    </aside>
  )
}

/** The small encouragement beside the tiles. */
export function CheerCard({ lead, children }: { lead: string; children: React.ReactNode }) {
  return (
    <aside className="ad-cheer">
      <span className="ad-cheer-icon" aria-hidden="true">
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
        >
          <path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.3 1 2.1h5c0-.8.4-1.6 1-2.1A6 6 0 0 0 12 3z" />
        </svg>
      </span>
      <div>
        <b>{lead}</b>
        <span>{children}</span>
      </div>
    </aside>
  )
}
