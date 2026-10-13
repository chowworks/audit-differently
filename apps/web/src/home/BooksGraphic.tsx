/**
 * The "Around your books" graphic: scattered records (emails, receipts, statements, spreadsheets, notes) fly into
 * Audit Differently, and the four stages on the right fill in: brought in, tracked, verified, shared. Then "Audit
 * ready", a hold, and it loops. Drawn at one width and scaled to fit, so every screen sees the same picture. Its
 * pieces (the pile, the engine, the stages) are the template for the page's other graphics.
 */
import { useCycle, useFit } from './motion'
import './books-graphic.css'

/**
 * H's pile: the mess as it really looks. Each item has a kind (its card style), an emoji, a label, a tilt and
 * a place. `flies` is the index of the record it becomes in "Brought in"; the others are noise that fades once
 * everything is tracked.
 */
type Mess = {
  kind: string
  emoji: string
  label: string
  sub?: string
  r: number
  x: number
  y: number
  flies?: number
}
const MESS: Mess[] = [
  { kind: 'email', emoji: '📧', label: 'RE: RE: receipts??', sub: 'from Dana', r: -6, x: 4, y: 3 },
  { kind: 'note', emoji: '🟨', label: 'find Aug receipt!!', r: 8, x: 50, y: 1 },
  { kind: 'sheet', emoji: '📊', label: 'budget_tracker_REAL.xlsx', r: 4, x: 6, y: 15, flies: 0 },
  { kind: 'receipt', emoji: '🧾', label: 'Staples · $84.17', r: -10, x: 34, y: 27, flies: 1 },
  {
    kind: 'bank',
    emoji: '🏦',
    label: 'Bank stmt · Aug',
    sub: 'acct ••4471',
    r: 7,
    x: 4,
    y: 38,
    flies: 2,
  },
  { kind: 'email', emoji: '📧', label: 'Fwd: timesheets', sub: 'from Sam', r: -4, x: 28, y: 50 },
  { kind: 'photo', emoji: '📷', label: 'IMG_2041.jpg', r: -8, x: 2, y: 61 },
  { kind: 'sheet', emoji: '📊', label: 'timesheets_FINAL_v3.xlsx', r: 5, x: 12, y: 71, flies: 3 },
  { kind: 'receipt', emoji: '📄', label: 'payroll_reg (2).pdf', r: -3, x: 4, y: 83, flies: 4 },
  { kind: 'note', emoji: '🟨', label: '???', r: 12, x: 66, y: 86 },
]

function Engine({ busy, small, status }: { busy: boolean; small?: boolean; status?: string }) {
  return (
    <div className={`fx-engine ${busy ? 'fx-busy' : ''} ${small ? 'fx-engine-sm' : ''}`}>
      <svg viewBox="0 0 40 40" width={small ? 34 : 44} height={small ? 34 : 44}>
        <path
          d="M10 4h20v30l-3.3-2.6-3.4 2.6-3.3-2.6-3.3 2.6-3.4-2.6L10 34z"
          className="fv-mk-body"
          strokeWidth="3"
          strokeLinejoin="round"
        />
        <line
          x1="15"
          y1="12"
          x2="25"
          y2="12"
          className="fv-mk-ink"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
        <line
          x1="15"
          y1="18"
          x2="25"
          y2="18"
          className="fv-mk-ink"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
        <circle cx="29" cy="29" r="8" className="fv-mk-seal" strokeWidth="2.5" />
      </svg>
      {!small && <b>Audit Differently</b>}
      {status && <small className="fx-status">{status}</small>}
    </div>
  )
}

const GW = 680
const G_FILES = [
  ['📊', 'September ledger.xlsx', '14 lines'],
  ['🧾', 'Receipts and invoices', '12 files'],
  ['🏦', 'Bank statement', '1 file'],
  ['⏱️', 'Timesheets', '9 files'],
  ['📋', 'Payroll register', '1 file'],
]
const G_ALERTS = [
  ['Laptops · $1,240.00', 'Proof of payment missing', 'Proof of payment on file'],
  ['Instructor payroll · Sep', 'Timesheet missing', 'Timesheet on file'],
]
const G_CHECKS = [
  ['Receipt $612.40', 'Ledger $612.40'],
  ['Shared rent split', '100%'],
  ['Payroll 80 h', 'Timesheets 80 h'],
]

export function BooksGraphic() {
  const { ref, step } = useCycle(14, 650, 3800)
  const fit = useFit(GW)
  const stage = step >= 13 ? 3 : step >= 10 ? 2 : step >= 6 ? 1 : 0
  const status =
    step === 0
      ? 'Waiting for records'
      : step <= 5
        ? 'Bringing in…'
        : step <= 9
          ? 'Tracking…'
          : step <= 12
            ? 'Verifying…'
            : 'Ready ✓'
  const flowing = step >= 1 && step <= 12
  const stageClass = (i: number) =>
    `${i === stage ? 'gp-on' : ''} ${i < stage || step >= 13 ? 'gp-done' : ''}`
  return (
    <div className="fv-fit gp-fit" ref={fit.ref}>
      <div className="gp" ref={ref} aria-hidden="true" style={{ width: GW, zoom: fit.scale }}>
        <div className="fx-pile gp-pile gx-pile">
          <span className="fx-tag fx-tag-bad">Scattered records</span>
          {MESS.map((m, i) => {
            const gone = m.flies === undefined ? step >= 6 : step >= m.flies + 1
            return (
              <span
                key={m.label}
                className={`gx-item gx-${m.kind} ${gone ? 'fx-gone' : ''}`}
                style={{
                  rotate: `${m.r}deg`,
                  left: `${m.x}%`,
                  top: `${9 + m.y * 0.86}%`,
                  ['--d' as string]: `${i * 0.29}s`,
                }}
              >
                <span className="gx-emoji">{m.emoji}</span>
                <span className="gx-text">
                  {m.label}
                  {m.sub && <small>{m.sub}</small>}
                </span>
              </span>
            )
          })}
        </div>
        <div className={`fv-pipe ${flowing ? 'fv-flow' : ''}`} />
        <Engine busy={flowing} status={status} />
        <div className={`fv-pipe ${flowing ? 'fv-flow' : ''}`} />

        <div className="gp-order">
          <span className="fx-tag fx-tag-good">In order</span>
          <ol className="gp-stages">
            <li className={stageClass(0)}>
              <Num i={0} stage={stage} step={step} />
              <div className="gp-body">
                <b>Brought in</b>
                <ul className="gp-files">
                  {G_FILES.map(([icon, name, count], i) => (
                    <li key={name} className={step > i ? 'gp-in' : ''}>
                      <span>{icon}</span>
                      {name}
                      <small>{count}</small>
                    </li>
                  ))}
                </ul>
              </div>
            </li>
            <li className={stageClass(1)}>
              <Num i={1} stage={stage} step={step} alert={step >= 6 && step < 9} />
              <div className="gp-body">
                <b>Tracked</b>
                {G_ALERTS.map(([label, bad, good], i) => {
                  const shown = step >= 6 + i
                  const fixed = step >= 8 + i
                  return (
                    <div
                      key={label}
                      className={`gp-alert ${shown ? 'gp-in' : ''} ${fixed ? 'gp-fixed' : ''}`}
                    >
                      <span className="gp-bell">{fixed ? '✓' : '!'}</span>
                      <span>
                        {label}
                        <small>{fixed ? good : bad}</small>
                      </span>
                    </div>
                  )
                })}
              </div>
            </li>
            <li className={stageClass(2)}>
              <Num i={2} stage={stage} step={step} />
              <div className="gp-body">
                <b>Verified</b>
                <ul className="gp-checks">
                  {G_CHECKS.map(([a, b], i) => {
                    const ok = step >= 10 + i
                    return (
                      <li key={a} className={ok ? 'gp-ok' : ''}>
                        <span>{a}</span>
                        <em>{ok ? '=' : '?'}</em>
                        <span>{b}</span>
                        <i>{ok ? '✓' : ''}</i>
                      </li>
                    )
                  })}
                </ul>
              </div>
            </li>
            <li className={stageClass(3)}>
              <Num i={3} stage={stage} step={step} />
              <div className="gp-body">
                <b>Shared when you're ready</b>
                <div className={`gp-share ${step >= 13 ? 'gp-in' : ''}`}>
                  <span className="gp-avatar">JP</span>
                  <span>
                    Jules Park · Auditor · read-only
                    <small>Secured data access to the audit data you shared</small>
                  </span>
                </div>
              </div>
            </li>
          </ol>
          <div className={`fx-ready ${step >= 14 ? 'fx-in' : ''}`}>Audit ready · 100%</div>
        </div>

        {step >= 1 && step <= 5 && (
          <span key={`g${step}`} className="fx-traveler gp-travel">
            {`${flying(step).emoji} ${flying(step).label}`}
          </span>
        )}
      </div>
    </div>
  )
}

/** The rich pile's item that flies at this step (the one that becomes record step - 1). */
function flying(step: number) {
  return MESS.find((m) => m.flies === step - 1) ?? MESS[0]
}

function Num({
  i,
  stage,
  step,
  alert,
}: {
  i: number
  stage: number
  step: number
  alert?: boolean
}) {
  const done = i < stage || step >= 13
  return (
    <span
      className={`gp-num ${alert ? 'gp-num-alert' : done ? 'gp-num-done' : i === stage ? 'gp-num-on' : ''}`}
    >
      {alert ? '!' : done ? '✓' : i + 1}
    </span>
  )
}
