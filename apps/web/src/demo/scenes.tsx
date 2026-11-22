import { useEffect, useState } from 'react'
import {
  BUDGET,
  ELAPSED,
  EXPENSES,
  FIXES,
  FUNDER,
  MONTH,
  MONTHS_ELAPSED,
  PACE_LABEL,
  PACKAGE,
  READY_START,
  UNALLOWABLE,
  UPLOADS,
  money,
  paceOf,
  projected,
  spent,
  type BudgetLine,
} from './data'

/**
 * The demo's scenes, one per step of the tour. Each plays a short animation when it opens (a counter that
 * steps up on a timer) and then waits for the visitor to click. People who ask for reduced motion see the
 * last frame at once.
 */

const reduced = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** 0 … steps, one step every `ms`, starting again whenever `key` changes. */
export function usePlay(steps: number, ms: number, key: unknown = 0) {
  const [step, setStep] = useState(0)
  useEffect(() => {
    if (steps === 0 || reduced()) {
      setStep(steps)
      return
    }
    setStep(0)
    let n = 0
    const t = window.setInterval(() => {
      n += 1
      setStep(n)
      if (n >= steps) window.clearInterval(t)
    }, ms)
    return () => window.clearInterval(t)
  }, [steps, ms, key])
  return step
}

/** A number that counts up to `to` when it first shows. */
function CountUp({
  to,
  format = (n: number) => String(n),
  ms = 900,
}: {
  to: number
  format?: (n: number) => string
  ms?: number
}) {
  const [n, setN] = useState(reduced() ? to : 0)
  useEffect(() => {
    if (reduced()) {
      setN(to)
      return
    }
    const start = performance.now()
    let raf = 0
    const from = 0
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / ms)
      setN(Math.round(from + (to - from) * (1 - Math.pow(1 - p, 3))))
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [to, ms])
  return <>{format(n)}</>
}

function Window({
  title,
  children,
  wide,
}: {
  title: string
  children: React.ReactNode
  wide?: boolean
}) {
  return (
    <div className={`addm-window ${wide ? 'addm-window-wide' : ''}`}>
      <div className="addm-window-bar">
        <span className="addm-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span>{title}</span>
      </div>
      <div className="addm-window-body">{children}</div>
    </div>
  )
}

// ── 1. Budget ───────────────────────────────────────────────────────────────

export function BudgetScene() {
  const step = usePlay(BUDGET.length, 260)
  const total = BUDGET.reduce((s, l) => s + l.approved, 0)
  return (
    <Window title={`Youth Pathways Grant · Approved budget`}>
      <div className="addm-budget">
        {BUDGET.map((l, i) => (
          <div key={l.name} className={`addm-budget-row ${step > i ? 'addm-in' : ''}`}>
            <span>{l.name}</span>
            <span className="addm-bar">
              <i style={{ width: step > i ? `${(l.approved / 168_000) * 100}%` : 0 }} />
            </span>
            <b className="addm-mono">{money(l.approved)}</b>
          </div>
        ))}
        <div className={`addm-budget-total ${step >= BUDGET.length ? 'addm-in' : ''}`}>
          <span>Approved total, Jul 2026 to Jun 2027</span>
          <b className="addm-mono">{money(total)}</b>
        </div>
      </div>
      <p className={`addm-foot ${step >= BUDGET.length ? 'addm-in' : ''}`}>
        ✓ Every dollar from here on is spent against one of these lines.
      </p>
    </Window>
  )
}

// ── 2. Upload ───────────────────────────────────────────────────────────────

export function UploadScene() {
  const [run, setRun] = useState(0)
  const step = usePlay(UPLOADS.length * 2 + 1, 520, run)
  return (
    <Window title={`Month end · ${MONTH}`}>
      <div className="addm-drop">
        <span className="addm-drop-icon">⬆</span>
        <b>Drop this month’s reports here</b>
        <small>
          The books export, the payroll register, the bank statement. Receipts arrive by email all
          month.
        </small>
      </div>
      <ul className="addm-files">
        {UPLOADS.map((u, i) => {
          const shown = step > i * 2
          const done = step > i * 2 + 1
          return (
            <li key={u.file} className={shown ? 'addm-in' : ''}>
              <span className="addm-file-icon">{u.icon}</span>
              <span className="addm-file-name">
                {u.file}
                <span className="addm-progress">
                  <i style={{ width: done ? '100%' : shown ? '55%' : 0 }} />
                </span>
              </span>
              <span className={`addm-found ${done ? 'addm-in' : ''}`}>✓ {u.found}</span>
            </li>
          )
        })}
      </ul>
      <div className={`addm-foot addm-foot-row ${step > UPLOADS.length * 2 ? 'addm-in' : ''}`}>
        <span>✨ Read, sorted and matched in 38 seconds.</span>
        <button type="button" className="addm-link" onClick={() => setRun((r) => r + 1)}>
          ↻ Replay
        </button>
      </div>
    </Window>
  )
}

// ── 3. Match ────────────────────────────────────────────────────────────────

export function MatchScene() {
  const step = usePlay(EXPENSES.length, 480)
  const [open, setOpen] = useState(2)
  const e = EXPENSES[open]
  const matched = EXPENSES.filter((x, i) => step > i && x.result === 'ok').length
  return (
    <div className="addm-split">
      <Window title="Expenses & proof">
        <div className="addm-tiles">
          <div className="addm-tile addm-ok">
            <b>{matched}</b>
            <small>complete</small>
          </div>
          <div className="addm-tile addm-warn">
            <b>{step > 2 ? 1 : 0}</b>
            <small>don’t agree</small>
          </div>
          <div className="addm-tile addm-bad">
            <b>{step > 4 ? 1 : 0}</b>
            <small>proof missing</small>
          </div>
        </div>
        <ul className="addm-rows">
          {EXPENSES.map((x, i) => {
            const done = step > i
            return (
              <li key={x.vendor}>
                <button
                  type="button"
                  className={`addm-row ${open === i ? 'addm-row-open' : ''}`}
                  onClick={() => setOpen(i)}
                >
                  <span>
                    <b>{x.vendor}</b>
                    <small>
                      {x.what} · {x.line}
                    </small>
                  </span>
                  <span className="addm-mono">{money(x.books, x.books % 1 !== 0)}</span>
                  <span className="addm-chips">
                    {!done && <span className="addm-chip addm-chip-wait">matching…</span>}
                    {done &&
                      x.proofs.map((p) => (
                        <span key={p} className="addm-chip addm-chip-ok addm-pop">
                          ✓ {p}
                        </span>
                      ))}
                    {done && x.result === 'missing' && (
                      <span className="addm-chip addm-chip-bad addm-pop">Receipt missing</span>
                    )}
                    {done && x.result === 'differs' && (
                      <span className="addm-chip addm-chip-warn addm-pop">Amounts differ</span>
                    )}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </Window>
      <div className="addm-receipt" key={open}>
        {e.result === 'missing' ? (
          <div className="addm-receipt-empty">
            <b>No receipt yet</b>
            <small>
              The bank shows {money(e.books)} paid to {e.vendor} on Nov 19. We’ll ask Marcus for the
              receipt.
            </small>
          </div>
        ) : e.proofs.includes('Register') ? (
          <div className="addm-paper">
            <small className="addm-paper-head">
              PAYROLL REGISTER · {e.vendor.replace('Payroll run · ', '')}
            </small>
            <div className="addm-paper-line">Hours, gross, taxes, net · {e.what}</div>
            <div className="addm-paper-line addm-hl">
              Total direct deposits <b className="addm-mono">{money(e.books)}</b>
            </div>
            <div className="addm-paper-line">Matched to one bank debit of the same amount</div>
          </div>
        ) : (
          <div className="addm-paper">
            <small className="addm-paper-head">{e.vendor.toUpperCase()}</small>
            <div className="addm-paper-line">{e.what}</div>
            <div className="addm-paper-line">Paid by card ending 4410</div>
            <div
              className={`addm-paper-line ${e.result === 'differs' ? 'addm-hl-warn' : 'addm-hl'}`}
            >
              TOTAL <b className="addm-mono">{money(e.receipt ?? e.books, true)}</b>
            </div>
          </div>
        )}
        {e.result === 'differs' && (
          <p className="addm-receipt-note">
            The receipt says <b>{money(e.receipt ?? 0, true)}</b>; the books say{' '}
            <b>{money(e.books, true)}</b>. A transposed digit, caught before the funder sees it.
          </p>
        )}
        {e.result === 'ok' && (
          <p className="addm-receipt-note">✓ The proof agrees with the books.</p>
        )}
        <small className="addm-hint">Click any row to see its proof.</small>
      </div>
    </div>
  )
}

// ── 4. Allowable costs ──────────────────────────────────────────────────────

export function GuardrailScene() {
  const step = usePlay(UNALLOWABLE.length, 450)
  const [moved, setMoved] = useState<number[]>([])
  const kept = UNALLOWABLE.filter((_, i) => moved.includes(i)).reduce((s, u) => s + u.amount, 0)
  return (
    <Window title="Allowable-cost check · November">
      <div className="addm-guard-head">
        <span className="addm-shield" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="24" height="24">
            <path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5z" fill="var(--brand)" />
            <path
              d="m8.5 12 2.5 2.5 4.5-5"
              fill="none"
              stroke="#fff"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <div>
          <b>148 charges checked against the federal cost principles</b>
          <small>144 allowable and on the approved budget. 4 can’t be charged to this grant.</small>
        </div>
      </div>
      <ul className="addm-guard">
        {UNALLOWABLE.map((u, i) => (
          <li
            key={u.vendor}
            className={`${step > i ? 'addm-in' : ''} ${moved.includes(i) ? 'addm-moved' : ''}`}
          >
            <span>
              <b>
                {u.vendor} · {money(u.amount)}
              </b>
              <small>{u.what}</small>
            </span>
            <span className="addm-rule">
              <b>{u.rule}</b>
              <small className="addm-mono">{u.cite}</small>
            </span>
            {moved.includes(i) ? (
              <span className="addm-chip addm-chip-ok">✓ Off the grant</span>
            ) : (
              <button
                type="button"
                className="addm-btn-sm"
                onClick={() => setMoved((m) => [...m, i])}
              >
                Move off the grant
              </button>
            )}
          </li>
        ))}
      </ul>
      <div className="addm-foot addm-foot-row addm-in">
        <span>
          {kept > 0 ? (
            <>
              <b className="addm-mono">{money(kept)}</b> kept out of the funder’s report before
              anyone signs.
            </>
          ) : (
            'Click “Move off the grant” to charge a cost to unrestricted funds instead.'
          )}
        </span>
        {moved.length < UNALLOWABLE.length && (
          <button
            type="button"
            className="addm-link"
            onClick={() => setMoved(UNALLOWABLE.map((_, i) => i))}
          >
            Move all 4
          </button>
        )}
      </div>
    </Window>
  )
}

// ── 5. Forecast ─────────────────────────────────────────────────────────────

const MONTHS = ['Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun']

function ForecastChart({ line }: { line: BudgetLine }) {
  const W = 420
  const H = 190
  const pad = { l: 8, r: 8, t: 16, b: 22 }
  const max = Math.max(line.approved, projected(line)) * 1.08
  const x = (i: number) => pad.l + ((W - pad.l - pad.r) * (i + 1)) / 12
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / max)
  const actual = line.monthly.map((v, i) => `${x(i)},${y(v)}`).join(' ')
  const rate = spent(line) / MONTHS_ELAPSED
  const proj = Array.from({ length: 12 - MONTHS_ELAPSED + 1 }, (_, k) => {
    const i = MONTHS_ELAPSED - 1 + k
    return `${x(i)},${y(rate * (i + 1))}`
  }).join(' ')
  const pace = paceOf(line)
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="addm-chart"
      role="img"
      aria-label={`${line.name}: spending and projection`}
    >
      <line
        x1={pad.l}
        x2={W - pad.r}
        y1={y(line.approved)}
        y2={y(line.approved)}
        className="addm-chart-cap"
      />
      <text x={pad.l} y={y(line.approved) - 5} textAnchor="start" className="addm-chart-label">
        Approved {money(line.approved)}
      </text>
      <polyline
        points={proj}
        className={`addm-chart-proj addm-pace-${pace}`}
        key={`p-${line.name}`}
      />
      <polyline
        points={`${pad.l},${y(0)} ${actual}`}
        className="addm-chart-actual"
        key={`a-${line.name}`}
      />
      <circle cx={x(11)} cy={y(rate * 12)} r="5" className={`addm-chart-end addm-pace-${pace}`} />
      {MONTHS.map((m, i) => (
        <text key={m} x={x(i)} y={H - 6} textAnchor="middle" className="addm-chart-month">
          {m}
        </text>
      ))}
    </svg>
  )
}

export function ForecastScene() {
  const step = usePlay(1, 60)
  const [pick, setPick] = useState(0)
  const line = BUDGET[pick]
  const pace = paceOf(line)
  const gap = projected(line) - line.approved
  return (
    <div className="addm-split addm-split-even">
      <Window title="Budget tracking · % spent vs % of the year gone">
        <ul className="addm-pace-list">
          {BUDGET.map((l, i) => {
            const pct = spent(l) / l.approved
            const p = paceOf(l)
            return (
              <li key={l.name}>
                <button
                  type="button"
                  className={`addm-pace-row ${pick === i ? 'addm-row-open' : ''}`}
                  onClick={() => setPick(i)}
                >
                  <span className="addm-pace-name">{l.name}</span>
                  <span className="addm-pace-bar">
                    <i
                      className={`addm-pace-${p}`}
                      style={{ width: step ? `${Math.min(pct, 1) * 100}%` : 0 }}
                    />
                    <em style={{ left: `${ELAPSED * 100}%` }} title="Share of the year gone" />
                  </span>
                  <span className="addm-mono">{Math.round(pct * 100)}%</span>
                  <span className={`addm-chip addm-chip-${p}`}>{PACE_LABEL[p]}</span>
                </button>
              </li>
            )
          })}
        </ul>
        <p className="addm-foot addm-in">
          The line on each bar is today: {Math.round(ELAPSED * 100)}% of the award year has passed.
        </p>
      </Window>
      <div className="addm-forecast">
        <b className="addm-forecast-title">{line.name}</b>
        <ForecastChart line={line} />
        <p className={`addm-forecast-say addm-say-${pace}`}>
          {pace === 'over' && (
            <>
              At this pace, {line.name.toLowerCase()} reach <b>{money(projected(line))}</b> by June:{' '}
              <b>{money(gap)} over</b>. Ask the funder for a budget change now, not in May.
            </>
          )}
          {pace === 'on-track' && (
            <>
              At this pace, {line.name.toLowerCase()} land at <b>{money(projected(line))}</b>,
              within the approved {money(line.approved)}.
            </>
          )}
          {pace === 'under' && (
            <>
              At this pace, {line.name.toLowerCase()} leave <b>{money(-gap)}</b> unspent. Room to
              move money to a line that’s running hot.
            </>
          )}
        </p>
        <small className="addm-hint">Click a budget line to see where it lands.</small>
      </div>
    </div>
  )
}

// ── 6. Readiness ────────────────────────────────────────────────────────────

function Ring({ value }: { value: number }) {
  const r = 70
  const c = 2 * Math.PI * r
  return (
    <svg
      viewBox="0 0 180 180"
      className="addm-ring"
      role="img"
      aria-label={`Audit readiness ${value}%`}
    >
      <circle cx="90" cy="90" r={r} className="addm-ring-track" />
      <circle
        cx="90"
        cy="90"
        r={r}
        className={`addm-ring-fill ${value >= 100 ? 'addm-ring-done' : ''}`}
        strokeDasharray={c}
        strokeDashoffset={c * (1 - value / 100)}
      />
      <text x="90" y="98" textAnchor="middle" className="addm-ring-num">
        {value}%
      </text>
      <text x="90" y="122" textAnchor="middle" className="addm-ring-label">
        audit ready
      </text>
    </svg>
  )
}

export function ReadinessScene() {
  const [done, setDone] = useState<number[]>([])
  const value =
    READY_START + FIXES.filter((_, i) => done.includes(i)).reduce((s, f) => s + f.points, 0)
  return (
    <div className="addm-split addm-split-ring">
      <div className="addm-ring-wrap">
        <Ring value={value} />
        <p className={`addm-ring-say ${value >= 100 ? 'addm-say-on-track' : ''}`}>
          {value >= 100
            ? '✓ November is ready to sign.'
            : `${FIXES.length - done.length} things stand between Marcus and a clean month.`}
        </p>
      </div>
      <Window title="What to do next">
        <ul className="addm-fixes">
          {FIXES.map((f, i) => {
            const isDone = done.includes(i)
            return (
              <li key={f.what} className={isDone ? 'addm-fix-done' : ''}>
                <span className="addm-fix-check">{isDone ? '✓' : i + 1}</span>
                <span>
                  <b>{f.what}</b>
                  <small>{isDone ? f.how : `+${f.points} points`}</small>
                </span>
                {!isDone && (
                  <button
                    type="button"
                    className="addm-btn-sm"
                    onClick={() => setDone((d) => [...d, i])}
                  >
                    Fix
                  </button>
                )}
              </li>
            )
          })}
        </ul>
        {done.length < FIXES.length && (
          <div className="addm-foot addm-foot-row addm-in">
            <span>Each fix is one click from the item that needs it.</span>
            <button
              type="button"
              className="addm-link"
              onClick={() => setDone(FIXES.map((_, i) => i))}
            >
              Fix them all
            </button>
          </div>
        )}
      </Window>
    </div>
  )
}

// ── 7. Sign ─────────────────────────────────────────────────────────────────

export function SignScene() {
  const [signed, setSigned] = useState(false)
  const step = usePlay(signed ? 3 : 0, 650, signed)
  return (
    <Window title={`Monthly report · ${MONTH}`} wide>
      <div className="addm-tiles addm-tiles-4">
        <div className="addm-tile">
          <b className="addm-mono">
            <CountUp to={44_700} format={(n) => money(n)} />
          </b>
          <small>billed this month</small>
        </div>
        <div className="addm-tile">
          <b className="addm-mono">
            <CountUp to={210_000} format={(n) => money(n)} />
          </b>
          <small>spent to date · 44% of the award</small>
        </div>
        <div className="addm-tile addm-ok">
          <b>0</b>
          <small>open checks</small>
        </div>
        <div className="addm-tile addm-ok">
          <b>100%</b>
          <small>audit ready</small>
        </div>
      </div>
      <div className="addm-sign">
        <div>
          <b>Angela reviews November in one screen</b>
          <small>
            Every line has its proof. Two lines are flagged as heading over, with a forecast she can
            take to the funder.
          </small>
        </div>
        {!signed ? (
          <button type="button" className="addm-btn" onClick={() => setSigned(true)}>
            ✍ Approve and submit November
          </button>
        ) : (
          <div className="addm-signature">
            <span className={`addm-sig ${step >= 1 ? 'addm-in' : ''}`}>Angela Ruiz</span>
            <small className={step >= 1 ? 'addm-in' : ''}>Approved Dec 2, 2026, 4:12 PM</small>
          </div>
        )}
      </div>
      <ol className="addm-timeline">
        <li className={signed && step >= 1 ? 'addm-in' : ''}>
          ✓ Month-end closing approved by the CEO
        </li>
        <li className={signed && step >= 2 ? 'addm-in' : ''}>
          ✓ Signed report filed with its proof
        </li>
        <li className={signed && step >= 3 ? 'addm-in' : ''}>
          ✓ Submitted to {FUNDER}, 3 days before it’s due
        </li>
      </ol>
    </Window>
  )
}

// ── 8. Audit ────────────────────────────────────────────────────────────────

export function AuditScene() {
  const [built, setBuilt] = useState(false)
  const step = usePlay(built ? PACKAGE.length : 0, 300, built)
  const files = PACKAGE.reduce((s, p) => s + p.files, 0)
  return (
    <div className="addm-split addm-split-even">
      <div className="addm-mail">
        <small>✉ {FUNDER} · Monitoring unit</small>
        <b>
          Monitoring review: please send all program and financial records for July to November.
        </b>
        <small>Due in 10 business days.</small>
        <div className="addm-mail-then">
          <span>
            <b>Last year</b>
            <small>Three weeks pulling files from five places.</small>
          </span>
          <span>
            <b>This year</b>
            <small>One click.</small>
          </span>
        </div>
      </div>
      <Window title="Audit package · Youth Pathways Grant">
        {!built ? (
          <div className="addm-build">
            <button type="button" className="addm-btn" onClick={() => setBuilt(true)}>
              ⬇ Build the audit package
            </button>
            <small>
              In the funder’s own folder layout, every expense with its proof beside it.
            </small>
          </div>
        ) : (
          <>
            <ul className="addm-tree">
              {PACKAGE.map((p, i) => (
                <li key={p.folder} className={step > i ? 'addm-in' : ''}>
                  <span>{p.folder.includes('.') ? '📄' : '📁'}</span>
                  <span>{p.folder}</span>
                  <small>
                    {p.locked ? '🔒 ' : ''}
                    {p.files} {p.files === 1 ? 'file' : 'files'}
                  </small>
                </li>
              ))}
            </ul>
            <p className={`addm-foot ${step >= PACKAGE.length ? 'addm-in' : ''}`}>
              ✓ {files} files, ready in 4 seconds. Nothing to find, because it was filed as it was
              spent.
            </p>
          </>
        )}
      </Window>
    </div>
  )
}
