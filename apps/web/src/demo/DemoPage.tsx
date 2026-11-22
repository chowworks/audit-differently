import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Mark } from '@/components/Mark'
import { SiteFooter } from '@/components/SiteFooter'
import { DemoGate, isUnlocked } from './DemoGate'
import { FUNDER, GRANT, ORG, PEOPLE, type PersonKey } from './data'
import {
  AuditScene,
  BudgetScene,
  ForecastScene,
  GuardrailScene,
  MatchScene,
  ReadinessScene,
  SignScene,
  UploadScene,
} from './scenes'
import './demo.css'

/**
 * The public interactive demo (/demo): marketing, not the app. A visitor leaves their name and work email on
 * the gate (sent to the team as a contact message), then walks one fictional month at a fictional training
 * provider, click by click. Nothing here reads or writes app data. `?step=N` opens the tour at step N.
 */

interface Step {
  key: string
  who: PersonKey
  when: string
  title: string
  story: string
  prop: string
  Scene: () => JSX.Element
}

const STEPS: Step[] = [
  {
    key: 'budget',
    who: 'books',
    when: 'July 1 · award starts',
    title: 'Set up the approved budget once',
    story:
      'Marcus enters the seven budget lines from the contract. From here on, every dollar spent is held against one of them.',
    prop: 'Accountable from day one',
    Scene: BudgetScene,
  },
  {
    key: 'upload',
    who: 'books',
    when: 'Dec 1 · 9:00 AM',
    title: 'You do your books. Upload the reports.',
    story:
      'Marcus keeps working in QuickBooks and the payroll service. At month end he drops in what they already produce.',
    prop: 'No new system to keep',
    Scene: UploadScene,
  },
  {
    key: 'match',
    who: 'books',
    when: 'Dec 1 · 9:01 AM',
    title: 'Every expense finds its proof',
    story:
      'Receipts, invoices, timesheets and bank lines are matched to the books, line by line. What doesn’t agree is flagged.',
    prop: 'More accurate, in less time',
    Scene: MatchScene,
  },
  {
    key: 'guardrail',
    who: 'books',
    when: 'Dec 1 · 9:03 AM',
    title: 'Unallowable costs stop at the door',
    story:
      'Every charge is checked against the federal cost principles. A staff party or a late fee never reaches the funder’s report.',
    prop: 'Allowable-cost guardrail',
    Scene: GuardrailScene,
  },
  {
    key: 'forecast',
    who: 'ceo',
    when: 'Dec 1 · 9:30 AM',
    title: 'See where the money will land',
    story:
      'Angela sees each line’s share spent against the share of the year gone, and where it lands in June at this pace.',
    prop: 'Forecasting',
    Scene: ForecastScene,
  },
  {
    key: 'readiness',
    who: 'books',
    when: 'Dec 1 · 10:00 AM',
    title: 'Know how audit-ready you are, today',
    story:
      'One number, and the short list of what stands between this month and a clean audit. Marcus clears it before lunch.',
    prop: 'Audit-ready, all in one place',
    Scene: ReadinessScene,
  },
  {
    key: 'sign',
    who: 'ceo',
    when: 'Dec 2 · 4:12 PM',
    title: 'Approve and submit in one screen',
    story:
      'Angela reads November in one screen, approves the month-end closing, and the signed report goes to the funder early.',
    prop: 'Confidence before you sign',
    Scene: SignScene,
  },
  {
    key: 'audit',
    who: 'monitor',
    when: 'March · monitoring review',
    title: 'The auditor asks. It’s already built.',
    story:
      'The funder’s monitor asks for five months of records. The package was built as the money was spent.',
    prop: 'Skip the scramble',
    Scene: AuditScene,
  },
]

const PROPS = [
  {
    icon: '🧭',
    title: 'Accountable from the start',
    text: 'Every dollar is held against an approved budget line from day one, with its proof beside it.',
  },
  {
    icon: '📈',
    title: 'Forecasting',
    text: 'See the share of each line spent, and whether it is on track or heading over, months before it is.',
  },
  {
    icon: '🗂',
    title: 'Audit-ready, in one place',
    text: 'Records, proof, payroll and participant files together, and one number that says how ready you are.',
  },
  {
    icon: '⏱',
    title: 'Less time, more accuracy',
    text: 'Upload what your books and payroll already produce. The matching and checking happen for you.',
  },
  {
    icon: '🛡',
    title: 'An allowable-cost guardrail',
    text: 'Charges the federal cost principles don’t allow are caught before they reach a report.',
  },
]

function Avatar({ who, size = 44 }: { who: PersonKey; size?: number }) {
  const p = PEOPLE[who]
  return (
    <span
      className={`addm-avatar addm-avatar-${p.tone}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {p.initials}
    </span>
  )
}

function Header() {
  return (
    <div className="ad-top">
      <header className="ad-wrap ad-header">
        <Link to="/" className="ad-brand">
          <Mark />
          <span className="ad-wordmark">
            audit<span className="ad-slash">/</span>differently
          </span>
        </Link>
        <span className="addm-head-tag">Interactive demo · sample data</span>
        <Link to="/contact?topic=demo" className="addm-head-cta">
          Book a walkthrough
        </Link>
      </header>
    </div>
  )
}

export function DemoPage() {
  const [unlocked, setUnlocked] = useState(isUnlocked)
  const [params, setParams] = useSearchParams()
  const n = Number(params.get('step'))
  const step = Number.isInteger(n) && n >= 1 && n <= STEPS.length ? n : 0
  const go = (to: number) => {
    const next = new URLSearchParams(params)
    if (to) next.set('step', String(to))
    else next.delete('step')
    setParams(next)
  }
  useEffect(() => window.scrollTo({ top: 0 }), [step, unlocked])
  return (
    <div className="addm">
      <Header />
      <main>
        {!unlocked ? (
          <DemoGate onUnlock={() => setUnlocked(true)} />
        ) : step ? (
          <Tour step={step} go={go} />
        ) : (
          <Landing go={go} />
        )}
      </main>
      <SiteFooter />
    </div>
  )
}

// ── The landing page ────────────────────────────────────────────────────────

function Landing({ go }: { go: (n: number) => void }) {
  return (
    <>
      <section className="addm-hero">
        <div className="ad-wrap addm-hero-grid">
          <div>
            <p className="addm-eyebrow">
              {ORG} · {GRANT}
            </p>
            <h1 className="addm-title">
              You do your books. Upload the reports.{' '}
              <span className="addm-title-2">The magic happens.</span>
            </h1>
            <p className="addm-lede">
              Follow one month at a fictional training provider funded by the {FUNDER}: from the
              approved budget to the auditor’s request, click by click.
            </p>
            <div className="addm-ctas">
              <button type="button" className="addm-btn addm-btn-lg" onClick={() => go(1)}>
                ▶ Start the tour
              </button>
              <button type="button" className="addm-btn-ghost addm-btn-lg" onClick={() => go(5)}>
                Jump to forecasting
              </button>
            </div>
            <p className="addm-small">
              Sample data. Every person, organization and amount is fictional.
            </p>
          </div>
          <HeroCycle go={go} />
        </div>
      </section>

      <section className="addm-insight">
        <div className="ad-wrap addm-insight-grid">
          <div>
            <p className="addm-eyebrow addm-eyebrow-light">The problem</p>
            <h2>
              Well-run teams still find out how audit-ready they are <em>in the room</em>.
            </h2>
            <p>
              They already use QuickBooks, a receipts app and a payroll service. The books balance.
              But the proof lives in five places, nobody checks it against the books every month,
              and the first person to put it all together is the auditor.
            </p>
          </div>
          <div className="addm-stats">
            <div>
              <b>1 in 6</b>
              <small>nonprofit single audits for 2024 reported at least one finding</small>
            </div>
            <div>
              <b>4 of 5</b>
              <small>
                participant files in one state’s WIOA monitoring sample lacked eligibility proof.
                The costs were disallowed.
              </small>
            </div>
          </div>
        </div>
        <p className="ad-wrap addm-source">
          Sources: AuditRadar analysis of Federal Audit Clearinghouse filings, audit year 2024
          (16.2% of 22,398); Washington ESD, PY24 WIOA monitoring report of one local board
          (Dislocated Worker files).
        </p>
      </section>

      <section className="addm-section">
        <div className="ad-wrap">
          <p className="addm-eyebrow">Meet the team</p>
          <h2 className="addm-h2">Two people, one month, three grants</h2>
          <div className="addm-people">
            <Persona
              who="books"
              before="Keys the month into QuickBooks, then spends days pulling receipts, timesheets and bank lines into folders for the report."
              after="Uploads the month’s reports. Fixes the short list of flags. Done before lunch."
            />
            <Persona
              who="ceo"
              before="Signs the monthly report on trust, and learns a line ran over when the funder says so."
              after="Sees every line’s pace and proof before she signs, and asks for a budget change early."
            />
          </div>
        </div>
      </section>

      <section className="addm-section addm-section-alt">
        <div className="ad-wrap">
          <p className="addm-eyebrow">How a month runs</p>
          <h2 className="addm-h2">Eight steps, click any one</h2>
          <ol className="addm-steps">
            {STEPS.map((s, i) => (
              <li key={s.key}>
                <button type="button" onClick={() => go(i + 1)}>
                  <span className="addm-step-n">{i + 1}</span>
                  <span>
                    <small>
                      {PEOPLE[s.who].name} · {s.when}
                    </small>
                    <b>{s.title}</b>
                  </span>
                  <span className="addm-step-prop">{s.prop}</span>
                </button>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="addm-section">
        <div className="ad-wrap">
          <p className="addm-eyebrow">What it delivers</p>
          <h2 className="addm-h2">Auditable from the first dollar</h2>
          <div className="addm-props">
            {PROPS.map((p) => (
              <div key={p.title} className="addm-prop">
                <span>{p.icon}</span>
                <b>{p.title}</b>
                <small>{p.text}</small>
              </div>
            ))}
          </div>
        </div>
      </section>

      <Closing go={go} />
    </>
  )
}

function Persona({ who, before, after }: { who: PersonKey; before: string; after: string }) {
  const p = PEOPLE[who]
  return (
    <div className="addm-person">
      <div className="addm-person-head">
        <Avatar who={who} size={52} />
        <span>
          <b>{p.name}</b>
          <small>
            {p.role}, {ORG}
          </small>
        </span>
      </div>
      <p className="addm-before">
        <span>Today</span>
        {before}
      </p>
      <p className="addm-after">
        <span>With Audit Differently</span>
        {after}
      </p>
    </div>
  )
}

/** The hero's loop: the month's steps around the month's record, lighting up one after another. */
function HeroCycle({ go }: { go: (n: number) => void }) {
  const [lit, setLit] = useState(0)
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const t = window.setInterval(() => setLit((l) => (l + 1) % STEPS.length), 1400)
    return () => window.clearInterval(t)
  }, [])
  return (
    <div className="addm-cycle" aria-label="The month, step by step">
      <div className="addm-cycle-core">
        <b>November</b>
        <small>one record, its proof beside it</small>
      </div>
      {STEPS.map((s, i) => {
        const a = (i / STEPS.length) * 2 * Math.PI - Math.PI / 2
        return (
          <button
            key={s.key}
            type="button"
            className={`addm-cycle-node ${lit === i ? 'addm-lit' : ''}`}
            style={{ left: `${50 + 40 * Math.cos(a)}%`, top: `${50 + 40 * Math.sin(a)}%` }}
            onClick={() => go(i + 1)}
          >
            <span>{i + 1}</span>
            {s.prop}
          </button>
        )
      })}
    </div>
  )
}

function Closing({ go }: { go: (n: number) => void }) {
  return (
    <section className="addm-closing">
      <div className="ad-wrap">
        <h2>See it with your own books</h2>
        <p>We’ll walk your team through a month with your own grant’s budget and reports.</p>
        <div className="addm-ctas addm-center">
          <Link to="/contact?topic=demo" className="addm-btn addm-btn-lg addm-btn-bright">
            Book a walkthrough
          </Link>
          <button
            type="button"
            className="addm-btn-ghost addm-btn-lg addm-on-dark"
            onClick={() => go(1)}
          >
            Replay the tour
          </button>
        </div>
      </div>
    </section>
  )
}

// ── The tour ────────────────────────────────────────────────────────────────

function Tour({ step, go }: { step: number; go: (n: number) => void }) {
  const s = STEPS[step - 1]
  const last = step === STEPS.length
  return (
    <section className="addm-tour">
      <div className="ad-wrap addm-tour-grid">
        <nav className="addm-rail" aria-label="Tour steps">
          <button type="button" className="addm-rail-back" onClick={() => go(0)}>
            ← Demo home
          </button>
          <ol>
            {STEPS.map((t, i) => (
              <li key={t.key}>
                <button
                  type="button"
                  className={`${i + 1 === step ? 'addm-rail-on' : ''} ${i + 1 < step ? 'addm-rail-done' : ''}`}
                  onClick={() => go(i + 1)}
                  aria-current={i + 1 === step ? 'step' : undefined}
                >
                  <span>{i + 1 < step ? '✓' : i + 1}</span>
                  {t.prop}
                </button>
              </li>
            ))}
          </ol>
        </nav>
        <div className="addm-stage" key={s.key}>
          <div className="addm-narrate">
            <Avatar who={s.who} />
            <div>
              <small>
                Step {step} of {STEPS.length} · {PEOPLE[s.who].name}, {PEOPLE[s.who].role} ·{' '}
                {s.when}
              </small>
              <h1>{s.title}</h1>
              <p>{s.story}</p>
            </div>
          </div>
          <div className="addm-scene">
            <s.Scene />
          </div>
          <div className="addm-tour-foot">
            <button type="button" className="addm-btn-ghost" onClick={() => go(step - 1)}>
              {step === 1 ? '← Demo home' : '← Back'}
            </button>
            {last ? (
              <Link to="/contact?topic=demo" className="addm-btn">
                Book a walkthrough →
              </Link>
            ) : (
              <button type="button" className="addm-btn" onClick={() => go(step + 1)}>
                Next: {STEPS[step].prop} →
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}
