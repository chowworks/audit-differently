/*
 * The month page, the owner's own design (chosen 2026-10-16): four tiles, a seven-step stepper whose problems are red
 * and clickable, then "Expenses & Proof" and "Payroll & Proof", each a grid with a search and filter bar. Receipt
 * matching and payroll proof open as dialogs.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  ALLOCATION_TYPE_LABELS,
  DOCUMENT_PURPOSE_LABELS,
  PAYROLL_REPORT_LINES,
  isPayrollLine,
  type CheckDto,
  type DocumentPurpose,
  type ExpenseDto,
  type LineRow,
  type ReportDetail,
  type TagTarget,
  type WexPaymentDto,
} from '@ad/types'
import { money, payPeriodWords, shortDate } from '@/lib/format'
import { Button, Card, Chip, Empty, Modal, severityTone } from '@/components/ui'
import { DocumentLink } from '@/components/DocumentLink'
import { TagChips, typesFor } from '@/components/Tags'
import { FIELD_WORDS, FilterBar, searchOf, type FieldChoices, type FilterToken } from './FilterBar'
import {
  MonthHead,
  MoreMenu,
  STAGES,
  moreItems,
  funderOf,
  nextActionOf,
  plural,
  progressOf,
  scrollToExpense,
  skipFor,
  stageNote,
  type MonthLayoutProps,
  type MonthProgress,
  type StageKey,
} from './shared'

/** What a tile or a step filters the grids to. */
type Quick = 'blocker' | 'attention' | 'missing' | 'other' | null

type Dialog = 'receipts' | 'payroll' | 'earlier' | null

const C_STAGES: { key: StageKey | 'started'; label: string }[] = [
  { key: 'started', label: 'Start Month' },
  ...STAGES.map((st) => (st.key === 'blockers' ? { ...st, label: 'Resolve Issues' } : st)),
]

/** The working steps (record, proof, issues) and the ones that follow once they are done. */
const WORKING: (StageKey | 'started')[] = ['started', 'expenses', 'proof', 'blockers']

const PAYROLL_PURPOSES: DocumentPurpose[] = ['timesheet', 'register', 'payment']

/** The proof each expense needs (the same rule as ReportPage's ledger). */
function requiredPurposes(e: ExpenseDto): DocumentPurpose[] {
  const base: DocumentPurpose[] = isPayrollLine(e)
    ? ['timesheet', 'register', 'payment']
    : ['invoice', 'payment']
  return e.allocationType === 'direct' ? base : [...base, 'allocation']
}

const missingOf = (needed: DocumentPurpose[], docs: { purpose: DocumentPurpose }[]) =>
  needed.filter((p) => !docs.some((d) => d.purpose === p))

/** The words a search matches: amounts as typed, without $ and commas. */
const plain = (s: string) => s.toLowerCase().replace(/[$,]/g, '')
const matchesText = (text: string, parts: (string | number | null | undefined)[]) => {
  if (!text) return true
  const hay = plain(
    parts.map((x) => (typeof x === 'number' ? `${x.toFixed(2)} ${x}` : (x ?? ''))).join(' ')
  )
  return plain(text)
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w))
}

/** A budget-overrun check names its line first ("program-costs: cumulative … by $1,234.00."). */
/** The engagement's budget lines as the budget tile lists them; `line` is the budget line's id. */
type TileLine = Omit<LineRow, 'line'> & { line: string }
const tileLines = (r: ReportDetail): TileLine[] =>
  r.budgetLines.map((b) => ({
    line: b.id,
    label: b.name,
    budget: b.budget,
    previouslyBilled: b.previouslyBilled,
    billedThisPeriod: b.billedThisPeriod,
    cumulative: b.cumulative,
    remaining: b.remaining,
  }))

/** What a filter on the budget line calls an expense's line: its id, or "none" while it has none. */
const lineKey = (e: ExpenseDto) => e.budgetLineId ?? 'none'
const lineName = (r: ReportDetail, key: string) =>
  key === 'none'
    ? 'Needs a budget line'
    : key === 'wex-payments'
      ? 'Work experience payments'
      : (r.budgetLines.find((b) => b.id === key)?.name ?? key)

function overrunOf(k: CheckDto, lines: TileLine[]) {
  const line = lines.find((l) => k.message.startsWith(`${l.label}:`))
  if (!line) return null
  return { line: line.line }
}

/** Where each check shows: on its expense row, its payroll row, its report line, or above the grid. */
export function placeChecks(r: ReportDetail) {
  const onLine = new Map<string, { check: CheckDto }>()
  const loose: CheckDto[] = []
  let late: CheckDto | null = null
  const expenseIds = new Set(r.expenses.map((e) => e.id))
  const wexIds = new Set(r.wexPayments.map((w) => w.id))
  const paid = new Set(r.wexPayments.map((w) => w.participantId))
  for (const k of r.checks) {
    if (k.code === 'late-submission') {
      late ??= k
    } else if (k.code === 'budget-overrun') {
      const o = overrunOf(k, tileLines(r))
      if (o) onLine.set(o.line, { check: k })
      else loose.push(k)
    } else if (k.expenseId ? expenseIds.has(k.expenseId) : false) continue
    else if (k.wexPaymentId ? wexIds.has(k.wexPaymentId) : false) continue
    else if (k.participantId && paid.has(k.participantId)) continue
    else loose.push(k)
  }
  return { onLine, loose, late }
}

const checksOfExpense = (r: ReportDetail, e: ExpenseDto) =>
  r.checks.filter((k) => k.expenseId === e.id)
const checksOfPayment = (r: ReportDetail, w: WexPaymentDto) =>
  r.checks.filter(
    (k) =>
      k.wexPaymentId === w.id ||
      (!k.expenseId && !k.wexPaymentId && k.participantId === w.participantId)
  )

const QUICK_WORDS: Record<Exclude<Quick, null>, string> = {
  blocker: 'with a blocking check',
  attention: 'that need attention',
  missing: 'missing proof',
  other: 'with an issue',
}

/** The chip a tile or a step puts in the search bar. */
const QUICK_CHIPS: Record<Exclude<Quick, null>, string> = {
  blocker: 'Blocking',
  attention: 'Needs attention',
  missing: 'Missing proof',
  other: 'Issues',
}

/** Whether a row's checks pass the tile or step filter. */
function passesQuick(quick: Quick, checks: CheckDto[], otherIds: Set<string>) {
  if (quick === 'blocker' || quick === 'attention') return checks.some((k) => k.severity === quick)
  if (quick === 'other') return checks.some((k) => otherIds.has(k.id))
  return true
}

/** Needs-attention chips are caution yellow in this layout. */
const cautionOf = (k: CheckDto) => (k.severity === 'attention' ? 'rl-c-chip-caution' : undefined)

/** Row checks open by themselves when the grid is filtered to checks. */
const quickOpensChecks = (quick: Quick) =>
  quick === 'blocker' || quick === 'attention' || quick === 'other'

export function LayoutC({ r, busy, notice, highlight, sections: s, act }: MonthLayoutProps) {
  const p = progressOf(r)
  const [quick, setQuick] = useState<Quick>(null)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [expTokens, setExpTokens] = useState<FilterToken[]>([])
  const [expText, setExpText] = useState('')
  const [payTokens, setPayTokens] = useState<FilterToken[]>([])
  const [payText, setPayText] = useState('')

  useEffect(() => scrollToExpense(highlight), [highlight])

  const draft = r.status === 'draft'
  const placed = placeChecks(r)
  const filterTo = (q: Quick) => setQuick((now) => (now === q ? null : q))
  const next = nextActionOf(r, p, act, () => setQuick('other'))
  const unmatched = r.matching.receipts.filter((x) => !x.dismissed && x.matchedTo.length === 0)
  const filterLine = (line: string, label: string) => {
    const of = r.budgetLines.find((b) => b.id === line)
    const payroll = !!of && PAYROLL_REPORT_LINES.has(of.reportLine)
    const [tokens, set] = payroll ? [payTokens, setPayTokens] : [expTokens, setExpTokens]
    if (!tokens.some((t) => t.field === 'line' && t.value === line))
      set([...tokens.filter((t) => t.field !== 'line'), { field: 'line', value: line, label }])
  }

  const row = actionRowOf(r, p, next, act)
  const more = [
    // The action row shows the current step's buttons, so the menu keeps the other steps' actions.
    ...moreItems(r, act, ['add', 'import', ...skipFor(next), ...(row?.skip ?? [])]),
    ...(r.reopenings.length
      ? [
          {
            label: `Earlier submissions (${r.reopenings.length})`,
            onClick: () => setDialog('earlier'),
          },
        ]
      : []),
  ]

  return (
    <div className="rl rl-c">
      <MonthHead r={r} p={p} facts={false}>
        {more.length > 0 && <MoreMenu items={more} busy={busy} />}
      </MonthHead>

      <Tiles
        r={r}
        p={p}
        quick={quick}
        onQuick={filterTo}
        onLine={filterLine}
        overruns={placed.onLine}
        late={placed.late}
        stepper={<Stepper r={r} p={p} draft={draft} onQuick={filterTo} />}
      />

      {row && <ActionRow row={row} busy={busy} />}

      {notice}

      <ExpensesSection
        r={r}
        p={p}
        busy={busy}
        act={act}
        quick={quick}
        clearQuick={() => setQuick(null)}
        tokens={expTokens}
        onTokens={setExpTokens}
        text={expText}
        onText={setExpText}
        loose={placed.loose}
        highlight={highlight}
        recordingIsNext={p.current === 'expenses'}
        unmatched={unmatched.length}
        openReceipts={() => setDialog('receipts')}
      />

      <PayrollSection
        r={r}
        p={p}
        act={act}
        quick={quick}
        clearQuick={() => setQuick(null)}
        tokens={payTokens}
        onTokens={setPayTokens}
        text={payText}
        onText={setPayText}
        openProof={() => setDialog('payroll')}
      />

      {dialog === 'receipts' && (
        <Modal title="Match receipts" onClose={() => setDialog(null)} wide>
          <div className="rl-c-dialog">{s.receipts}</div>
        </Modal>
      )}
      {dialog === 'payroll' && (
        <Modal title="Match payroll & timecards" onClose={() => setDialog(null)} full>
          <div className="rl-c-dialog">{s.payrollProof}</div>
        </Modal>
      )}
      {dialog === 'earlier' && (
        <Modal title="Earlier submissions" onClose={() => setDialog(null)} wide>
          <div className="rl-c-dialog">{s.earlier}</div>
        </Modal>
      )}
    </div>
  )
}

/** "Sep 12, 2026", wrapping only between "Sep 12," and "2026". */
function DueDate({ iso }: { iso: string }) {
  const words = shortDate(iso)
  const cut = words.lastIndexOf(' ')
  if (cut < 0) return <>{words}</>
  return (
    <>
      <span className="rl-nowrap">{words.slice(0, cut)}</span>{' '}
      <span className="rl-nowrap">{words.slice(cut + 1)}</span>
    </>
  )
}

/** How many budget lines fit in the tile's fixed height; more open in a dialog ("Show all"). */
const LINES_SHOWN = 6

/** Blocking, Needs attention, Due, Monthly budget status: the original page's tiles. */
function Tiles({
  r,
  p,
  quick,
  onQuick,
  onLine,
  overruns,
  late,
  stepper,
}: {
  r: ReportDetail
  p: MonthProgress
  quick: Quick
  onQuick: (q: Quick) => void
  onLine: (line: string, label: string) => void
  overruns: Map<string, { check: CheckDto }>
  /** The month's late-submission check, shown on the Due tile. */
  late: CheckDto | null
  /** The stepper, under the three small tiles, beside the taller budget tile. */
  stepper: ReactNode
}) {
  const [allLines, setAllLines] = useState(false)
  const daysLate = Math.max(
    0,
    Math.round(
      ((r.submittedAt ? new Date(r.submittedAt) : new Date()).getTime() -
        new Date(r.dueDate).getTime()) /
        86_400_000
    )
  )
  const used = tileLines(r).filter(
    (l) => l.budget > 0 || l.billedThisPeriod > 0 || l.previouslyBilled > 0
  )
  // Over-budget lines first, so the collapsed tile always shows them.
  const lines = [
    ...used.filter((l) => overruns.has(l.line)),
    ...used.filter((l) => !overruns.has(l.line)),
  ]
  const limit = Math.max(LINES_SHOWN, overruns.size)
  const shown = lines.slice(0, limit)
  const over = [...overruns.values()]
  const overWarn = over.some((o) => o.check.severity === 'blocker')
  const lineRows = (rows: typeof lines, after?: () => void) => (
    <>
      {rows.map((l) => {
        const o = overruns.get(l.line)
        return (
          <tr
            key={l.line}
            className={o ? `rl-c-line-over rl-c-line-${o.check.severity}` : undefined}
          >
            <td>
              <button
                type="button"
                className="rl-c-linkbtn"
                onClick={() => {
                  onLine(l.line, l.label)
                  after?.()
                }}
                title={o ? o.check.message : `Show the ${l.label} rows`}
              >
                {l.label}
              </button>
            </td>
            <td className="ad-num">{money(l.billedThisPeriod)}</td>
            <td className={`ad-num ${l.remaining < 0 ? 'rl-c-neg' : ''}`}>{money(l.remaining)}</td>
          </tr>
        )
      })}
    </>
  )
  return (
    <div className="rl-c-tiles">
      <button
        type="button"
        className={`ad-tile rl-c-tilebtn ${p.blockers.length ? 'ad-tile-warn' : ''}`}
        aria-pressed={quick === 'blocker'}
        onClick={() => onQuick('blocker')}
        disabled={!p.blockers.length}
      >
        <span className="ad-tile-label">Blocking</span>
        <span className="ad-tile-value">{p.blockers.length}</span>
        <span className="ad-tile-note">
          {p.blockers.length
            ? quick === 'blocker'
              ? 'Shown below · click to clear'
              : 'Show them in the grid'
            : 'Nothing blocks the closing'}
        </span>
      </button>
      <button
        type="button"
        className={`ad-tile rl-c-tilebtn ${p.attention.length ? 'rl-c-tile-attention' : ''}`}
        aria-pressed={quick === 'attention'}
        onClick={() => onQuick('attention')}
        disabled={!p.attention.length}
      >
        <span className="ad-tile-label">Needs attention</span>
        <span className="ad-tile-value">{p.attention.length}</span>
        <span className="ad-tile-note">
          {p.attention.length
            ? quick === 'attention'
              ? 'Shown below · click to clear'
              : 'Show them in the grid'
            : 'Nothing flagged'}
        </span>
      </button>
      <div
        className={`ad-tile rl-c-due ${late ? `rl-c-tile-late rl-c-tile-late-${late.severity}` : ''}`}
        title={late?.message}
      >
        <span className="ad-tile-label">Due</span>
        <span className="ad-tile-value">
          <DueDate iso={r.dueDate} />
        </span>
        {late && (
          <span className="rl-c-late">
            Late: {plural(daysLate, 'day')} past due. {late.message}
          </span>
        )}
        <span className="ad-tile-note">
          {r.submittedAt
            ? `Sent ${shortDate(r.submittedAt)}`
            : `Day ${r.engagement.reportDueDay} of each month`}
        </span>
      </div>
      <div className={`ad-tile rl-c-lines ${overWarn ? 'ad-tile-warn' : ''}`}>
        <span className="rl-c-lines-head">
          <span className="ad-tile-label">Monthly budget status</span>
          <b>{money(p.billed)}</b>
        </span>
        <table className="rl-c-lines-table">
          <thead>
            <tr>
              <th>Budget line</th>
              <th className="ad-num">This month</th>
              <th className="ad-num">Left</th>
            </tr>
          </thead>
          <tbody>{lineRows(shown)}</tbody>
        </table>
        <span className="rl-c-lines-foot">
          {lines.length > limit && (
            <button
              type="button"
              className="rl-c-linkbtn rl-c-lines-more"
              onClick={() => setAllLines(true)}
            >
              Show all {lines.length} budget lines
            </button>
          )}
          <Link to={`/reports/${r.id}/form`}>Budget and cumulative on the funder's form</Link>
        </span>
      </div>
      {allLines && (
        <Modal title="Monthly budget status" onClose={() => setAllLines(false)} wide>
          <table className="rl-c-lines-table rl-c-lines-table-all">
            <thead>
              <tr>
                <th>Budget line</th>
                <th className="ad-num">This month</th>
                <th className="ad-num">Left</th>
              </tr>
            </thead>
            <tbody>{lineRows(lines, () => setAllLines(false))}</tbody>
          </table>
        </Modal>
      )}
      {stepper}
    </div>
  )
}

/**
 * The seven steps: done only when every step before is done; a step with problems is red and filters the grid.
 * While the month is being worked (record, proof, issues), those steps are full size and the rest fold into one
 * muted "Then: …"; once they are done the closing steps open and the working steps shrink. Closed or sent: all
 * steps alike. Only the current step has a button.
 */
function Stepper({
  r,
  p,
  draft,
  onQuick,
}: {
  r: ReportDetail
  p: MonthProgress
  draft: boolean
  onQuick: (q: Quick) => void
}) {
  let allBefore = true
  const working = draft && (!p.done.expenses || !p.done.proof || !p.done.blockers)
  const ready = draft && !working
  const problem: Partial<Record<StageKey, { text: string; quick: Quick }>> = draft
    ? {
        ...(p.missing.length && {
          proof: { text: `${p.missing.length} missing`, quick: 'missing' as const },
        }),
        ...(p.otherBlockers.length && {
          blockers: { text: plural(p.otherBlockers.length, 'issue'), quick: 'other' as const },
        }),
      }
    : {}
  const steps = C_STAGES.map((st, i) => {
    const own = st.key === 'started' ? true : p.done[st.key]
    allBefore = allBefore && own
    const bad = st.key !== 'started' ? problem[st.key] : undefined
    const state = allBefore ? 'done' : bad ? 'bad' : st.key === p.current ? 'current' : 'todo'
    const isWorking = WORKING.includes(st.key)
    if (working && !isWorking) return null
    // Approve / sign / send phase: steps 1-4 fold into one segment ahead (EARLIER below).
    if (!working && i < EARLIER.length) return null
    return (
      <li
        key={st.key}
        className={`rl-step rl-step-${state} rl-c-step ${ready && isWorking ? 'rl-c-step-compact' : ''}`}
        aria-current={st.key === p.current ? 'step' : undefined}
      >
        <span className="rl-step-mark" aria-hidden="true">
          {i + 1}
        </span>
        <span className="rl-step-text">
          <span className="rl-step-label">
            {state === 'done' && (
              <span className="rl-c-donecheck" aria-hidden="true">
                ✓{' '}
              </span>
            )}
            {state === 'bad' && (
              <span className="rl-c-badsign" aria-hidden="true">
                !{' '}
              </span>
            )}
            {st.label}
          </span>
          {bad ? (
            <button
              type="button"
              className="rl-c-stepbad"
              onClick={() => onQuick(bad.quick)}
              title="Show them in the grid"
            >
              {bad.text}
            </button>
          ) : (
            <span className="rl-step-note">
              {st.key === 'started'
                ? 'a draft is open'
                : st.key === 'blockers'
                  ? 'No issues'
                  : stageNote(r, p, st.key)}
            </span>
          )}
        </span>
      </li>
    )
  })
  return (
    <ol
      className={`rl-c-stepper ${working ? 'rl-c-stepper-working' : 'rl-c-stepper-ready'}`}
      aria-label="The month's steps"
    >
      {!working && (
        <li
          className="rl-step rl-step-done rl-c-step rl-c-step-later rl-c-step-earlier"
          title="Done: Start Month, Record Expenses & Payroll, Attach Proof & Reconcile, Resolve Issues"
        >
          <span className="rl-c-later-marks" aria-hidden="true">
            {EARLIER.map((n) => (
              <span key={n} className="rl-c-later-mark rl-c-earlier-mark">
                {n}
              </span>
            ))}
          </span>
          <span className="rl-step-note">
            <span className="sr-only">Steps 1 to 4 done: </span>
            <span className="rl-c-donecheck" aria-hidden="true">
              ✓{' '}
            </span>
            Record. Attach. Resolve.
          </span>
        </li>
      )}
      {steps}
      {working && (
        <li
          className="rl-step rl-step-todo rl-c-step rl-c-step-later"
          title="Then: Approve Month End, Sign & Finalize, Ship It"
        >
          <span className="rl-c-later-marks" aria-hidden="true">
            {LATER.map((n) => (
              <span key={n} className="rl-c-later-mark">
                {n}
              </span>
            ))}
          </span>
          <span className="rl-step-note">
            <span className="sr-only">Then steps 5 to 7: </span>Approve. Sign. Ship.
          </span>
        </li>
      )}
    </ol>
  )
}

/** The folded steps' numbers while the month is being worked. */
const LATER = [5, 6, 7]
/** The working steps, folded once the month moves on to approve, sign and send. */
const EARLIER = [1, 2, 3, 4]

interface RowButton {
  label: string
  kind: 'primary' | 'navy'
  onClick: () => void
}

interface ActionRowModel {
  sentence: string
  buttons: RowButton[]
  /** The More items the row already shows. */
  skip: string[]
}

/**
 * The current step's actions, in one row under the stepper, from the closing on. None while the month is being
 * worked (the grids are the work). An auditor gets the sentence alone.
 */
function actionRowOf(
  r: ReportDetail,
  p: MonthProgress,
  next: ReturnType<typeof nextActionOf>,
  act: MonthLayoutProps['act']
): ActionRowModel | null {
  const edits: RowButton = { label: '✏️ Request edits', kind: 'navy', onClick: act.requestEdits }
  const buttons: RowButton[] = []
  const skip: string[] = []
  if (r.status === 'draft') {
    if (p.current !== 'closing') return null
    if (r.can.close)
      buttons.push({ label: '✅ Approve Month End', kind: 'primary', onClick: act.approve })
    if (r.can.requestEdits) buttons.push(edits)
    return { sentence: next.sentence, buttons, skip }
  }
  if (r.status === 'closed') {
    if (!r.signedCopy) {
      if (r.can.attachSigned)
        buttons.push({
          label: '📎 Attach the signed copy',
          kind: 'primary',
          onClick: act.attachSigned,
        })
      if (r.can.requestEdits) {
        buttons.push(edits)
        skip.push('send-back')
      }
    } else if (r.can.submit) {
      buttons.push({ label: '📤 Send it', kind: 'primary', onClick: act.submit })
    }
    return { sentence: next.sentence, buttons, skip }
  }
  // Submitted.
  const sent = `Sent to ${funderOf(r)}${r.submittedAt ? ` on ${shortDate(r.submittedAt)}` : ''}.`
  if (!r.signedCopy && r.can.attachSigned)
    buttons.push({ label: '📎 Attach the signed copy', kind: 'primary', onClick: act.attachSigned })
  if (r.can.reopen) {
    buttons.push({ label: '↩️ Reopen to correct', kind: 'navy', onClick: act.reopen })
    skip.push('reopen')
  }
  return {
    sentence: r.signedCopy ? sent : `${sent} Its signed copy is not on file yet.`,
    buttons,
    skip,
  }
}

function ActionRow({ row, busy }: { row: ActionRowModel; busy: boolean }) {
  return (
    <div className="rl-c-actionrow" role="region" aria-label="What to do now">
      <p>{row.sentence}</p>
      {row.buttons.length > 0 && (
        <div className="rl-c-actionrow-buttons">
          {row.buttons.map((b) => (
            <Button key={b.label} kind={b.kind} onClick={b.onClick} disabled={busy}>
              {b.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}

/** "Showing 17 of 40 expenses missing proof · Clear filter", when anything filters the grid. */
function FilterNote({
  shown,
  total,
  noun,
  quick,
  tokens,
  text,
  onClear,
}: {
  shown: number
  total: number
  noun: string
  quick: Quick
  tokens: FilterToken[]
  text: string
  onClear: () => void
}) {
  if (!quick && !tokens.length && !text) return null
  const parts = [
    ...tokens.map((t) => `${FIELD_WORDS[t.field]}: ${t.label}`),
    text && `matching "${text}"`,
  ].filter(Boolean)
  return (
    <div className="rl-c-filternote" role="status">
      <span>
        Showing <strong>{shown}</strong> of {plural(total, noun)}
        {quick ? ` ${QUICK_WORDS[quick]}` : ''}
        {parts.length ? ` · ${parts.join(' · ')}` : ''}
      </span>
      <Button size="sm" kind="navy" onClick={onClear}>
        Clear filter
      </Button>
    </div>
  )
}

/** A row's checks, folded behind "see checks" unless the grid is filtered to them. */
function RowChecks({ checks, open }: { checks: CheckDto[]; open: boolean }) {
  return (
    <ul className="rl-c-rowchecks" hidden={!open}>
      {checks.map((k) => (
        <li key={k.id}>
          <Chip tone={severityTone[k.severity]} fill className={cautionOf(k)}>
            {k.severity === 'blocker' ? 'blocking' : k.severity}
          </Chip>
          <span>{k.message}</span>
        </li>
      ))}
    </ul>
  )
}

function useOpenChecks() {
  const [open, setOpen] = useState<Set<string>>(new Set())
  const toggle = (id: string) =>
    setOpen((o) => {
      const n = new Set(o)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  return [open, toggle] as const
}

function SeeChecks({
  checks,
  open,
  onToggle,
}: {
  checks: CheckDto[]
  open: boolean
  onToggle: () => void
}) {
  if (!checks.length) return null
  const worst = checks.some((k) => k.severity === 'blocker')
    ? 'blocker'
    : checks.some((k) => k.severity === 'attention')
      ? 'attention'
      : 'info'
  return (
    <button
      type="button"
      className={`rl-c-seechecks rl-c-seechecks-${worst}`}
      aria-expanded={open}
      onClick={onToggle}
    >
      {open ? 'hide' : 'see'} {plural(checks.length, 'check')}
    </button>
  )
}

const tagChoices = (r: ReportDetail, target: TagTarget): FieldChoices => ({
  field: 'tag',
  hint: 'a tag',
  options: typesFor(r.tagTypes, target).flatMap((t) =>
    t.values.map((v) => ({ value: `${t.key}:${v.key}`, label: `${t.label}: ${v.label}` }))
  ),
})

const matchesTokens = (
  tokens: FilterToken[],
  row: { tags: string[]; line: string; missing: DocumentPurpose[] }
) =>
  tokens.every((t) =>
    t.field === 'tag'
      ? row.tags.includes(t.value)
      : t.field === 'line'
        ? row.line === t.value
        : row.missing.includes(t.value as DocumentPurpose)
  )

function ExpensesSection({
  r,
  p,
  busy,
  act,
  quick,
  clearQuick,
  tokens,
  onTokens,
  text,
  onText,
  loose,
  highlight,
  recordingIsNext,
  unmatched,
  openReceipts,
}: {
  r: ReportDetail
  p: MonthProgress
  busy: boolean
  act: MonthLayoutProps['act']
  quick: Quick
  clearQuick: () => void
  tokens: FilterToken[]
  onTokens: (t: FilterToken[]) => void
  text: string
  onText: (t: string) => void
  loose: CheckDto[]
  highlight: string | null
  recordingIsNext: boolean
  unmatched: number
  openReceipts: () => void
}) {
  const [openChecks, toggleChecks] = useOpenChecks()
  const all = r.expenses.filter((e) => !isPayrollLine(e))
  const needed = new Set(all.flatMap(requiredPurposes))
  const fields: FieldChoices[] = [
    tagChoices(r, 'expense'),
    {
      field: 'line',
      hint: 'a budget line',
      options: [...new Set(all.map(lineKey))].map((l) => ({ value: l, label: lineName(r, l) })),
    },
    {
      field: 'missing',
      hint: 'missing proof',
      options: (['invoice', 'payment', 'allocation'] as DocumentPurpose[])
        .filter((x) => needed.has(x))
        .map((x) => ({ value: x, label: DOCUMENT_PURPOSE_LABELS[x] })),
    },
  ]
  const search = searchOf(text, fields)
  const missingIds = new Set(p.missing.map((m) => m.expense.id))
  const otherIds = new Set(p.otherBlockers.map((k) => k.id))
  const rows = all.filter((e) => {
    const checks = checksOfExpense(r, e)
    if (quick === 'missing' && !missingIds.has(e.id)) return false
    if (!passesQuick(quick, checks, otherIds)) return false
    return (
      matchesTokens(tokens, {
        tags: e.tags,
        line: lineKey(e),
        missing: missingOf(requiredPurposes(e), e.documents),
      }) &&
      matchesText(search, [
        e.vendor,
        e.itemNumber,
        e.memo,
        e.account,
        e.totalCost,
        e.allocatedAmount,
      ])
    )
  })
  const clear = () => {
    clearQuick()
    onTokens([])
    onText('')
  }
  const addProof = (e: ExpenseDto, purpose: DocumentPurpose) =>
    purpose === 'invoice' && unmatched > 0 ? openReceipts() : act.attach(e, purpose)

  return (
    <Card
      className="rl-c-section"
      title={<span id="rl-c-expenses">Expenses &amp; Proof</span>}
      aside={
        r.can.edit ? (
          <>
            <Button
              kind={recordingIsNext ? 'primary' : 'navy'}
              onClick={act.addExpense}
              disabled={busy}
              data-testid="add-expense"
            >
              + Add expense
            </Button>
            <Button kind="navy" onClick={act.importTransactions} disabled={busy}>
              Import transactions
            </Button>
            <Button
              kind="navy"
              onClick={openReceipts}
              className="rl-c-badged"
              title={
                unmatched
                  ? `${unmatched} unmatched ${unmatched === 1 ? 'receipt' : 'receipts'}`
                  : undefined
              }
              aria-label={
                unmatched
                  ? `Match receipts: ${unmatched} unmatched ${unmatched === 1 ? 'receipt' : 'receipts'}`
                  : undefined
              }
            >
              Match receipts
              {unmatched > 0 && (
                <span className="rl-c-badge" aria-hidden="true">
                  {unmatched}
                </span>
              )}
            </Button>
          </>
        ) : (
          <Button kind="navy" onClick={openReceipts}>
            Receipts
          </Button>
        )
      }
    >
      {loose.length > 0 && (
        <ul className="rl-c-alerts" aria-label="Checks on the whole month">
          {loose.map((k) => (
            <li key={k.id} className={`rl-c-alert rl-c-alert-${k.severity}`}>
              <Chip tone={severityTone[k.severity]} fill className={cautionOf(k)}>
                {k.severity === 'blocker' ? 'blocking' : k.severity}
              </Chip>
              <span>{k.message}</span>
              {k.participantId && (
                <Link to={`/engagements/${r.engagement.id}#participants`}>Open the file</Link>
              )}
            </li>
          ))}
        </ul>
      )}
      {all.length > 0 && (
        <FilterBar
          fields={fields}
          tokens={tokens}
          onTokens={onTokens}
          text={text}
          onText={onText}
          pinned={quick ? { label: QUICK_CHIPS[quick], onRemove: clearQuick } : null}
          placeholder="Search vendor, item, memo or amount · type tag:, budget line: or missing:"
        />
      )}
      <FilterNote
        shown={rows.length}
        total={all.length}
        noun="expense"
        quick={quick}
        tokens={tokens}
        text={search}
        onClear={clear}
      />
      {all.length === 0 && <Empty>No expenses yet.</Empty>}
      {all.length > 0 && rows.length === 0 && <Empty>No expense matches this filter.</Empty>}
      {rows.length > 0 && (
        <div className="ad-tablewrap">
          <table className="ad-table">
            <thead>
              <tr>
                <th>Item</th>
                <th>Vendor</th>
                <th>Budget line</th>
                <th className="ad-num">Total</th>
                <th className="ad-num">Charged</th>
                <th>Proof</th>
                {r.can.edit && <th></th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => {
                const checks = checksOfExpense(r, e)
                const shownChecks = quickOpensChecks(quick) || openChecks.has(e.id)
                return (
                  <tr
                    key={e.id}
                    id={`expense-${e.id}`}
                    className={highlight === e.id ? 'ad-row-flash' : undefined}
                    data-testid={`expense-${e.itemNumber}`}
                  >
                    <td className="whitespace-nowrap">
                      <span className="ad-mono font-semibold">{e.itemNumber}</span>
                      <span className="ad-table-sub">{e.date}</span>
                    </td>
                    <td>
                      <span className="font-semibold">{e.vendor}</span>
                      <span className="ad-table-sub">
                        {e.memo}
                        {e.account ? ` · ${e.account}` : ''}
                      </span>
                      <TagChips types={r.tagTypes} tags={e.tags} />
                    </td>
                    <td>
                      {e.budgetLineName ?? <span className="text-danger">Needs a budget line</span>}
                      {e.allocationType !== 'direct' && (
                        <span className="ad-table-sub">
                          {ALLOCATION_TYPE_LABELS[e.allocationType]}
                          {e.allocationNote ? `: ${e.allocationNote}` : ''}
                        </span>
                      )}
                    </td>
                    <td className="ad-num">{money(e.totalCost)}</td>
                    <td className="ad-num font-semibold">{money(e.allocatedAmount)}</td>
                    <td>
                      <ProofChips
                        can={r.can.edit}
                        needed={requiredPurposes(e)}
                        docs={e.documents}
                        testId={e.itemNumber}
                        onAdd={(purpose) => addProof(e, purpose)}
                      />
                      <SeeChecks
                        checks={checks}
                        open={shownChecks}
                        onToggle={() => toggleChecks(e.id)}
                      />
                      <RowChecks checks={checks} open={shownChecks} />
                    </td>
                    {r.can.edit && (
                      <td className="ad-num whitespace-nowrap">
                        <Button kind="ghost" onClick={() => act.editExpense(e)}>
                          edit
                        </Button>
                        <Button
                          kind="ghost"
                          className="text-danger"
                          onClick={() => act.deleteExpense(e)}
                          data-testid={`delete-${e.itemNumber}`}
                        >
                          remove
                        </Button>
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

/** The proof a row needs: a green chip for each on file, a red "+" for each missing. */
function ProofChips({
  can,
  needed,
  docs,
  testId,
  onAdd,
  proofOf,
  files = true,
}: {
  can: boolean
  needed: DocumentPurpose[]
  docs: ExpenseDto['documents']
  testId: string
  onAdd: (purpose: DocumentPurpose) => void
  /** A payroll item: its proofs open as its own highlighted copies. */
  proofOf?: { target: 'expense' | 'wex'; id: string }
  /** False: "Bookkeepers see staff payroll" is off, so the proofs show as labels that open nothing. */
  files?: boolean
}) {
  const have = new Map(docs.map((d) => [d.purpose, d]))
  const extra = docs.filter((d) => !needed.includes(d.purpose))
  return (
    <div className="flex flex-wrap gap-1">
      {needed.map((purpose) => {
        const d = have.get(purpose)
        return d ? (
          <Chip key={purpose} tone="ok" fill title={files ? d.document.fileName : undefined}>
            {files ? (
              <DocumentLink doc={d.document} proofOf={proofOf}>
                ✓ {DOCUMENT_PURPOSE_LABELS[purpose]}
              </DocumentLink>
            ) : (
              <>✓ {DOCUMENT_PURPOSE_LABELS[purpose]}</>
            )}
          </Chip>
        ) : can ? (
          <button
            key={purpose}
            type="button"
            className="ad-chip ad-chip-missing"
            onClick={() => onAdd(purpose)}
            data-testid={`attach-${testId}-${purpose}`}
          >
            + {DOCUMENT_PURPOSE_LABELS[purpose]}
          </button>
        ) : (
          <Chip key={purpose} tone="danger" fill>
            missing {DOCUMENT_PURPOSE_LABELS[purpose]}
          </Chip>
        )
      })}
      {extra.map((d) => (
        <Chip key={d.document.id} tone="muted" title={files ? d.document.fileName : undefined}>
          {files ? (
            <DocumentLink doc={d.document}>{DOCUMENT_PURPOSE_LABELS[d.purpose]}</DocumentLink>
          ) : (
            DOCUMENT_PURPOSE_LABELS[d.purpose]
          )}
        </Chip>
      ))}
    </div>
  )
}

type PayRow =
  { kind: 'expense'; id: string; e: ExpenseDto } | { kind: 'wex'; id: string; w: WexPaymentDto }

function PayrollSection({
  r,
  p,
  act,
  quick,
  clearQuick,
  tokens,
  onTokens,
  text,
  onText,
  openProof,
}: {
  r: ReportDetail
  p: MonthProgress
  act: MonthLayoutProps['act']
  quick: Quick
  clearQuick: () => void
  tokens: FilterToken[]
  onTokens: (t: FilterToken[]) => void
  text: string
  onText: (t: string) => void
  openProof: () => void
}) {
  const [openChecks, toggleChecks] = useOpenChecks()
  const all: PayRow[] = [
    ...r.expenses
      // A books' payroll transaction the match covers is no longer the month's pay: it shows in the reconciliation only.
      .filter((e) => isPayrollLine(e) && e.counts)
      .map((e) => ({ kind: 'expense' as const, id: e.id, e })),
    ...r.wexPayments.map((w) => ({ kind: 'wex' as const, id: w.id, w })),
  ]
  const facts = (row: PayRow) =>
    row.kind === 'expense'
      ? {
          checks: checksOfExpense(r, row.e),
          needed: requiredPurposes(row.e),
          docs: row.e.documents,
          tags: row.e.tags,
          line: lineKey(row.e),
          words: [
            row.e.vendor,
            row.e.itemNumber,
            row.e.memo,
            row.e.account,
            row.e.totalCost,
            row.e.allocatedAmount,
          ],
        }
      : {
          checks: checksOfPayment(r, row.w),
          needed: PAYROLL_PURPOSES,
          docs: row.w.documents,
          tags: row.w.tags,
          line: 'wex-payments',
          words: [row.w.participantName, row.w.participantNumber, row.w.grossAmount],
        }
  const fields: FieldChoices[] = [
    {
      field: 'tag',
      hint: 'a tag',
      options: [...tagChoices(r, 'payroll').options, ...tagChoices(r, 'expense').options].filter(
        (o, i, xs) => xs.findIndex((x) => x.value === o.value) === i
      ),
    },
    {
      field: 'line',
      hint: 'a budget line',
      options: [...new Set(all.map((row) => facts(row).line))].map((l) => ({
        value: l,
        label: lineName(r, l),
      })),
    },
    {
      field: 'missing',
      hint: 'missing proof',
      options: (['timesheet', 'register', 'payment', 'allocation'] as DocumentPurpose[])
        .filter((x) => all.some((row) => facts(row).needed.includes(x)))
        .map((x) => ({ value: x, label: DOCUMENT_PURPOSE_LABELS[x] })),
    },
  ]
  const search = searchOf(text, fields)
  const missingIds = new Set(p.missing.map((m) => m.expense.id))
  const otherIds = new Set(p.otherBlockers.map((k) => k.id))
  const rows = all.filter((row) => {
    const f = facts(row)
    const missing = missingOf(f.needed, f.docs)
    if (quick === 'missing' && !(row.kind === 'expense' ? missingIds.has(row.id) : missing.length))
      return false
    if (!passesQuick(quick, f.checks, otherIds)) return false
    return (
      matchesTokens(tokens, { tags: f.tags, line: f.line, missing }) && matchesText(search, f.words)
    )
  })
  const clear = () => {
    clearQuick()
    onTokens([])
    onText('')
  }
  // "Bookkeepers see staff payroll" off: the same rows, but no proof opens its file (the screen only).
  const files = r.can.seeStaffPayroll !== false
  const hasStatements = r.payrollDocuments.some((d) => d.kind === 'bank-statement')
  // Payroll items still missing any of their three proofs: the count on the matching button.
  const unproved = all.filter(
    (row) => missingOf(facts(row).needed, facts(row).docs).length > 0
  ).length
  const addProof = (row: PayRow, purpose: DocumentPurpose) => {
    // A staff line's evidence of payment is its bank line: found for this row alone, not the whole payroll match.
    // Finding it opens the statement, so with the files hidden the proof is attached like the others.
    if (purpose === 'payment' && row.kind === 'expense' && hasStatements && files)
      return act.findBankLine(row.e)
    if (row.kind === 'expense') act.attach(row.e, purpose)
    else act.attachPayment(row.w, purpose)
  }

  return (
    <Card
      className="rl-c-section"
      title={<span id="rl-c-payroll">Payroll &amp; Proof</span>}
      aside={
        <>
          {r.can.edit && (
            <Button kind="navy" onClick={act.addPayroll}>
              + Add payroll
            </Button>
          )}
          {/* The match shows the files themselves, so it is not offered when they are hidden. */}
          {files && (
            <Button
              kind="navy"
              onClick={openProof}
              className="rl-c-badged"
              title={
                unproved
                  ? `${unproved} payroll ${unproved === 1 ? 'item' : 'items'} missing proof`
                  : undefined
              }
            >
              Match payroll &amp; timecards
              {unproved > 0 && (
                <span className="rl-c-badge" aria-hidden="true">
                  {unproved}
                </span>
              )}
            </Button>
          )}
        </>
      }
    >
      <p className="rl-c-sectionnote">
        Timesheet, payroll register and evidence of payment for each payroll line and each
        participant paid. Pay stubs are personal records: every read logged.
      </p>
      {all.length > 0 && (
        <FilterBar
          fields={fields}
          tokens={tokens}
          onTokens={onTokens}
          text={text}
          onText={onText}
          pinned={quick ? { label: QUICK_CHIPS[quick], onRemove: clearQuick } : null}
          placeholder="Search name, item or amount · type tag:, budget line: or missing:"
        />
      )}
      <FilterNote
        shown={rows.length}
        total={all.length}
        noun="payroll row"
        quick={quick}
        tokens={tokens}
        text={search}
        onClear={clear}
      />
      {all.length === 0 && <Empty>No payroll this month.</Empty>}
      {all.length > 0 && rows.length === 0 && <Empty>No payroll row matches this filter.</Empty>}
      {rows.length > 0 && (
        <div className="ad-tablewrap">
          <table className="ad-table">
            <thead>
              <tr>
                <th>Vendor/Participant Paid</th>
                <th>Date</th>
                <th className="ad-num">Amount</th>
                <th>Proof</th>
                {r.can.edit && <th></th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const f = facts(row)
                const shownChecks = quickOpensChecks(quick) || openChecks.has(row.id)
                return (
                  <tr key={row.id} id={row.kind === 'expense' ? `expense-${row.id}` : undefined}>
                    <td>
                      {row.kind === 'expense' ? (
                        <>
                          <span className="ad-mono font-semibold">{row.e.itemNumber}</span>{' '}
                          <span className="font-semibold">{row.e.vendor}</span>
                          <span className="ad-table-sub">
                            {row.e.budgetLineName ?? 'Needs a budget line'}
                          </span>
                        </>
                      ) : (
                        <>
                          <span className="font-semibold">{row.w.participantName}</span>
                          <span className="ad-table-sub ad-mono">{row.w.participantNumber}</span>
                        </>
                      )}
                      <TagChips types={r.tagTypes} tags={f.tags} />
                    </td>
                    <td className="whitespace-nowrap">
                      {row.kind === 'expense'
                        ? shortDate(row.e.date)
                        : payPeriodWords(row.w.payPeriodStart, row.w.payPeriodEnd)}
                      {row.kind === 'wex' && row.w.hours != null && (
                        <span className="ad-table-sub">{row.w.hours} hours</span>
                      )}
                    </td>
                    <td className="ad-num font-semibold">
                      {money(row.kind === 'expense' ? row.e.allocatedAmount : row.w.grossAmount)}
                    </td>
                    <td>
                      <ProofChips
                        can={r.can.edit}
                        needed={f.needed}
                        docs={f.docs}
                        testId={row.kind === 'expense' ? row.e.itemNumber : row.w.participantNumber}
                        onAdd={(purpose) => addProof(row, purpose)}
                        proofOf={{ target: row.kind, id: row.id }}
                        files={files}
                      />
                      <SeeChecks
                        checks={f.checks}
                        open={shownChecks}
                        onToggle={() => toggleChecks(row.id)}
                      />
                      <RowChecks checks={f.checks} open={shownChecks} />
                    </td>
                    {r.can.edit && (
                      <td className="ad-num whitespace-nowrap">
                        {row.kind === 'expense' ? (
                          <>
                            <Button kind="ghost" onClick={() => act.editExpense(row.e)}>
                              edit
                            </Button>
                            <Button
                              kind="ghost"
                              className="text-danger"
                              onClick={() => act.deleteExpense(row.e)}
                            >
                              remove
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button kind="ghost" onClick={() => act.editPayment(row.w)}>
                              edit
                            </Button>
                            <Button
                              kind="ghost"
                              className="text-danger"
                              onClick={() => act.deletePayment(row.w)}
                            >
                              remove
                            </Button>
                          </>
                        )}
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}
