import { Link, useLocation, useSearchParams } from 'react-router-dom'

/*
 * DESIGN EXPERIMENT (review only, delete when the owner chooses): two taglines behind ?tagline=a|b, with a pill at
 * the bottom left to flip between them. Delete this file, its CSS block in demo.css and the two <Tagline /> call
 * sites' switch when one is picked.
 */

const LINES = {
  a: { lead: 'Every dollar, accounted for. Every grant, on track.', end: 'Always audit-ready.' },
  b: {
    lead: 'Every dollar, accounted for. Every grant, on track.',
    end: 'Audit-ready when the auditor walks in.',
  },
}
type Key = keyof typeof LINES

function useTagline(): Key {
  const [params] = useSearchParams()
  return params.get('tagline') === 'b' ? 'b' : 'a'
}

/** The headline: the lead in ink, the ending in the highlight (`endClass`). */
export function Tagline({ endClass }: { endClass?: string }) {
  const t = LINES[useTagline()]
  return (
    <>
      {t.lead} <span className={endClass}>{t.end}</span>
    </>
  )
}

export function TaglineSwitch() {
  const current = useTagline()
  const [params] = useSearchParams()
  const { pathname } = useLocation()
  const href = (k: Key) => {
    const next = new URLSearchParams(params)
    next.set('tagline', k)
    return `${pathname}?${next}`
  }
  return (
    <nav className="addm-review" aria-label="Review: tagline">
      <span>Tagline</span>
      {(Object.keys(LINES) as Key[]).map((k) => (
        <Link key={k} to={href(k)} className={k === current ? 'addm-review-on' : ''}>
          {k.toUpperCase()}
        </Link>
      ))}
    </nav>
  )
}
