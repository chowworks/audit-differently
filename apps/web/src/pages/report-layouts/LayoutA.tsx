/*
 * DESIGN EXPERIMENT, option A (?layout=a): a stepper of the month's six steps and one next action; the work below
 * folded except the current step's. Delete once the owner picks a layout (see shared.tsx).
 */
import { useEffect, useState, type ReactNode } from 'react'
import {
  MonthHead,
  MoreMenu,
  NextButton,
  STAGES,
  moreItems,
  nextActionOf,
  plural,
  progressOf,
  scrollToExpense,
  skipFor,
  stageNote,
  type MonthLayoutProps,
  type StageKey,
} from './shared'

type FoldKey = 'ledger' | 'checks' | 'payroll' | 'earlier'

/** The fold that holds each step's work. */
const FOLD_FOR: Record<StageKey, FoldKey> = {
  expenses: 'ledger',
  proof: 'ledger',
  blockers: 'checks',
  closing: 'checks',
  signed: 'ledger',
  send: 'ledger',
}

export function LayoutA({ r, busy, notice, highlight, sections: s, act }: MonthLayoutProps) {
  const p = progressOf(r)
  const [open, setOpen] = useState<Record<FoldKey, boolean>>(() => ({
    ledger: p.current === null || FOLD_FOR[p.current] === 'ledger',
    checks: p.current !== null && FOLD_FOR[p.current] === 'checks',
    payroll: false,
    earlier: false,
  }))
  const [scrollTo, setScrollTo] = useState<string | null>(null)

  // A check's "show" opens the ledger, then brings the row into view.
  useEffect(() => {
    if (highlight) setOpen((o) => ({ ...o, ledger: true }))
  }, [highlight])
  useEffect(() => scrollToExpense(highlight), [highlight, open.ledger])
  useEffect(() => {
    if (!scrollTo) return
    document.getElementById(scrollTo)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setScrollTo(null)
  }, [scrollTo])

  const showBlockers = () => {
    setOpen((o) => ({ ...o, checks: true }))
    setScrollTo('rl-fold-checks')
  }
  const next = nextActionOf(r, p, act, showBlockers)
  const toggle = (k: FoldKey) => setOpen((o) => ({ ...o, [k]: !o[k] }))
  const payrollItems = r.wexPayments.length + r.payrollDocuments.length

  return (
    <div className="rl">
      <MonthHead r={r} p={p} />

      <ol className="rl-stepper" aria-label="The month's steps">
        {STAGES.map((st, i) => {
          const state = p.done[st.key] ? 'done' : st.key === p.current ? 'current' : 'todo'
          return (
            <li
              key={st.key}
              className={`rl-step rl-step-${state}`}
              aria-current={state === 'current' ? 'step' : undefined}
            >
              <span className="rl-step-mark" aria-hidden="true">
                {state === 'done' ? '✓' : i + 1}
              </span>
              <span className="rl-step-text">
                <span className="rl-step-label">{st.label}</span>
                <span className="rl-step-note">{stageNote(r, p, st.key)}</span>
              </span>
            </li>
          )
        })}
      </ol>

      <section className="rl-nextcard" aria-label="Next up">
        <p className="rl-nextcard-text">{next.sentence}</p>
        <div className="ad-actions">
          <NextButton next={next} busy={busy} />
          <MoreMenu items={moreItems(r, act, skipFor(next))} busy={busy} />
        </div>
      </section>

      {notice}

      <Fold
        id="rl-fold-ledger"
        title="Expenses and their proof"
        summary={`${plural(r.expenses.length, 'expense')} · ${p.missing.length ? `${p.missing.length} proof missing` : 'proof complete'} · ${r.matching.receipts.length} receipts`}
        open={open.ledger}
        onToggle={() => toggle('ledger')}
      >
        {s.ledger}
        {s.receipts}
      </Fold>
      <Fold
        id="rl-fold-checks"
        title="Checks and totals"
        summary={
          p.blockers.length
            ? `${p.blockers.length} blocking · ${p.attention.length} to look at`
            : `nothing blocks · ${p.attention.length} to look at`
        }
        warn={p.blockers.length > 0}
        open={open.checks}
        onToggle={() => toggle('checks')}
      >
        <div className="grid gap-4 lg:grid-cols-3">
          {s.checks}
          {s.lines}
        </div>
      </Fold>
      <Fold
        id="rl-fold-payroll"
        title="Payroll"
        summary={
          payrollItems
            ? `${plural(r.wexPayments.length, 'participant')} paid · ${plural(r.payrollDocuments.length, 'payroll document')}`
            : 'no payroll this month'
        }
        open={open.payroll}
        onToggle={() => toggle('payroll')}
      >
        {s.payroll}
        {s.payrollProof}
      </Fold>
      {r.reopenings.length > 0 && (
        <Fold
          id="rl-fold-earlier"
          title="Earlier submissions"
          summary={plural(r.reopenings.length, 'earlier submission')}
          open={open.earlier}
          onToggle={() => toggle('earlier')}
        >
          {s.earlier}
        </Fold>
      )}
    </div>
  )
}

/** A section folded to one line; its work stays mounted while folded. */
function Fold({
  id,
  title,
  summary,
  warn,
  open,
  onToggle,
  children,
}: {
  id: string
  title: string
  summary: string
  warn?: boolean
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <section className="rl-fold" id={id}>
      <button type="button" className="rl-fold-head" aria-expanded={open} onClick={onToggle}>
        <span className="rl-fold-chev" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <span className="rl-fold-title">{title}</span>
        <span className={`rl-fold-summary ${warn ? 'rl-fold-warn' : ''}`}>{summary}</span>
      </button>
      <div className="rl-fold-body" hidden={!open}>
        {children}
      </div>
    </section>
  )
}
