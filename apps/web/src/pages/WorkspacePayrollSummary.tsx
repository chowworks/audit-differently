// The page after the match (#22, owner's choice 2026-10-20, option D of the design experiment): Actions first, then
// Engagement Budget Tracking, then Workspace Reconciliation (only what is not resolved, its tiles filtering the
// grid), and the files and Match again last.
import { Fragment, useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  BOOKS_LINE_STATUS_LABELS,
  DOCUMENT_PURPOSE_LABELS,
  type DocumentPurpose,
  type ReportDetail,
  PAY_LINE_FLAG_LABELS,
  PAY_LINE_STATE_LABELS,
  PAYROLL_BUDGET_KIND_LABELS,
  REPORT_STATUS_LABELS,
  type EngagementPayrollCardDto,
  type PayLineDto,
  type PayrollReconciliationDto,
  type WorkspaceExpensesDto,
  type WorkspacePayrollOutputDto,
} from '@ad/types'
import { useLoad } from '@/hooks/useApi'
import { AddPayrollBudgetLine } from '@/components/AddPayrollBudgetLine'
import { ENGAGEMENT_COLORS } from '@/lib/engagement-colors'
import { EngagementMark } from '@/components/EngagementMark'
import { money, periodLabel, shortDate } from '@/lib/format'
import { Button, Card, Chip, Empty, ErrorNote } from '@/components/ui'
import type { ExpenseAction } from '@/pages/workspace-expenses'
import { SLOT_LABEL } from '@/components/payroll-match/why'
import { kindWord } from '@/pages/workspace-payroll-plan'
import {
  FilterBar,
  searchOf,
  type FieldChoices,
  type FilterToken,
} from '@/pages/report-layouts/FilterBar'
import {
  NO_ENGAGEMENT,
  TONES,
  agrees,
  grouped,
  type ExpenseRow,
  type PayRow,
  type Tone,
} from '@/pages/workspace-reconcile'
import type { RowEditing } from './report-layouts/row-editing'
import {
  addPayrollProof,
  ExpenseHead,
  ExpenseRow as MonthExpenseRow,
  PayrollHead,
  PayrollRow as MonthPayrollRow,
} from './report-layouts/proof-rows'
import './report-layouts/report-layouts.css'
import './workspace-payroll-summary.css'

const colorOf = (colors: Map<string, string>, id: string) => colors.get(id) ?? 'var(--navy)'

/** One thing to fix on an engagement, and where to fix it. */
interface Fix {
  text: string
  action: string
  href: string
}

/** What an engagement needs fixing this month, from its card and the reconciliation. */
function fixesOf(c: EngagementPayrollCardDto, recon: PayrollReconciliationDto | null): Fix[] {
  const month = `/reports/${c.reportId}`
  const out: Fix[] = []
  for (const s of c.staff)
    if (s.charged !== null) {
      const missing = (['timesheet', 'register', 'bank'] as const).filter((k) => !s.proof[k])
      if (missing.length)
        out.push({
          text: `${s.name}: no ${missing.map((k) => SLOT_LABEL[k === 'register' ? 'register' : k].toLowerCase()).join(', ')}`,
          action: 'Open month',
          href: month,
        })
    }
  for (const u of recon?.unproved ?? [])
    if (u.item.engagementId === c.engagementId)
      out.push({
        text: `${u.item.title}: no ${u.missing.map((m) => SLOT_LABEL[m].toLowerCase()).join(', ')}`,
        action: 'Open month',
        href: `/reports/${u.item.reportId}`,
      })
  const used = c.staffBudget.chargedBefore + c.charged
  if (c.staffBudget.approved > 0 && used > c.staffBudget.approved)
    out.push({
      text: `${money(used - c.staffBudget.approved)} over the staff budget`,
      action: 'See budget',
      href: `/engagements/${c.engagementId}`,
    })
  return out
}

/** The cards' data, loaded again after a save or a fix. */
export function useCards(workspaceId: string, period: string, version: number, enabled = true) {
  const { data, error, reload } = useLoad<WorkspacePayrollOutputDto>(
    enabled ? `/workspaces/${workspaceId}/payroll/${period}/engagements` : null
  )
  useEffect(() => {
    if (version) void reload()
  }, [version, reload])
  return { cards: data?.period === period ? data.engagements : null, error }
}

/** Each engagement's colour, as on the staffing page. */
export const colorsOf = (order: string[], ids: string[]) =>
  new Map(ids.map((id, i) => [id, colorAt(order, id, i)]))

const colorAt = (order: string[], id: string, i: number) => {
  const at = order.indexOf(id)
  return ENGAGEMENT_COLORS[(at >= 0 ? at : i) % ENGAGEMENT_COLORS.length]!
}

/** What to do this month: match it when it has no payroll files yet, else each thing to fix and where. */
export function PayrollActions({
  period,
  matched,
  cards,
  recon,
  colors,
  onMatch,
  onShow,
  onBudget,
  programs,
  expenses,
}: {
  period: string
  matched: boolean
  /**
   * The month's expense to-dos (owner's decision, 2026-11-13), with what their buttons do: open Expense matching, and
   * upload receipts right here (owners only).
   */
  expenses?: {
    rows: ExpenseAction[]
    onOpen: () => void
    onUpload?: (files: File[]) => void
    busy: boolean
    error: string | null
  }
  /**
   * The month's engagements no program name is (`engagementsWithoutProgram`), with where to link one: a timesheet's
   * project proves nothing of theirs until then.
   */
  programs?: { engagements: string[]; href: string } | null
  cards: EngagementPayrollCardDto[] | null
  recon: PayrollReconciliationDto | null
  colors: Map<string, string>
  /** A budget line was added from an action: owners only (the page reads the cards again). */
  onBudget?: () => void
  /** Opens the match: owners only (an auditor changes nothing, so sees no button). */
  onMatch?: () => void
  /** Filters the reconciliation's grid to one kind and scrolls to it. */
  onShow: (k: ResolveKind) => void
}) {
  const rows: {
    key: string
    sign: string
    color?: string
    who: ReactNode
    text: string
    sub?: string
    go: ReactNode
  }[] = []
  const all = cards ?? []
  if (!matched) {
    // The engagements' payroll is on their months already (the bookkeeper's ledger); the files that prove it are not.
    const staffPay = all.reduce((t, c) => t + c.charged, 0)
    const wex = all.reduce((t, c) => t + c.wex.payments, 0)
    const wexPay = all.reduce((t, c) => t + c.wex.thisMonth, 0)
    const parts = [
      staffPay > 0 && `${money(staffPay)} of staff pay and taxes`,
      wex > 0 && `${wex} work-experience ${wex === 1 ? 'payment' : 'payments'} (${money(wexPay)})`,
    ].filter(Boolean)
    rows.push({
      key: 'match',
      sign: '🧾',
      who: `${all.length} ${all.length === 1 ? 'engagement' : 'engagements'}`,
      text: `Match ${periodLabel(period)}'s payroll`,
      sub: parts.length
        ? `${parts.join(' and ')} on the months, with no payroll files to prove ${parts.length > 1 || wex > 1 ? 'them' : 'it'}. Upload the month's zip once.`
        : "No payroll on the months yet, and no payroll files. Upload the month's zip once.",
      go: onMatch ? (
        <Button kind="navy" onClick={onMatch}>
          Match payroll &amp; timecards
        </Button>
      ) : null,
    })
  }
  for (const name of programs?.engagements ?? [])
    rows.push({
      key: `no-program-${name}`,
      sign: '⚠️',
      who: name,
      text: 'No program name is linked to it',
      sub: "Its timesheets' projects prove none of its pay until one is. Link its program on the Program names card.",
      go: <Link to={programs!.href}>Link its program →</Link>,
    })
  for (const c of all) {
    const color = colorOf(colors, c.engagementId)
    for (const f of fixesOf(c, null))
      if (f.action !== 'See budget')
        rows.push({
          key: `${c.engagementId}-${f.text}`,
          sign: '⚠️',
          color,
          who: c.engagementName,
          text: f.text,
          go: <Link to={f.href}>{f.action} →</Link>,
        })
    for (const k of c.unbudgeted)
      rows.push({
        key: `${c.engagementId}-unbudgeted-${k}`,
        sign: '⛔',
        color,
        who: c.engagementName,
        text: `No budget line takes ${PAYROLL_BUDGET_KIND_LABELS[k].toLowerCase()}`,
        sub: 'Its payroll from the files is left off the budget. Add the line, then Re-match with same files and Save.',
        go: onBudget ? (
          <AddPayrollBudgetLine engagementId={c.engagementId} kind={k} onAdded={onBudget} />
        ) : (
          <Link to={`/engagements/${c.engagementId}`}>See budget →</Link>
        ),
      })
    for (const l of c.lines)
      if (l.remaining < 0)
        rows.push({
          key: `${c.engagementId}-over-${l.id}`,
          sign: '⛔',
          color,
          who: c.engagementName,
          text: `${l.name} is ${money(-l.remaining)} over its approved budget`,
          go: <Link to={`/reports/${c.reportId}`}>View Month&apos;s Financial →</Link>,
        })
  }
  for (const x of expenses?.rows ?? [])
    rows.push({
      key: x.key,
      sign: x.go === 'upload' ? '🧾' : '⚠️',
      who: x.who,
      text: x.text,
      sub: x.sub,
      go:
        x.go === 'upload' && expenses!.onUpload ? (
          <label
            className={`ad-btn ad-btn-navy ad-btn-sm wpd-upload ${expenses!.busy ? 'is-busy' : ''}`}
          >
            <input
              type="file"
              multiple
              accept=".pdf,.png,.jpg,.jpeg"
              disabled={expenses!.busy}
              aria-label="Upload receipts"
              onChange={(ev) => {
                expenses!.onUpload!([...(ev.target.files ?? [])])
                ev.target.value = ''
              }}
            />
            {expenses!.busy ? 'Reading…' : x.label}
          </label>
        ) : (
          <button type="button" className="wpd-linkbtn" onClick={expenses!.onOpen}>
            {x.go === 'upload' ? 'See them' : x.label} →
          </button>
        ),
    })
  // Before the first match the reconciliation is not on the page: the match row above says it all.
  const counts = resolveCounts(matched ? recon : null)
  for (const k of RESOLVE_KINDS)
    if (counts[k] && k !== 'not-funded')
      rows.push({
        key: k,
        sign: RESOLVE[k].sign,
        who: 'Workspace',
        text: `${counts[k]} ${RESOLVE[k].action}`,
        go: (
          <button type="button" className="wpd-linkbtn" onClick={() => onShow(k)}>
            Review below →
          </button>
        ),
      })
  return (
    <Card
      title={
        <span className="wpd-actions-title">
          Actions
          {rows.length > 0 && <span className="wpd-count">{rows.length}</span>}
        </span>
      }
    >
      <ErrorNote message={expenses?.error ?? null} />
      {rows.length === 0 ? (
        <p className="text-sm font-semibold text-ok">✓ Nothing to fix for {periodLabel(period)}.</p>
      ) : (
        <ul className="wpd-actions">
          {rows.map((r) => (
            <li key={r.key}>
              <span className="wpd-action-sign" aria-hidden="true">
                {r.sign}
              </span>
              <span>
                <b>{r.text}</b>
                {r.sub && <span className="wpd-action-sub">{r.sub}</span>}
                <span className="ad-table-sub">
                  {r.color && <EngagementMark color={r.color} />}
                  {r.who}
                </span>
              </span>
              {r.go}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

/** Two-part bar: spent before this month, then this month, against the approved amount; red when over. */
function UsedBar({
  before,
  now,
  budget,
  color,
}: {
  before: number
  now: number
  budget: number
  color: string
}) {
  if (budget <= 0) return <span className="text-soft text-sm">No approved amount</span>
  const over = before + now > budget
  const pct = (n: number) => `${Math.max(0, Math.min(100, (n / budget) * 100))}%`
  return (
    <span className="wpd-bar" title={`${money(before + now)} of ${money(budget)}`}>
      <span className="wpd-track">
        <i
          className="wpd-before"
          style={{ width: pct(before), background: over ? 'var(--danger)' : color }}
        />
        <i
          className="wpd-now"
          style={{
            left: pct(before),
            width: pct(Math.min(now, Math.max(0, budget - before))),
            background: over ? 'var(--danger)' : color,
          }}
        />
      </span>
      <span className={`wpd-pct ${over ? 'wps-over' : ''}`}>
        {Math.round(((before + now) / budget) * 100)}%
      </span>
    </span>
  )
}

/** One card per engagement: the month page's budget table, each line with its bar, and the way to the month. */
export function BudgetTracking({
  period,
  cards,
  error,
  colors,
  onMatchAgain,
}: {
  period: string
  cards: EngagementPayrollCardDto[] | null
  error: string | null
  colors: Map<string, string>
  /** Owners, when the month has files: match them again, for a month started after the last match. */
  onMatchAgain?: () => void
}) {
  return (
    <section className="grid gap-3" aria-label="Engagement Budget Tracking">
      <h2 className="ad-card-title">Engagement Budget Tracking: {periodLabel(period)}</h2>
      {/* The key to Used to date's two shades (owner's decision, 2026-10-20). */}
      <p className="wpd-key">
        <span>
          <i className="wpd-key-before" /> Before this month
        </span>
        <span>
          <i className="wpd-key-now" /> This month
        </span>
      </p>
      {error && <p className="text-danger">{error}</p>}
      {!cards && !error && <Empty>Loading the engagements…</Empty>}
      <div className="wpd-cards">
        {(cards ?? []).map((c) => {
          const color = colorOf(colors, c.engagementId)
          // Its budget lines with an amount or spending; with none, every line it has, so a budget with no amounts yet
          // still shows as one.
          const used = c.lines.filter(
            (l) => l.budget > 0 || l.billedThisPeriod > 0 || l.previouslyBilled > 0
          )
          const lines = used.length ? used : c.lines
          const total = lines.reduce(
            (t, l) => ({
              budget: t.budget + l.budget,
              before: t.before + l.previouslyBilled,
              now: t.now + l.billedThisPeriod,
            }),
            { budget: 0, before: 0, now: 0 }
          )
          return (
            <section
              key={c.engagementId}
              className="ad-card wps-card"
              style={{ borderTopColor: color }}
            >
              <header className="wps-card-head">
                <span className="wps-name">
                  <EngagementMark color={color} />
                  {c.engagementName}
                </span>
                <Chip tone="muted">{REPORT_STATUS_LABELS[c.monthStatus]}</Chip>
              </header>
              {c.notMatched && (
                <div className="wpd-unmatched" role="status">
                  <p className="text-sm">
                    <b>Not matched yet.</b> This month started after the last payroll match, so its
                    payroll is not on it yet. Match the same files again to bring it in.
                  </p>
                  {onMatchAgain && (
                    <Button size="sm" kind="navy" onClick={onMatchAgain}>
                      Re-match with same files
                    </Button>
                  )}
                </div>
              )}
              <div className="ad-tablewrap">
                <table className="ad-table wpd-table">
                  <thead>
                    <tr>
                      <th>Budget line</th>
                      <th className="ad-num">This month</th>
                      <th className="ad-num">Left</th>
                      <th>Used to date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.length === 0 && (
                      <tr>
                        <td colSpan={4} className="text-soft">
                          No budget lines yet.
                        </td>
                      </tr>
                    )}
                    {lines.map((l) => (
                      <tr key={l.id}>
                        <td>
                          <span className="font-semibold">{l.name}</span>
                        </td>
                        <td className="ad-num">{money(l.billedThisPeriod)}</td>
                        <td className={`ad-num ${l.remaining < 0 ? 'wps-over' : ''}`}>
                          {money(l.remaining)}
                        </td>
                        <td>
                          <UsedBar
                            before={l.previouslyBilled}
                            now={l.billedThisPeriod}
                            budget={l.budget}
                            color={color}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  {lines.length > 1 && (
                    <tfoot>
                      <tr>
                        <th>Total</th>
                        <th className="ad-num">{money(total.now)}</th>
                        <th className="ad-num">{money(total.budget - total.before - total.now)}</th>
                        <th>
                          <UsedBar
                            before={total.before}
                            now={total.now}
                            budget={total.budget}
                            color={color}
                          />
                        </th>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
              <p className="text-sm text-soft">
                {c.wex.payments} work-experience {c.wex.payments === 1 ? 'payment' : 'payments'}{' '}
                this month
              </p>
              <Link to={`/reports/${c.reportId}`} className="wpd-more">
                View Month&apos;s Financial →
              </Link>
            </section>
          )
        })}
      </div>
    </section>
  )
}

/** What the reconciliation grid filters by, one tile each: the problems first, then the items whose proof is complete. */
export type ResolveKind =
  | 'missing'
  | 'guessed'
  | 'unassigned'
  | 'staff'
  | 'two'
  | 'dropped'
  | 'differ'
  | 'not-funded'
  | 'nocharge'
  | 'proved'
const RESOLVE_KINDS: ResolveKind[] = [
  'missing',
  'guessed',
  'unassigned',
  'staff',
  'two',
  'dropped',
  'differ',
  'not-funded',
]
const RESOLVE: Record<ResolveKind, { label: string; sign: string; action: string; warn: boolean }> =
  {
    missing: {
      label: 'Missing proof',
      sign: '📎',
      action: 'payroll items missing proof',
      warn: true,
    },
    guessed: {
      label: 'Guessed, to confirm',
      sign: '🔎',
      action: 'pays guessed by amount: confirm each',
      warn: true,
    },
    unassigned: {
      label: 'Paid, on no item',
      sign: '⚠️',
      action: 'pays on no engagement: link each or mark it not grant-funded',
      warn: true,
    },
    staff: {
      label: 'Charged, on no engagement',
      sign: '👤',
      action: 'staff charged to the grant in payroll details are on no engagement',
      warn: true,
    },
    two: {
      label: 'Two files for one proof',
      sign: '⚖️',
      action: 'items have two different files as one proof',
      warn: true,
    },
    dropped: {
      label: 'Decisions dropped',
      sign: '↩️',
      action: 'decisions were dropped with their files',
      warn: true,
    },
    differ: {
      label: 'Expenses differ',
      sign: '🧾',
      action: 'payroll lines in expenses differ from the payroll files',
      warn: true,
    },
    'not-funded': {
      label: 'Not grant-funded',
      sign: '🚫',
      action: 'not grant-funded',
      warn: false,
    },
    nocharge: {
      label: 'Staff w/o charges',
      sign: '·',
      action: 'staff with no charges',
      warn: false,
    },
    proved: { label: 'Proof complete', sign: '✓', action: 'items with every proof', warn: false },
  }

const missingOf = (i: PayrollReconciliationDto['items'][number]) =>
  i.needed.filter((s) => !i.item.proved.includes(s))

export function resolveCounts(d: PayrollReconciliationDto | null): Record<ResolveKind, number> {
  const staff = d?.staffOnNoEngagement.filter((s) => s.inFiles) ?? []
  const items = d?.items ?? []
  return {
    missing: items.filter((i) => missingOf(i).length).length,
    guessed: d?.counts.guessed ?? 0,
    unassigned: d?.counts.unassigned ?? 0,
    staff: staff.filter((s) => s.charged !== null).length,
    two: d?.twoProofs.length ?? 0,
    dropped: d?.dropped.length ?? 0,
    differ: (d?.books ?? []).filter((r) => !agrees(r)).length,
    'not-funded':
      (d?.counts['not-funded'] ?? 0) +
      staff.filter((s) => s.charged === null && s.paid !== null).length,
    nocharge: staff.filter((s) => s.charged === null && s.paid === null).length,
    proved: items.filter((i) => !missingOf(i).length).length,
  }
}

/** A Review below on Actions: missing proof is red, every other kind an alert. */
export const toneOfKind = (k: ResolveKind): Tone => (k === 'missing' ? 'red' : 'yellow')

const TILE: Record<Tone, { label: string; none: string; className: string }> = {
  red: { label: 'Missing proof', none: 'Nothing missing', className: 'ad-tile-warn' },
  yellow: { label: 'Needs attention', none: 'Nothing flagged', className: 'rl-c-tile-attention' },
  green: { label: 'Complete', none: 'Nothing complete yet', className: '' },
}
/** "Showing 2 of 5 expenses that need attention". */
const TONE_WORDS: Record<Tone, string> = {
  red: 'missing proof',
  yellow: 'that need attention',
  green: 'complete',
}

/**
 * The month end's three tiles (owner's decision, 2026-11-14, as the month page's): red counts the rows with proof
 * missing, yellow the rows with an alert, green the rows complete, over both grids; a click filters both.
 */
export function ReconcileTiles({
  counts,
  filter,
  onFilter,
}: {
  counts: Record<Tone, number>
  filter: Tone | null
  onFilter: (t: Tone | null) => void
}) {
  return (
    <div className="wpd-rtiles" id="wpd-grid">
      {TONES.map((t) => (
        <button
          key={t}
          type="button"
          className={`ad-tile rl-c-tilebtn ${counts[t] ? TILE[t].className : ''}`}
          aria-pressed={filter === t}
          disabled={!counts[t]}
          onClick={() => onFilter(filter === t ? null : t)}
        >
          <span className="ad-tile-label">{TILE[t].label}</span>
          <span className="ad-tile-value">{counts[t]}</span>
          <span className="ad-tile-note">
            {!counts[t]
              ? TILE[t].none
              : filter === t
                ? 'Shown below · click to clear'
                : 'Show them in the grids'}
          </span>
        </button>
      ))}
    </div>
  )
}

const plain = (x: string) => x.toLowerCase().replace(/[$,]/g, '')

/** One grid's search and the rows it leaves: the tile's tone, the "missing:" chips and the words. */
function useGridFilter<R extends { tone: Tone }>(
  rows: R[],
  filter: Tone | null,
  fields: FieldChoices[],
  textOf: (r: R) => string,
  missingOf: (r: R) => string[]
) {
  const [text, setText] = useState('')
  const [tokens, setTokens] = useState<FilterToken[]>([])
  const search = searchOf(text, fields)
  const words = search.toLowerCase().split(/\s+/).filter(Boolean)
  const shown = rows.filter(
    (r) =>
      (!filter || r.tone === filter) &&
      tokens.every((t) => missingOf(r).includes(t.value)) &&
      words.every((w) => plain(textOf(r)).includes(plain(w)))
  )
  /** Anything narrowing the grid: complete rows then show instead of folding. */
  const narrowed = !!filter || tokens.length > 0 || words.length > 0
  return { text, setText, tokens, setTokens, search, shown, narrowed }
}

/** "Showing 2 of 5 expenses that need attention · Clear filter", while anything filters the grid. */
function GridNote({
  shown,
  total,
  noun,
  filter,
  tokens,
  search,
  onClear,
}: {
  shown: number
  total: number
  noun: [string, string]
  filter: Tone | null
  tokens: FilterToken[]
  search: string
  onClear: () => void
}) {
  if (!filter && !tokens.length && !search) return null
  const parts = [
    ...tokens.map((t) => `missing: ${t.label}`),
    search && `matching "${search}"`,
  ].filter(Boolean)
  return (
    <div className="rl-c-filternote" role="status">
      <span>
        Showing <strong>{shown}</strong> of {total} {total === 1 ? noun[0] : noun[1]}
        {filter ? ` ${TONE_WORDS[filter]}` : ''}
        {parts.length ? ` · ${parts.join(' · ')}` : ''}
      </span>
      <Button size="sm" kind="navy" onClick={onClear}>
        Clear filter
      </Button>
    </div>
  )
}

/** A grid's rows in engagement groups, complete rows folded into "+ N complete" until asked for. */
function GroupedRows<R extends { key: string; tone: Tone; group: string }>({
  rows,
  all,
  names,
  reports,
  colors,
  columns,
  narrowed,
  row,
  foldWords,
}: {
  /** The rows the filters leave. */
  rows: R[]
  /** Every row of the grid: each engagement's "N of M complete" counts them all, whatever the filter. */
  all: R[]
  names: Map<string, string>
  reports: Map<string, string>
  colors: Map<string, string>
  columns: number
  narrowed: boolean
  row: (r: R) => ReactNode
  /** What the folded rows are: "fully proved" in an engagement, "settled" on none. */
  foldWords: (group: string) => string
}) {
  // Groups the owner closed, and groups whose complete rows the owner opened.
  const [closed, setClosed] = useState<Set<string>>(new Set())
  const [open, setOpen] = useState<Set<string>>(new Set())
  const flip = (set: Set<string>, id: string) => {
    const n = new Set(set)
    if (n.has(id)) n.delete(id)
    else n.add(id)
    return n
  }
  return (
    <tbody>
      {grouped(rows, names).map((g) => {
        const mine = all.filter((r) => r.group === g.id)
        const done = mine.filter((r) => r.tone === 'green')
        const isClosed = closed.has(g.id)
        const unfolded = narrowed || open.has(g.id)
        const shown = unfolded ? g.rows : g.rows.filter((r) => r.tone !== 'green')
        const greens = g.rows.filter((r) => r.tone === 'green').length
        const report = reports.get(g.id)
        return (
          <Fragment key={g.id || 'none'}>
            <tr
              className="wpd-group"
              aria-expanded={!isClosed}
              onClick={(e) => {
                // A click on the row folds the group; its link still opens the month.
                if ((e.target as HTMLElement).closest('a')) return
                setClosed(flip(closed, g.id))
              }}
            >
              <td colSpan={columns}>
                {g.id !== NO_ENGAGEMENT && (
                  <span className="wpd-group-end">
                    {done.length === mine.length ? (
                      <Chip tone="ok" fill>
                        ✓ Complete
                      </Chip>
                    ) : report ? (
                      <Link to={`/reports/${report}`}>View Month&apos;s Financial →</Link>
                    ) : null}
                  </span>
                )}
                <span className="wpd-group-name">
                  <span className="wpd-group-caret" aria-hidden>
                    {isClosed ? '▸' : '▾'}
                  </span>
                  {g.id !== NO_ENGAGEMENT && <EngagementMark color={colorOf(colors, g.id)} />}
                  {g.name}
                  <span className="wpd-group-meta">
                    {' '}
                    ·{' '}
                    {g.id !== NO_ENGAGEMENT
                      ? `${done.length} of ${mine.length} complete`
                      : `${mine.length} ${mine.length === 1 ? 'row' : 'rows'}`}
                  </span>
                </span>
              </td>
            </tr>
            {!isClosed && shown.map((r) => <Fragment key={r.key}>{row(r)}</Fragment>)}
            {!isClosed && greens > 0 && !narrowed && (
              <tr className="wpd-fold">
                <td colSpan={columns}>
                  <button
                    type="button"
                    className="wpd-linkbtn"
                    aria-expanded={unfolded}
                    onClick={() => setOpen(flip(open, g.id))}
                  >
                    {unfolded
                      ? `− Hide ${greens} ${foldWords(g.id)}`
                      : `+ ${greens} ${foldWords(g.id)}`}
                  </button>
                </td>
              </tr>
            )}
          </Fragment>
        )
      })}
    </tbody>
  )
}

/**
 * A row's alerts as the month page's checks: "see 1 check" under the proofs, each an ATTENTION pill with its words,
 * opened by a click or by the Needs attention tile.
 */
function Alerts({ alerts, open }: { alerts: string[]; open: boolean }) {
  const [mine, setMine] = useState(false)
  if (!alerts.length) return null
  const shown = open || mine
  return (
    <>
      <button
        type="button"
        className="rl-c-seechecks rl-c-seechecks-attention"
        aria-expanded={shown}
        onClick={() => setMine(!shown)}
      >
        {shown ? 'hide' : 'see'} {alerts.length} {alerts.length === 1 ? 'check' : 'checks'}
      </button>
      <ul className="rl-c-rowchecks" hidden={!shown}>
        {alerts.map((a, n) => (
          <li key={n}>
            <Chip tone="warn" fill className="rl-c-chip-caution">
              attention
            </Chip>
            <span>{a}</span>
          </li>
        ))}
      </ul>
    </>
  )
}

/** Each row keeps its own "see checks"; the red and yellow tiles open them all, as on the month page. */
function useRowChecks(filter: Tone | null) {
  const [open, setOpen] = useState<Set<string>>(new Set())
  return {
    isOpen: (key: string) => filter === 'red' || filter === 'yellow' || open.has(key),
    toggle: (key: string) =>
      setOpen((o) => {
        const n = new Set(o)
        if (n.has(key)) n.delete(key)
        else n.add(key)
        return n
      }),
  }
}

const missingField = (purposes: DocumentPurpose[]): FieldChoices => ({
  field: 'missing',
  hint: 'missing proof',
  options: purposes.map((x) => ({ value: x, label: DOCUMENT_PURPOSE_LABELS[x] })),
})

/**
 * Expenses & Proof (owner's decision, 2026-11-14): each engagement month's expenses, the month page's own rows, by
 * engagement; then the receipts matched to no bill and the books' lines on no engagement.
 */
export function ExpensesGrid({
  data,
  months,
  edit,
  rows,
  filter,
  onFilter,
  colors,
  reports,
  onOpen,
}: {
  data: WorkspaceExpensesDto | null
  months: ReportDetail[] | null
  /** A month row's edit, attach and remove: the month page's own dialogs. */
  edit: RowEditing['forMonth']
  rows: ExpenseRow[]
  filter: Tone | null
  onFilter: (t: Tone | null) => void
  colors: Map<string, string>
  reports: Map<string, string>
  /** Opens Expense matching, where every expense's proof is found and chosen. */
  onOpen?: () => void
}) {
  const fields: FieldChoices[] = [missingField(['invoice', 'payment', 'allocation'])]
  const f = useGridFilter(
    rows,
    filter,
    fields,
    (r) =>
      r.kind === 'month'
        ? `${r.e.vendor} ${r.e.itemNumber} ${r.e.memo} ${r.e.account ?? ''} ${r.r.engagement.name} ${r.e.totalCost} ${r.e.allocatedAmount}`
        : r.kind === 'receipt'
          ? `${r.r.vendor ?? ''} ${r.r.fileName} ${r.r.amount?.toFixed(2) ?? ''}`
          : `${r.l.vendor} ${r.l.description} ${r.l.budgetLineName ?? ''} ${r.l.amount.toFixed(2)}`,
    (r) => (r.kind === 'month' ? r.missing : [])
  )
  const checks = useRowChecks(filter)
  const names = new Map<string, string>([
    ...(data?.engagements ?? []).map((e) => [e.id, e.name] as [string, string]),
    ...(months ?? []).map((m) => [m.engagement.id, m.engagement.name] as [string, string]),
  ])
  const clear = () => {
    onFilter(null)
    f.setTokens([])
    f.setText('')
  }
  return (
    <Card
      title="Expenses & Proof"
      aside={
        onOpen && data?.file ? (
          <Button kind="navy" onClick={onOpen}>
            Expense matching
          </Button>
        ) : undefined
      }
    >
      <div className="grid gap-3">
        <p className="rl-c-sectionnote">
          Invoice, evidence of payment and, on a shared cost, the allocation worksheet for each
          expense.
        </p>
        {!months ? (
          <Empty>Loading the month&apos;s expenses…</Empty>
        ) : (
          <>
            <FilterBar
              fields={fields}
              tokens={f.tokens}
              onTokens={f.setTokens}
              text={f.text}
              onText={f.setText}
              pinned={filter ? { label: TILE[filter].label, onRemove: () => onFilter(null) } : null}
              placeholder="Search vendor, item, memo or amount · type missing:"
            />
            <GridNote
              shown={f.shown.length}
              total={rows.length}
              noun={['expense', 'expenses']}
              filter={filter}
              tokens={f.tokens}
              search={f.search}
              onClear={clear}
            />
            {rows.length === 0 ? (
              <Empty>No expenses for {data ? periodLabel(data.period) : 'this month'} yet.</Empty>
            ) : f.shown.length === 0 ? (
              <Empty>No expense matches this filter.</Empty>
            ) : (
              <div className="ad-tablewrap">
                <table className="ad-table wpd-recgrid">
                  <thead>
                    <ExpenseHead actions />
                  </thead>
                  <GroupedRows
                    rows={f.shown}
                    all={rows}
                    names={names}
                    reports={reports}
                    colors={colors}
                    columns={7}
                    narrowed={f.narrowed}
                    foldWords={(g) => (g === NO_ENGAGEMENT ? 'settled' : 'fully proved')}
                    row={(r) =>
                      r.kind === 'month' ? (
                        <MonthExpenseRow
                          r={r.r}
                          e={r.e}
                          checksOpen={checks.isOpen(r.key)}
                          onToggleChecks={() => checks.toggle(r.key)}
                          onAdd={(purpose) => edit(r.r).attach(r.e, purpose)}
                          act={edit(r.r)}
                          actions
                          end={r.r.can.edit ? undefined : null}
                        />
                      ) : (
                        <ExpenseLine r={r} onOpen={onOpen} checks={filter === 'yellow'} />
                      )
                    }
                  />
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  )
}

/** A row the month page doesn't have: a receipt matched to no bill, or a books line on no engagement. */
function ExpenseLine({
  r,
  onOpen,
  checks,
}: {
  r: Exclude<ExpenseRow, { kind: 'month' }>
  onOpen?: () => void
  checks: boolean
}) {
  if (r.kind === 'receipt')
    return (
      <tr>
        <td className="whitespace-nowrap">
          <span className="ad-table-sub">{r.r.date ?? ''}</span>
        </td>
        <td>
          <span className="font-semibold">{r.r.vendor ?? 'Receipt'}</span>
          <span className="ad-table-sub">{r.r.fileName}</span>
        </td>
        <td></td>
        <td className="ad-num">{r.r.amount === null ? '' : money(r.r.amount)}</td>
        <td className="ad-num"></td>
        <td>
          <div className="flex flex-wrap gap-1">
            <Chip tone="muted">Receipt</Chip>
          </div>
          <Alerts
            alerts={['This receipt is matched to no expense from the books.']}
            open={checks}
          />
        </td>
        <td className="ad-num whitespace-nowrap">
          {onOpen && (
            <button type="button" className="wpd-linkbtn" onClick={onOpen}>
              Match it →
            </button>
          )}
        </td>
      </tr>
    )
  const l = r.l
  return (
    <tr>
      <td className="whitespace-nowrap">
        <span className="ad-mono font-semibold">{l.transactionId}</span>
        <span className="ad-table-sub">{l.date}</span>
      </td>
      <td>
        <span className="font-semibold">{l.vendor || 'No vendor'}</span>
        <span className="ad-table-sub">
          {l.description}
          {l.account ? ` · ${l.account}` : ''}
        </span>
      </td>
      <td>{l.budgetLineName ?? ''}</td>
      <td className="ad-num">{money(l.amount)}</td>
      <td className="ad-num"></td>
      <td>
        {r.tone === 'yellow' ? (
          <Alerts alerts={[BOOKS_LINE_STATUS_LABELS[l.status]]} open={checks} />
        ) : (
          <Chip tone="muted">{BOOKS_LINE_STATUS_LABELS[l.status]}</Chip>
        )}
      </td>
      <td className="ad-num whitespace-nowrap">
        <span className="ad-table-sub">from the books</span>
      </td>
    </tr>
  )
}

/**
 * Payroll & Proof (owner's decision, 2026-11-14): every engagement's payroll items by engagement, each with its proofs,
 * and a run whose expenses differ from the payroll files in its engagement; then the pays and people in the files on
 * no item yet, the decisions dropped with their files, and the pays marked not grant-funded (settled, folded).
 */
export function PayrollGrid({
  workspaceId,
  data,
  months,
  edit,
  rows,
  filter,
  onFilter,
  colors,
  reports,
  action,
}: {
  workspaceId: string
  data: PayrollReconciliationDto
  months: ReportDetail[]
  edit: RowEditing['forMonth']
  rows: PayRow[]
  filter: Tone | null
  onFilter: (t: Tone | null) => void
  colors: Map<string, string>
  reports: Map<string, string>
  action?: (p: PayLineDto) => ReactNode
}) {
  const fields: FieldChoices[] = [missingField(['timesheet', 'register', 'payment', 'allocation'])]
  const f = useGridFilter(rows, filter, fields, payText, (r) =>
    r.kind === 'month' ? r.missing : []
  )
  const checks = useRowChecks(filter)
  const names = new Map<string, string>()
  for (const i of data.items) names.set(i.item.engagementId, i.item.engagementName)
  for (const r of data.books) names.set(r.engagementId, r.engagementName)
  for (const m of months) names.set(m.engagement.id, m.engagement.name)
  const clear = () => {
    onFilter(null)
    f.setTokens([])
    f.setText('')
  }
  const notImported = data.booksNotImported ?? []
  return (
    <Card title="Payroll & Proof">
      <div className="grid gap-3">
        <p className="rl-c-sectionnote">
          Timesheet, payroll register and evidence of payment for each payroll line and each
          participant paid.
        </p>
        {notImported.length > 0 && (
          <p className="text-sm text-soft">
            Expenses for {periodLabel(data.period)} not imported yet for{' '}
            {notImported.map((m) => m.engagementName).join(', ')}: import them to check them against
            payroll.
          </p>
        )}
        <FilterBar
          fields={fields}
          tokens={f.tokens}
          onTokens={f.setTokens}
          text={f.text}
          onText={f.setText}
          pinned={filter ? { label: TILE[filter].label, onRemove: () => onFilter(null) } : null}
          placeholder="Search name, engagement, file or amount · type missing:"
        />
        <GridNote
          shown={f.shown.length}
          total={rows.length}
          noun={['payroll row', 'payroll rows']}
          filter={filter}
          tokens={f.tokens}
          search={f.search}
          onClear={clear}
        />
        {rows.length === 0 ? (
          <Empty>No payroll this month.</Empty>
        ) : f.shown.length === 0 ? (
          <Empty>No payroll row matches this filter.</Empty>
        ) : (
          <div className="ad-tablewrap">
            <table className="ad-table wpd-recgrid">
              <thead>
                <PayrollHead actions />
              </thead>
              <GroupedRows
                rows={f.shown}
                all={rows}
                names={names}
                reports={reports}
                colors={colors}
                columns={5}
                narrowed={f.narrowed}
                foldWords={(g) => (g === NO_ENGAGEMENT ? 'settled' : 'fully proved')}
                row={(r) =>
                  r.kind === 'month' ? (
                    <MonthPayrollRow
                      r={r.r}
                      row={r.row}
                      checksOpen={checks.isOpen(r.key)}
                      onToggleChecks={() => checks.toggle(r.key)}
                      onAdd={(purpose) => addPayrollProof(r.r, edit(r.r), r.row, purpose)}
                      act={edit(r.r)}
                      actions
                      end={r.r.can.edit ? undefined : null}
                    />
                  ) : (
                    <PayrollLine
                      r={r}
                      workspaceId={workspaceId}
                      action={action}
                      checks={filter === 'yellow'}
                    />
                  )
                }
              />
            </table>
          </div>
        )}
      </div>
    </Card>
  )
}

/** What the payroll grid's search reads: names, engagement, file, amount. */
function payText(r: PayRow) {
  switch (r.kind) {
    case 'month':
      return r.row.kind === 'expense'
        ? `${r.row.e.vendor} ${r.row.e.itemNumber} ${r.row.e.memo} ${r.r.engagement.name} ${r.row.e.allocatedAmount}`
        : `${r.row.w.participantName} ${r.row.w.participantNumber} ${r.r.engagement.name} ${r.row.w.grossAmount}`
    case 'pay':
      return `${r.p.named ?? ''} ${r.p.mark?.text ?? ''} ${r.p.fileName} ${r.p.staff?.name ?? ''} ${r.p.item?.engagementName ?? ''}`
    case 'staff':
      return r.s.name
    case 'two':
      return `${r.t.message} ${r.t.engagementName}`
    case 'dropped':
      return r.d.fileName
    case 'run':
      return `${r.r.engagementName} ${PAYROLL_BUDGET_KIND_LABELS[r.r.kind]} ${r.r.books ?? ''} ${r.r.files ?? ''}`
  }
}

function PayrollLine({
  r,
  workspaceId,
  action,
  checks,
}: {
  r: Exclude<PayRow, { kind: 'month' }>
  workspaceId: string
  action?: (p: PayLineDto) => ReactNode
  checks: boolean
}) {
  switch (r.kind) {
    case 'pay': {
      const p = r.p
      return (
        <tr>
          <td>
            {/* Whose pay it is first; the line the file prints under it. */}
            <span className="font-semibold">{p.named ?? p.staff?.name ?? p.fileName}</span>
            <span className="ad-table-sub ad-mono">
              {p.mark?.text ?? 'The whole file (scanned)'}
            </span>
            {p.notFunded && (
              <span className="ad-table-sub">
                “{p.notFunded.reason}” · {p.notFunded.by}, {shortDate(p.notFunded.at)}
              </span>
            )}
          </td>
          <td className="whitespace-nowrap">—</td>
          <td className="ad-num"></td>
          <td>
            <span className="flex flex-wrap gap-1">
              <Chip tone="muted" className="wpd-filechip">
                {kindWord(p.kind)}: {p.fileName}
                {p.mark ? `, page ${p.mark.page}` : ''}
              </Chip>
              {p.state === 'not-funded' && (
                <Chip tone="muted">🚫 {PAY_LINE_STATE_LABELS[p.state]}</Chip>
              )}
            </span>
            <Alerts
              alerts={[
                ...(p.state === 'not-funded'
                  ? []
                  : p.state === 'guessed' && p.item
                    ? [
                        `Guessed: ${p.item.engagementName}, ${p.item.title}. Confirm it or choose another.`,
                      ]
                    : [PAY_LINE_STATE_LABELS[p.state]]),
                ...p.flags.map((x) => PAY_LINE_FLAG_LABELS[x]),
              ]}
              open={checks}
            />
          </td>
          <td className="wpd-act">{action?.(p) ?? null}</td>
        </tr>
      )
    }
    case 'staff':
      return (
        <tr>
          <td>
            <span className="font-semibold">{r.s.name}</span>
            <span className="ad-table-sub">
              {r.s.charged !== null
                ? 'Charged to the grant in payroll details, on no engagement'
                : 'Paid in the files, charged to no grant'}
            </span>
          </td>
          <td className="whitespace-nowrap">—</td>
          <td className="ad-num font-semibold">{money((r.s.charged ?? r.s.paid)!)}</td>
          <td>
            {r.s.charged !== null ? (
              <Alerts
                alerts={['Charged to the grant but on no engagement: tag them to one.']}
                open={checks}
              />
            ) : (
              <Chip tone="muted">Not grant-funded</Chip>
            )}
          </td>
          <td className="whitespace-nowrap">
            {r.s.charged !== null && (
              <Link to={`/workspaces/${workspaceId}/staff`}>Tag to an engagement →</Link>
            )}
          </td>
        </tr>
      )
    case 'two':
      return (
        <tr>
          <td>
            <span className="font-semibold">{r.t.title}</span>
          </td>
          <td className="whitespace-nowrap">—</td>
          <td className="ad-num"></td>
          <td>
            <Alerts alerts={[r.t.message]} open={checks} />
          </td>
          <td className="whitespace-nowrap">
            <Link to={`/reports/${r.t.reportId}`}>View Month&apos;s Financial →</Link>
          </td>
        </tr>
      )
    case 'dropped':
      return (
        <tr>
          <td>
            <span className="font-semibold">{r.d.fileName}</span>
            <span className="ad-table-sub">{kindWord(r.d.kind)}</span>
          </td>
          <td className="whitespace-nowrap">{r.d.at ? shortDate(r.d.at) : '—'}</td>
          <td className="ad-num"></td>
          <td>
            <Alerts alerts={['A decision was dropped with its file.']} open={checks} />
          </td>
          <td></td>
        </tr>
      )
    case 'run': {
      const diff = r.r.books !== null && r.r.files !== null ? r.r.files - r.r.books : null
      return (
        <tr>
          <td>
            <span className="font-semibold">
              {PAYROLL_BUDGET_KIND_LABELS[r.r.kind]}, run paid {shortDate(r.r.date)}
            </span>
            <span className="ad-table-sub">
              Expenses {r.r.books === null ? 'none' : money(r.r.books)} · payroll files{' '}
              {r.r.files === null ? 'none' : money(r.r.files)}
            </span>
          </td>
          <td className="whitespace-nowrap">{shortDate(r.r.date)}</td>
          <td className="ad-num font-semibold">
            {diff === null ? '' : `${diff > 0 ? '+' : '−'}${money(Math.abs(diff))}`}
          </td>
          <td>
            <Alerts
              alerts={[
                `${
                  r.r.books === null
                    ? 'Not in the expenses from the books.'
                    : r.r.files === null
                      ? 'Not in the payroll files.'
                      : 'The expenses from the books differ from the payroll files.'
                } Correct it in your accounting system, then import the month again.`,
              ]}
              open={checks}
            />
          </td>
          <td className="whitespace-nowrap">
            <Link to={`/reports/${r.r.reportId}`}>View Month&apos;s Financial →</Link>
          </td>
        </tr>
      )
    }
  }
}
