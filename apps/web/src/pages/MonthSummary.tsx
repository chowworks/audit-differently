import { useEffect, useRef, useState, type ReactNode } from 'react'
import type {
  EngagementPayrollCardDto,
  PayrollReconciliationDto,
  WorkspaceExpensesDto,
} from '@ad/types'
import { useLoad } from '@/hooks/useApi'
import { money, periodLabel } from '@/lib/format'
import { Button, Card, Empty, ErrorNote } from '@/components/ui'
import { SLOT_LABEL } from '@/components/payroll-match/why'
import { expenseSummary } from './workspace-expenses'
import { payrollSummary } from './month-summary'
import './month-summary.css'

const many = (n: number, one: string, more = `${one}s`) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : more}`

const reducedMotion = () =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

/** A dollar amount that counts up from zero once, after `delay` ms; at once where motion is reduced. */
function CountUp({ value, delay = 0 }: { value: number; delay?: number }) {
  const [shown, setShown] = useState(() => (reducedMotion() ? value : 0))
  useEffect(() => {
    if (reducedMotion()) {
      setShown(value)
      return
    }
    let frame = 0
    const start = performance.now() + delay
    const tick = (now: number) => {
      const k = Math.min(1, Math.max(0, (now - start) / 1100))
      setShown(value * (1 - Math.pow(1 - k, 3)))
      if (k < 1) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [value, delay])
  return <>{money(Math.round(shown * 100) / 100)}</>
}

/** A ring that fills to `share` (0–1), its words in the middle. */
function Ring({ share, label }: { share: number; label: string }) {
  const r = 34
  const len = 2 * Math.PI * r
  const ref = useRef<SVGCircleElement>(null)
  useEffect(() => {
    const c = ref.current
    if (!c) return
    const end = len * (1 - Math.max(0, Math.min(1, share)))
    if (reducedMotion()) {
      c.style.strokeDashoffset = `${end}`
      return
    }
    c.style.transition = 'none'
    c.style.strokeDashoffset = `${len}`
    void c.getBoundingClientRect()
    c.style.transition = ''
    const t = requestAnimationFrame(() => (c.style.strokeDashoffset = `${end}`))
    return () => cancelAnimationFrame(t)
  }, [share, len])
  return (
    <svg className="msum-ring" viewBox="0 0 84 84" role="img" aria-label={label}>
      <circle className="msum-ring-track" cx="42" cy="42" r={r} />
      <circle
        ref={ref}
        className="msum-ring-value"
        cx="42"
        cy="42"
        r={r}
        style={{ strokeDasharray: len, strokeDashoffset: len * (1 - share) }}
      />
      <text x="42" y="42">
        {label}
      </text>
    </svg>
  )
}

/** One verified fact: a green check that pops in, or an amber "!" for what is still to do. */
function Check({ i, warn, children }: { i: number; warn?: boolean; children: ReactNode }) {
  return (
    <li style={{ ['--i' as string]: i }}>
      <span className={warn ? 'msum-tick msum-tick-warn' : 'msum-tick'} aria-hidden="true">
        {warn ? (
          '!'
        ) : (
          <svg viewBox="0 0 12 12">
            <path d="M2 6.5l2.6 2.5L10 3" />
          </svg>
        )}
      </span>
      <span>{children}</span>
    </li>
  )
}

/**
 * Step 4 of the workspace's month end, Summary (owner's decision, 2026-11-13): what was done and verified, payroll and
 * expenses side by side, shown with green checks that draw themselves in, rings that fill and totals that count up; what
 * is still to do in amber, each with the step that fixes it. Read only.
 */
export function MonthSummary({
  workspaceId,
  period,
  stepper,
  recon,
  cards,
  files,
  onFix,
  onDone,
}: {
  workspaceId: string
  period: string
  stepper?: ReactNode
  recon: PayrollReconciliationDto | null
  cards: EngagementPayrollCardDto[] | null
  /** How many of the month's payroll files are saved; null while they load. */
  files: number | null
  onFix: (step: 'payroll' | 'expenses') => void
  onDone: () => void
}) {
  const load = useLoad<WorkspaceExpensesDto>(`/workspaces/${workspaceId}/expenses/${period}`)
  const [play, setPlay] = useState(0)
  const ex = load.data?.period === period ? load.data : null
  const title = `Summary: ${periodLabel(period)}`
  if (load.error)
    return (
      <Card title={title}>
        {stepper}
        <ErrorNote message={load.error} />
      </Card>
    )
  if (!ex || !recon || !cards)
    return (
      <Card title={title}>
        {stepper}
        <Empty>Adding up the month…</Empty>
      </Card>
    )
  const e = expenseSummary(ex)
  const p = payrollSummary(recon)
  const payrollShare = p.items ? p.proved / p.items : 1
  const receiptShare = e.bills ? e.withReceipt / e.bills : 1
  const engagements = cards.map((c) => {
    const exp = e.engagements.find((x) => x.id === c.engagementId)
    const pay = p.engagements.get(c.engagementId)
    return {
      id: c.engagementId,
      name: c.engagementName,
      payroll: c.charged,
      payrollShare: pay ? pay.proved / pay.items : null,
      expenses: exp?.total ?? 0,
      expenseShare: exp && exp.lines ? exp.proofShare : null,
    }
  })
  const todo: { words: string; step: 'payroll' | 'expenses' }[] = [
    ...p.todo.map((t) => ({
      words: `${t.title}, ${t.engagementName}: no ${t.missing.map((s) => SLOT_LABEL[s].toLowerCase()).join(' or ')}`,
      step: 'payroll' as const,
    })),
    ...(e.missingReceipts.length
      ? [
          {
            words: `${many(e.bills - e.withReceipt, 'bill')} with no receipt yet: ${e.missingReceipts.join(', ')}`,
            step: 'expenses' as const,
          },
        ]
      : []),
    ...(e.unpaid
      ? [
          {
            words: `${many(e.unpaid, 'expense')} with a bill whose payment wasn't found`,
            step: 'expenses' as const,
          },
        ]
      : []),
    ...(e.unmatchedReceipts
      ? [
          {
            words: `${many(e.unmatchedReceipts, 'receipt')} matched to no bill`,
            step: 'expenses' as const,
          },
        ]
      : []),
  ]
  const shownTodo = todo.slice(0, 6)

  return (
    <Card title={title}>
      {stepper}
      <div key={play} className="msum msum-play">
        <div className="msum-hero">
          <svg className="msum-bigcheck" viewBox="0 0 96 96" aria-hidden="true">
            <circle cx="48" cy="48" r="44" />
            <path d="M28 50 L42 63 L69 34" />
          </svg>
          <h2 className="msum-title">{periodLabel(period)} is saved</h2>
          <p className="text-soft">
            Every file was read and every line checked against its proof. Here is what was verified.
          </p>
          <button type="button" className="msum-replay" onClick={() => setPlay((n) => n + 1)}>
            ↻ Replay
          </button>
        </div>

        <div className="msum-cols">
          <section className="msum-panel" aria-label="Payroll">
            <div className="msum-panel-top">
              <Ring share={payrollShare} label={`${p.proved}/${p.items}`} />
              <div>
                <p className="msum-eyebrow">Payroll</p>
                <p className="msum-panel-title">
                  {p.proved} of {many(p.items, 'item')} fully proved
                </p>
              </div>
            </div>
            <ul className="msum-checks">
              {files != null && <Check i={0}>{many(files, 'file')} read and filed</Check>}
              <Check i={1}>{many(p.items, 'payroll item')} on the engagements</Check>
              <Check i={2}>{many(p.bankPaid, 'pay line')} found on the bank statements</Check>
              {p.proved > 0 && (
                <Check i={3}>{many(p.proved, 'item')} with every proof on file</Check>
              )}
              {p.items - p.proved > 0 && (
                <Check i={4} warn>
                  {many(p.items - p.proved, 'item')} still missing a proof
                </Check>
              )}
            </ul>
          </section>

          <section className="msum-panel" aria-label="Expenses">
            <div className="msum-panel-top">
              <Ring share={receiptShare} label={`${e.withReceipt}/${e.bills}`} />
              <div>
                <p className="msum-eyebrow">Expenses</p>
                <p className="msum-panel-title">
                  {e.withReceipt} of {many(e.bills, 'bill')} with a receipt
                </p>
              </div>
            </div>
            <ul className="msum-checks">
              <Check i={1}>{many(e.linesRead, 'line')} of the books read</Check>
              <Check i={2}>
                {many(e.billed, 'expense')} billed, {money(e.total)}
              </Check>
              <Check i={3} warn={e.paid < e.bills}>
                {e.paid} of {many(e.bills, 'bill')} paid, found on the statements
              </Check>
              {e.notes > 0 && (
                <Check i={4}>{many(e.notes, 'allocation note')} attached for the auditor</Check>
              )}
              {e.bills - e.withReceipt > 0 && (
                <Check i={5} warn>
                  {many(e.bills - e.withReceipt, 'bill')} with no receipt yet
                </Check>
              )}
            </ul>
          </section>
        </div>

        <div className="msum-engs">
          {engagements.map((g, i) => (
            <section key={g.id} className="msum-eng" aria-label={g.name}>
              <div className="msum-eng-head">
                <h3 className="font-bold">{g.name}</h3>
                <span className="msum-eng-total">
                  <CountUp value={g.payroll + g.expenses} delay={1300} />
                </span>
              </div>
              <Bar label="Payroll" amount={g.payroll} share={g.payrollShare} i={i * 2} />
              <Bar label="Expenses" amount={g.expenses} share={g.expenseShare} i={i * 2 + 1} />
            </section>
          ))}
        </div>
        <p className="text-xs text-soft">Bars: the share of each amount&apos;s proof on file.</p>

        {todo.length > 0 ? (
          <section className="msum-todo" aria-label="Still to do">
            <h3 className="msum-todo-title">Still to do</h3>
            {shownTodo.map((t, i) => (
              <div key={i} className="msum-todo-row">
                <span className="msum-tick msum-tick-warn" aria-hidden="true">
                  !
                </span>
                <span>{t.words}</span>
                <button type="button" className="msum-fix" onClick={() => onFix(t.step)}>
                  Fix in {t.step === 'payroll' ? 'Payroll matching' : 'Expense matching'}
                </button>
              </div>
            ))}
            {todo.length > shownTodo.length && (
              <p className="text-sm">and {many(todo.length - shownTodo.length, 'more')}.</p>
            )}
          </section>
        ) : (
          <p className="msum-alldone">
            ✓ Nothing left to do: every item and expense is fully proved.
          </p>
        )}

        <div className="ad-actions justify-end">
          <Button kind="primary" onClick={onDone}>
            Done: back to {periodLabel(period)}
          </Button>
        </div>
      </div>
    </Card>
  )
}

/** One engagement's payroll or expenses: its amount, and a bar of the share of its proof on file. */
function Bar({
  label,
  amount,
  share,
  i,
}: {
  label: string
  amount: number
  share: number | null
  i: number
}) {
  return (
    <div className="msum-bar-row">
      <span>{label}</span>
      <span className="msum-meter" aria-hidden="true">
        <i
          style={{ ['--w' as string]: `${Math.round((share ?? 0) * 100)}%`, ['--i' as string]: i }}
        />
      </span>
      <span className="msum-amount">
        {share == null && !amount ? 'None' : <CountUp value={amount} delay={1300} />}
      </span>
    </div>
  )
}
