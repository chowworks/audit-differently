import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Mark } from '@/components/Mark'
import { SiteFooter } from '@/components/SiteFooter'
import { useSession } from '@/auth/session'
import './home.css'
import { HeroApp } from '@/home/HeroApp'
import { BooksGraphic } from '@/home/BooksGraphic'
import { AuditDayGraphic } from '@/home/AuditDayGraphic'
import { ChecksGraphic } from '@/home/ChecksGraphic'
import { SecurityGraphic } from '@/home/SecurityGraphic'
import { useCycle } from '@/home/motion'

/**
 * The public homepage, for anyone not signed in. Same tokens, header and components as the app, so the
 * page is the product's own voice. The film is the story; the sections after it are what the product does.
 * Motion is CSS only and stops for people who ask for reduced motion.
 */

/** Signed in, the way back into the app; signed out, the way in. */
function AppLink({ className }: { className: string }) {
  const { signedIn } = useSession()
  return (
    <Link to={signedIn ? '/overview' : '/sign-in'} className={className}>
      {signedIn ? 'Open the app' : 'Sign in'}
    </Link>
  )
}

export function HomePage() {
  // Animations wait until their section scrolls into view, so a visitor sees each one play.
  useEffect(() => {
    const els = document.querySelectorAll('[data-animate]')
    const seen = new IntersectionObserver(
      (entries) =>
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add('adh-inview')
            seen.unobserve(e.target)
          }
        }),
      { threshold: 0.35 }
    )
    els.forEach((el) => seen.observe(el))
    return () => seen.disconnect()
  }, [])
  return (
    <div className="adh">
      <div className="ad-top">
        <header className="ad-wrap ad-header">
          <a href="#top" className="ad-brand">
            <Mark />
            <span className="ad-wordmark">
              audit<span className="ad-slash">/</span>differently
            </span>
          </a>
          <nav aria-label="Main">
            <ul className="ad-nav">
              <li>
                <a href="#story">Watch</a>
              </li>
              <li>
                <a href="#how-it-works">How it works</a>
              </li>
              <li>
                <a href="#security">Security</a>
              </li>
            </ul>
          </nav>
          <div className="adh-head-actions">
            <AppLink className="adh-signin" />
          </div>
        </header>
      </div>

      <main id="top">
        <Hero />
        <Story />
        <Fits />
        <Checks />
        <AuditDay />
        <Security />
        <Closing />
      </main>
      <SiteFooter />
    </div>
  )
}

function Hero() {
  return (
    <section className="adh-hero">
      <div className="ad-wrap adh-hero-grid">
        <div>
          <p className="adh-eyebrow">For grant-funded organizations</p>
          <h1 className="adh-title">
            Always <span className="adh-underline">audit ready</span>.{' '}
            <span className="adh-title-2">Skip the scramble.</span>
          </h1>
          <p className="adh-lede">
            Audit Differently gives every grant and contract one consistent process, with its
            records, proof and participant files in one secure place. Proof is attached as the money
            is spent. Everything is checked and cross-checked automatically every month, and
            anything missing or wrong is flagged before an auditor sees it. The audit package builds
            as you go.
          </p>
          <div className="adh-ctas">
            <a href="#story" className="ad-btn adh-btn-lg">
              ▶ Watch the story
            </a>
            <Link to="/contact?topic=demo" className="ad-btn-secondary adh-btn-lg">
              Book a demo
            </Link>
          </div>
        </div>
        <HeroApp />
      </div>
    </section>
  )
}

/** The film's opening, replayed on the cover: the clock ticks to five, the email lands, the stamp. Loops. */
function VideoTeaser() {
  const { ref, step } = useCycle(9, 700, 2600)
  const seconds = Math.min(55 + step, 60)
  const time = seconds >= 60 ? '5:00:00 PM' : `4:59:${String(seconds).padStart(2, '0')} PM`
  return (
    <span className="adh-teaser" ref={ref} aria-hidden="true">
      <span className={`adh-clock ${seconds >= 60 ? 'adh-clock-hit' : ''}`}>{time}</span>
      <span className={`adh-mail ${step >= 6 ? 'adh-in' : ''}`}>
        <small>✉ Grant compliance office · 5:00 PM</small>
        <b>Federal monitoring review. Tomorrow, 9:00 AM.</b>
        <small>Bring all program and financial records for the award period.</small>
        <span className={`adh-stamp ${step >= 7 ? 'adh-in' : ''}`}>Surprise</span>
      </span>
    </span>
  )
}

/** The film: a cover until it is asked for, then the version that fits the screen. */
function Story() {
  const [playing, setPlaying] = useState(false)
  const [portrait, setPortrait] = useState(false)
  const video = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const query = window.matchMedia(
      '(max-width: 640px), (orientation: portrait) and (max-width: 900px)'
    )
    const update = () => setPortrait(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  useEffect(() => {
    if (playing) void video.current?.play().catch(() => undefined)
  }, [playing, portrait])
  const src = portrait ? '/video/audit-differently-9x16.mp4' : '/video/audit-differently-16x9.mp4'
  return (
    <section id="story" className="adh-story">
      <div className="ad-wrap">
        <p className="adh-eyebrow adh-on-dark">The story</p>
        <h2 className="adh-h2 adh-on-dark">Surprise grant funding audit. Tomorrow, 9 a.m.</h2>
        <div className={`adh-player ${portrait ? 'adh-player-tall' : ''}`}>
          {playing ? (
            <video
              key={src}
              ref={video}
              src={src}
              controls
              playsInline
              preload="auto"
              className="adh-video"
            ></video>
          ) : (
            <button type="button" className="adh-cover" onClick={() => setPlaying(true)}>
              <VideoTeaser />
              <span className="adh-cover-cta">
                <span className="adh-play" aria-hidden="true">
                  ▶
                </span>
                <span>
                  <span className="adh-cover-title">Watch the story</span>
                  <span className="adh-cover-sub">1:37 · sound on</span>
                </span>
              </span>
            </button>
          )}
        </div>
      </div>
    </section>
  )
}

function Checks() {
  return (
    <section className="adh-section">
      <div className="ad-wrap adh-two">
        <div>
          <p className="adh-eyebrow">Automated Verification Checks as you go</p>
          <h2 className="adh-h2">Caught before an auditor ever sees them.</h2>
          <p className="adh-text">
            Every month is checked and cross-checked automatically before the report goes in: proof
            against the ledger, splits across grants, payroll against hours, nothing charged twice.
            Each finding says what is wrong and which records it compared, so you fix it while the
            month is still open.
          </p>
        </div>
        <ChecksGraphic />
      </div>
    </section>
  )
}

/** Layers of protection drawn as nested frames, with the access log beside them. */
function Security() {
  return (
    <section id="security" className="adh-section adh-alt">
      <div className="ad-wrap adh-two">
        <div>
          <p className="adh-eyebrow">Security first</p>
          <h2 className="adh-h2">Private by default. Secure transmission. Every access logged.</h2>
          <p className="adh-text">
            Payroll, bank statements and participant files are the most sensitive records a program
            keeps, so they sit behind three layers, each on from the first upload: walled off to the
            people you invite, encrypted, and every open and download logged.
          </p>
          <p className="adh-text">
            Defense in depth: no single safeguard is trusted alone. If one ever slipped, the next
            still stands between your records and the wrong person.
          </p>
          <p className="adh-text adh-small">
            More on the <a href="/privacy/">Privacy and Data Protection</a> page.
          </p>
        </div>
        <SecurityGraphic />
      </div>
    </section>
  )
}

/** How it works, as one picture: bring it in, tracked, verified, shared when ready. */
function Fits() {
  return (
    <section id="how-it-works" className="adh-section adh-alt">
      <div className="ad-wrap adh-two adh-flip">
        <div>
          <p className="adh-eyebrow">Fits how you work</p>
          <h2 className="adh-h2">Alongside your books, not instead of them.</h2>
          <p className="adh-text">
            Keep your ledger where it lives. Bring a month in from your existing business records,
            attach the proof, and include what's relevant. You share proof, never your books.
          </p>
          <p className="adh-text">
            Audit Differently tracks what each grant needs, alerts you to what's missing and
            verifies the numbers against the proof. When you're ready, invite your auditor:
            read-only, with every data access or modification logged.
          </p>
        </div>
        <BooksGraphic />
      </div>
    </section>
  )
}

function AuditDay() {
  return (
    <section className="adh-section">
      <div className="ad-wrap adh-two adh-flip">
        <div>
          <p className="adh-eyebrow">Audit day</p>
          <h2 className="adh-h2">One click. Audit artifacts, ready for the auditor.</h2>
          <p className="adh-text">
            The package is built as you go, laid out the way funders lay out their own: each month
            with its signed report, ledger and proof, every participant's file, and an index. Invite
            your auditor in, read-only, and they pull what they need.
          </p>
        </div>
        <AuditDayGraphic />
      </div>
    </section>
  )
}

function Closing() {
  return (
    <section className="adh-closing">
      <div className="ad-wrap adh-closing-inner">
        <h2 className="adh-h2 adh-on-dark">
          Always audit ready.
          <span className="adh-title-2 adh-on-dark-soft">Ready before the auditor asks.</span>
        </h2>
        <p className="adh-text adh-on-dark-soft">
          A little progress, a lot less stress. Future you will thank you.
        </p>
        <div className="adh-ctas adh-center">
          <Link to="/contact?topic=demo" className="ad-btn adh-btn-lg">
            Book a demo
          </Link>
          <AppLink className="adh-btn-light adh-btn-lg" />
        </div>
      </div>
    </section>
  )
}
