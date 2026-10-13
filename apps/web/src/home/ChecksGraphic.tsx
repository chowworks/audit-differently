import { useCycle, useFit } from './motion'
import './checks-graphic.css'

/**
 * The checks graphic: a month's findings land, each naming the two records it compared, then each is fixed
 * and the count runs down to ready to sign. Same template as the books graphic (useCycle, useFit).
 */
const W = 560

export function ChecksGraphic() {
  const { ref, step } = useCycle(7, 700, 3800)
  const fit = useFit(W)
  const findings: [string, string, string, string][] = [
    [
      'Receipt does not match the ledger',
      'Receipt.pdf $612.40',
      'Ledger line 7 $600.00',
      'Ledger line 7 now $612.40',
    ],
    ['Rent split is over the cost', 'Allocation sheet 110%', 'Rent invoice 100%', 'Split now 100%'],
    [
      'Invoice charged twice',
      'Ledger line 9 #4471',
      'Ledger line 12 #4471',
      'Duplicate line 12 removed',
    ],
  ]
  const open = Math.min(step, 3) - Math.max(0, step - 3)
  return (
    <div className="ck-fit" ref={fit.ref}>
      <div
        className="ck-card ck-inbox"
        ref={ref}
        aria-hidden="true"
        style={{ width: W, zoom: fit.scale }}
      >
        <div className="ck-head">
          <b>September 2026</b>
          <span className={`ck-count ${step >= 6 ? 'ck-ok' : ''}`}>
            {step >= 6 ? '✓ Ready to sign' : `${Math.max(open, 0)} to fix`}
          </span>
        </div>
        {findings.map(([title, a, b, fix], i) => {
          const shown = step > i
          const done = step > 3 + i
          return (
            <div key={title} className={`ck-find ${shown ? 'ck-in' : ''} ${done ? 'ck-done' : ''}`}>
              <b>{done ? `✓ Fixed · ${fix}` : title}</b>
              <span className="ck-mono">
                {a} <i>↔</i> {b}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
