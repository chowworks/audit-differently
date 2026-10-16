/*
 * DESIGN EXPERIMENT, option B (?layout=b): the six steps as a checklist on the left, the chosen step's work on the
 * right; the current step chosen at first. Delete once the owner picks a layout (see shared.tsx).
 */
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button, Chip } from '@/components/ui'
import { DocumentLink } from '@/components/DocumentLink'
import { shortDate } from '@/lib/format'
import {
  MonthHead,
  MoreMenu,
  STAGES,
  funderOf,
  moreItems,
  nextActionOf,
  progressOf,
  proofWords,
  scrollToExpense,
  stageNote,
  type MonthLayoutProps,
  type StageKey,
} from './shared'

export function LayoutB({ r, busy, notice, highlight, sections: s, act }: MonthLayoutProps) {
  const p = progressOf(r)
  const [chosen, setChosen] = useState<StageKey>(p.current ?? 'send')

  // A check's "show" opens the proof step, where the ledger is, then brings the row into view.
  useEffect(() => {
    if (highlight) setChosen('proof')
  }, [highlight])
  useEffect(() => scrollToExpense(highlight), [highlight, chosen])

  const next = nextActionOf(r, p, act, () => setChosen('blockers'))

  /** Each step's own button, when this person can take it now; green only on the current step. */
  const stepAction = (key: StageKey) => {
    const kind = key === p.current ? 'primary' : 'navy'
    const cls = key === p.current ? 'rl-next' : undefined
    const btn = (label: string, onClick: () => void) => (
      <Button size="sm" kind={kind} className={cls} onClick={onClick} disabled={busy}>
        {label}
      </Button>
    )
    if (key === p.current && next.label && next.onClick) return btn(next.label, next.onClick)
    switch (key) {
      case 'expenses':
        return r.can.edit ? btn('Add an expense', act.addExpense) : null
      case 'proof': {
        const first = p.missing[0]
        return r.can.edit && first
          ? btn('Attach the next', () => act.attach(first.expense, first.purpose))
          : null
      }
      case 'closing':
        return r.can.close && !p.blockers.length ? btn('Approve', act.approve) : null
      case 'signed':
        return r.can.attachSigned ? btn('Attach', act.attachSigned) : null
      case 'send':
        return r.can.submit ? btn('Send', act.submit) : null
      default:
        return null
    }
  }

  return (
    <div className="rl">
      <MonthHead r={r} p={p}>
        <MoreMenu items={moreItems(r, act)} busy={busy} />
      </MonthHead>
      {notice}

      <div className="rl-split">
        <ol className="rl-checklist" aria-label="The month's steps">
          {STAGES.map((st, i) => {
            const done = p.done[st.key]
            const current = st.key === p.current
            const action = stepAction(st.key)
            return (
              <li
                key={st.key}
                className={`rl-check ${chosen === st.key ? 'rl-check-on' : ''} ${current ? 'rl-check-current' : ''}`}
              >
                <button
                  type="button"
                  className="rl-check-pick"
                  aria-pressed={chosen === st.key}
                  onClick={() => setChosen(st.key)}
                >
                  <span
                    className={`rl-step-mark ${done ? 'rl-mark-done' : current ? 'rl-mark-current' : ''}`}
                    aria-hidden="true"
                  >
                    {done ? '✓' : i + 1}
                  </span>
                  <span className="rl-step-text">
                    <span className="rl-step-label">{st.label}</span>
                    <span className="rl-step-note">{stageNote(r, p, st.key)}</span>
                  </span>
                </button>
                {action && <div className="rl-check-action">{action}</div>}
              </li>
            )
          })}
        </ol>

        <div className="rl-work">
          {chosen === p.current && <p className="rl-work-lead">{next.sentence}</p>}
          {chosen === 'expenses' && s.ledger}
          {chosen === 'proof' && (
            <>
              {p.missing.length > 0 && (
                <p className="rl-work-lead">
                  Missing: {p.missing.map(proofWords).join(', ')}. Use the + chips in the ledger, or
                  upload the receipts below and let them match.
                </p>
              )}
              {s.ledger}
              {s.receipts}
              {s.payroll}
              {s.payrollProof}
            </>
          )}
          {chosen === 'blockers' && (
            <div className="grid gap-4 lg:grid-cols-3">
              {s.checks}
              {s.lines}
            </div>
          )}
          {chosen === 'closing' && (
            <section className="ad-card">
              <div className="ad-card-body">
                <h2 className="ad-card-title">Month-end closing</h2>
                <p className="mt-2 text-sm text-soft">
                  Your company's own approval of the month, usually your CEO's, before it goes to{' '}
                  {funderOf(r)}. Once approved, the ledger is locked until the closing is sent back.
                </p>
                <p className="mt-3">
                  {r.status === 'draft'
                    ? p.blockers.length
                      ? `${p.blockers.length} blocking check(s) first.`
                      : 'Not approved yet.'
                    : `Approved${r.authorizedByName ? ` by ${r.authorizedByName}` : ''}${r.authorizedAt ? ` on ${shortDate(r.authorizedAt)}` : ''}.`}
                </p>
                {r.can.sendBack && (
                  <div className="mt-3">
                    <Button kind="navy" onClick={act.sendBack} disabled={busy}>
                      Send back
                    </Button>
                  </div>
                )}
              </div>
            </section>
          )}
          {chosen === 'signed' && (
            <section className="ad-card">
              <div className="ad-card-body">
                <h2 className="ad-card-title">Signed copy</h2>
                <p className="mt-2 text-sm text-soft">
                  Sign the funder's form, then keep the signed copy with the month.
                </p>
                <p className="mt-3 flex flex-wrap items-center gap-3">
                  {r.signedCopy ? (
                    <Chip tone="ok" title={r.signedCopy.fileName}>
                      <DocumentLink doc={r.signedCopy}>✓ signed copy</DocumentLink>
                    </Chip>
                  ) : (
                    <span>Not on file yet.</span>
                  )}
                  <Link to={`/reports/${r.id}/form`}>Open the funder's form</Link>
                </p>
              </div>
            </section>
          )}
          {chosen === 'send' && (
            <>
              <section className="ad-card">
                <div className="ad-card-body">
                  <h2 className="ad-card-title">Send it to {funderOf(r)}</h2>
                  <p className="mt-2 text-sm text-soft">
                    Due {shortDate(r.dueDate)}. Download the month's bundle to send with the
                    invoice: personal records are never in it.
                  </p>
                  <p className="mt-3">
                    {r.submittedAt
                      ? `Sent ${shortDate(r.submittedAt)}${r.preparedByName ? ` by ${r.preparedByName}` : ''}.`
                      : r.status === 'draft'
                        ? 'Approve the month-end closing first.'
                        : 'Not sent yet.'}
                  </p>
                  <div className="mt-3 ad-actions">
                    <Button kind="navy" onClick={act.downloadBundle} disabled={busy}>
                      Download the month's bundle
                    </Button>
                    {r.can.reopen && (
                      <Button kind="navy" onClick={act.reopen} disabled={busy}>
                        Reopen to correct
                      </Button>
                    )}
                  </div>
                </div>
              </section>
              {s.earlier}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
