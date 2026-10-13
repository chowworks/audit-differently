import { useLayoutEffect, useRef, useState } from 'react'
import { useCycle, useFit } from './motion'
import './audit-day-graphic.css'

/**
 * The Audit day graphic: the package tree fills in and verifies row by row, the auditor (read-only) opens a
 * folder to see its proof, then downloads the package. Same template as the books graphic.
 */
const W = 560
const TREE: [string, string, number][] = [
  ['📁', 'Months', 0],
  ['📁', 'September 2026', 1],
  ['📄', 'Signed report.pdf', 2],
  ['📄', 'Ledger.csv', 2],
  ['📁', 'Program Costs', 2],
  ['📁', 'Proof of Purchase - Bank Statements', 2],
  ['📁', 'Payroll and Timesheet Reports', 2],
  ['📁', 'Participant Eligibility and Enrollment Forms', 0],
  ['📄', 'Index.csv', 0],
]
const PICK = 4 // Program Costs

export function AuditDayGraphic() {
  const n = TREE.length
  const { ref, step } = useCycle(n + 4, 520, 3800)
  const fit = useFit(W)
  const card = useRef<HTMLDivElement>(null)
  const pick = useRef<HTMLLIElement>(null)
  const button = useRef<HTMLSpanElement>(null)
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null)
  const aim = step >= n + 3 ? button : step >= n + 1 ? pick : null
  useLayoutEffect(() => {
    const box = card.current
    const target = aim?.current
    if (!box || !target) return setCursor(null)
    const b = box.getBoundingClientRect()
    const t = target.getBoundingClientRect()
    const k = b.height / box.offsetHeight || 1 // undo the fit zoom
    setCursor({ x: (t.left - b.left + 70) / k, y: (t.top - b.top + t.height / 2) / k })
  }, [aim, fit.scale])
  const opened = step >= n + 2
  const downloaded = step >= n + 4
  return (
    <div className="dg-fit" ref={fit.ref}>
      <div ref={ref} aria-hidden="true" style={{ width: W, zoom: fit.scale }}>
        <div className="dg-card dg-auditor dg-pkg" ref={card}>
          <div className="dg-win-bar dg-pkg-bar">
            <div>
              <b>Audit review records</b>
              <small>For Jules Park, Auditor</small>
            </div>
            <em>🔒 Auditor · read-only</em>
          </div>
          <ul className="dg-pkg-tree">
            {TREE.map(([icon, name, depth], i) => (
              <li
                key={name}
                ref={i === PICK ? pick : undefined}
                className={[
                  step > i ? 'dg-in' : '',
                  i === PICK && step >= n + 1 ? 'dg-hover' : '',
                  i === PICK && opened ? 'dg-picked' : '',
                ].join(' ')}
                style={{ paddingLeft: 12 + depth * 22 }}
              >
                <span>
                  {icon} {name}
                </span>
                <i className="dg-pkg-ok">✓</i>
              </li>
            ))}
          </ul>
          <div className={`dg-pkg-detail ${opened ? 'dg-on' : ''}`}>
            <b>📁 Program Costs · September 2026</b>
            <span>
              Classroom rent <em className="dg-mono">$612.40</em>
              <i>✓ proof</i> <i>✓ matched to ledger</i>
            </span>
            <span>
              Laptops for the cohort, 6 <em className="dg-mono">$4,380.00</em>
              <i>✓ invoice</i> <i>✓ within budget</i>
            </span>
            <small>
              <span className="dg-mono">9:04</span> Jules Park opened Program Costs · logged
            </small>
          </div>
          <div className="dg-pkg-get">
            <span ref={button} className={`dg-btn ${step > n ? 'dg-on' : ''}`}>
              ⬇ Download audit package
            </span>
            <div className={`dg-saved ${downloaded ? 'dg-on' : ''}`}>
              <i>✓</i>
              <b className="dg-mono">brightpath_FY26_audit.zip</b>
              <small>412 files · saved 8:57 AM</small>
            </div>
          </div>
          <svg
            className={`dg-cursor ${cursor ? 'dg-on' : ''} ${step === n + 2 || step === n + 4 ? 'dg-click' : ''}`}
            style={cursor ? { left: cursor.x, top: cursor.y } : undefined}
            width="22"
            height="22"
            viewBox="0 0 24 24"
          >
            <path d="M4 2l16 10-7 1.5L9.5 21z" />
          </svg>
        </div>
      </div>
    </div>
  )
}
