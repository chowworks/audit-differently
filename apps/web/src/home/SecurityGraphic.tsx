import { useCycle, useFit } from './motion'
import './security-graphic.css'

/**
 * The Security graphic: three layers, each on its own (defense in depth). Isolated: the people you invite and
 * no one else. Encrypted: the file scrambles. Logged: who opened what, and when. Same template as the books
 * graphic (useCycle, useFit).
 */
const W = 560

const LOG: [string, string][] = [
  ['10:02', 'Jules Park, auditor, opened bank_statement_sep.pdf'],
  ['10:04', 'Sam Whitfield, owner, opened eligibility_card_07.pdf'],
  ['10:05', 'Jules Park, auditor, downloaded the audit package'],
]

function LogLines({ shown }: { shown: number }) {
  return (
    <ul className="sg-log">
      {LOG.map(([t, what], i) => (
        <li key={t} className={shown > i ? 'sg-in' : ''}>
          <span className="sg-mono">{t}</span> {what}
        </li>
      ))}
    </ul>
  )
}

export function SecurityGraphic() {
  const { ref, step } = useCycle(9, 700, 3800)
  const fit = useFit(W)
  const people: [string, string, string][] = [
    ['SW', 'Sam Whitfield', 'Owner'],
    ['DO', 'Dana Okafor', 'Bookkeeper'],
    ['JP', 'Jules Park', 'Auditor · read-only'],
  ]
  const scrambled = step >= 5 && step % 2 === 1
  return (
    <div className="sg-fit" ref={fit.ref}>
      <div className="sg-locks" ref={ref} aria-hidden="true" style={{ width: W, zoom: fit.scale }}>
        <div className={`sg-lock ${step >= 1 ? 'sg-in' : ''}`}>
          <span className="sg-lock-icon">🏢</span>
          <div>
            <strong>Isolated</strong>
            <small>Your records, seen only by the people you invite.</small>
            <ul className="sg-people">
              {people.map(([initials, name, role], i) => {
                const invited = i === 2
                return (
                  <li
                    key={name}
                    className={`${!invited || step >= 2 ? 'sg-in' : ''} ${invited && step === 2 ? 'sg-new' : ''}`}
                  >
                    <span className="sg-avatar">{initials}</span>
                    <b>{name}</b>
                    <em>{invited && step === 2 ? 'Invited by Sam' : role}</em>
                  </li>
                )
              })}
              <li className={`sg-in sg-else ${step === 3 ? 'sg-deny' : ''}`}>
                <span className="sg-avatar">🔒</span>
                <b>Everyone else</b>
                <em>{step === 3 ? '✕ Other workspace · not found' : 'No access'}</em>
              </li>
            </ul>
          </div>
        </div>
        <div className={`sg-lock ${step >= 4 ? 'sg-in' : ''}`}>
          <span className="sg-lock-icon">🔐</span>
          <div>
            <strong>Encrypted</strong>
            <small>In transit and at rest. Opened only through a link that expires.</small>
            <div className={`sg-cipher sg-mono ${scrambled ? 'sg-scrambled' : ''}`}>
              {scrambled ? '7f3a·c91e·04bd·e62f·a8…' : 'bank_statement_sep.pdf'}
            </div>
          </div>
        </div>
        <div className={`sg-lock ${step >= 6 ? 'sg-in' : ''}`}>
          <span className="sg-lock-icon">📜</span>
          <div>
            <strong>Logged</strong>
            <small>Every data access or modification logged, with who and when.</small>
            <LogLines shown={step - 5} />
          </div>
        </div>
      </div>
    </div>
  )
}
