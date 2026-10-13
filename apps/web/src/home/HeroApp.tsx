/**
 * The homepage hero graphic: the app at work on one engagement, on a loop. The checks tick, readiness climbs,
 * a missing proof arrives, a receipt that doesn't match the ledger gets corrected, the hours match, and the
 * audit package is ready.
 */
import { useCycle, useFit } from './motion'
import './hero-app.css'

/** The graphic is drawn at this width and scaled to fit. */
const DESIGN_WIDTH = 560

const CHECKS = [
  'Proposal',
  'Award letter',
  'Narrative',
  'Contract',
  'Participants',
  'Months',
  'Reports',
  'Package',
]

/** The app, working: the loop on the homepage. */
export function HeroApp() {
  const { ref, step } = useCycle(14, 520, 3400)
  const ready = Math.round(58 + (Math.min(step, 11) / 11) * 42)
  const proof = step >= 5
  const matched = step >= 7
  const fit = useFit(DESIGN_WIDTH)
  return (
    <div className="hv-fit" ref={fit.ref}>
      <div
        className="hv-app"
        ref={ref}
        aria-hidden="true"
        style={{ width: DESIGN_WIDTH, zoom: fit.scale }}
      >
        <Bar />
        <div className="hv-app-body">
          <div className="hv-app-side">
            <div className="hv-app-kicker">In-School Youth Coding Pathway</div>
            <ul>
              {CHECKS.map((c, i) => (
                <li key={c} className={i < step ? 'hv-on' : ''}>
                  <i />
                  {c}
                </li>
              ))}
            </ul>
          </div>
          <div className="hv-app-main">
            <Readiness value={ready} />
            <div className="hv-app-row hv-app-row-2">
              <span>Classroom rent</span>
              <span className="hv-mono">{matched ? '$612.40' : '$600.00'}</span>
              <Chip fixed={proof} bad="Proof missing" good="✓ Proof" />
              <span className={`hv-mono hv-cmp ${proof ? 'hv-in' : ''} ${matched ? 'hv-ok' : ''}`}>
                Receipt $612.40 {matched ? '=' : '≠'} Ledger {matched ? '$612.40' : '$600.00'}
              </span>
            </div>
            <Row
              label="Instructor payroll"
              value="80 h"
              fixed={step >= 9}
              bad="Timesheet missing"
              good="✓ Hours match"
            />
            <div className={`hv-app-cta ${step >= 11 ? 'hv-on' : ''}`}>
              ⬇ Download audit package
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function Bar() {
  return (
    <div className="hv-app-bar">
      <span />
      <span />
      <span />
      <b>audit/differently</b>
    </div>
  )
}

function Readiness({ value }: { value: number }) {
  return (
    <div className="hv-app-ready">
      <div className="hv-app-label">Audit readiness</div>
      <div className="hv-app-num">{value}%</div>
      <div className="hv-app-bar2">
        <i style={{ width: `${value}%` }} />
      </div>
    </div>
  )
}

function Row(props: { label: string; value: string; fixed: boolean; bad: string; good: string }) {
  return (
    <div className="hv-app-row">
      <span>{props.label}</span>
      <span className="hv-mono">{props.value}</span>
      <Chip fixed={props.fixed} bad={props.bad} good={props.good} />
    </div>
  )
}

function Chip({ fixed, bad, good }: { fixed: boolean; bad: string; good: string }) {
  return (
    <em className={`hv-chip ${fixed ? 'hv-chip-good' : 'hv-chip-bad'}`}>{fixed ? good : bad}</em>
  )
}
