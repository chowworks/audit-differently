import { useEffect, useRef, useState } from 'react'

/**
 * The Terms, read in place. The text is the one on the static /terms/ page (docs/terms/index.html, the part
 * inside <section id="terms">), fetched from there so it is edited in one place. `onReadAll` fires once the
 * reader has scrolled to the end, or at once if the text fits without scrolling; if the page cannot be fetched
 * it shows a link instead and fires `onReadAll`, so a network hiccup does not lock anyone out.
 */
export function TermsBox({ onReadAll }: { onReadAll: () => void }) {
  const box = useRef<HTMLDivElement>(null)
  const [html, setHtml] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const fired = useRef(false)
  const fire = () => {
    if (fired.current) return
    fired.current = true
    onReadAll()
  }

  useEffect(() => {
    let live = true
    fetch('/terms/')
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((text) => {
        const section = new DOMParser().parseFromString(text, 'text/html').querySelector('#terms')
        if (!section) throw new Error('no terms section')
        if (live) setHtml(section.innerHTML)
      })
      .catch(() => {
        if (live) {
          setFailed(true)
          fire()
        }
      })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Short enough to fit without scrolling: nothing more to read.
  useEffect(() => {
    const el = box.current
    if (html && el && el.scrollHeight <= el.clientHeight + 4) fire()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html])

  if (failed)
    return (
      <p className="text-sm">
        The Terms & Conditions did not load here.{' '}
        <a href="/terms/" target="_blank" rel="noopener noreferrer">
          Read them in a new tab
        </a>{' '}
        before you accept.
      </p>
    )
  return (
    <div
      ref={box}
      className="ad-terms-box"
      tabIndex={0}
      role="region"
      aria-label="Terms and Conditions, scroll to read"
      onScroll={(e) => {
        const el = e.currentTarget
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 8) fire()
      }}
      // Our own static page, built from docs/terms/index.html: not user input.
      dangerouslySetInnerHTML={{ __html: html ?? '<p>Loading the Terms &amp; Conditions…</p>' }}
    />
  )
}
