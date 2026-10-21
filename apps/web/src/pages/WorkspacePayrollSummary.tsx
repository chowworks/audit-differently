// The page after the match (#22, owner's choice 2026-10-20, option D of the design experiment): Actions first, then
// Engagement Budget Tracking, then Workspace Reconciliation (only what is not resolved, its tiles filtering the
// grid), and the files and Match again last.
import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  PAY_LINE_FLAG_LABELS,
  PAY_LINE_STATE_LABELS,
  PAYROLL_BUDGET_KIND_LABELS,
  REPORT_STATUS_LABELS,
  type EngagementPayrollCardDto,
  type PayLineDto,
  type PayrollReconciliationDto,
  type BooksRunDto,
  type PayrollSlot,
  type WorkspacePayrollFilesDto,
  type WorkspacePayrollOutputDto,
} from '@ad/types'
import { useLoad } from '@/hooks/useApi'
import { ENGAGEMENT_COLORS } from '@/lib/engagement-colors'
import { money, periodLabel, shortDate } from '@/lib/format'
import { Button, Card, Chip, Empty } from '@/components/ui'
import { SLOT_LABEL } from '@/components/payroll-match/why'
import { kindWord } from '@/pages/workspace-payroll-plan'
import { keyOf } from '@/pages/workspace-payroll'
import {
  FilterBar,
  searchOf,
  type FieldChoices,
  type FilterToken,
} from '@/pages/report-layouts/FilterBar'
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
}: {
  period: string
  matched: boolean
  cards: EngagementPayrollCardDto[] | null
  recon: PayrollReconciliationDto | null
  colors: Map<string, string>
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
    for (const l of c.lines)
      if (l.remaining < 0)
        rows.push({
          key: `${c.engagementId}-over-${l.id}`,
          sign: '⛔',
          color,
          who: c.engagementName,
          text: `${l.name} is ${money(-l.remaining)} over its approved budget`,
          go: <Link to={`/reports/${c.reportId}`}>View financial details →</Link>,
        })
  }
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
                  {r.color && <span className="wps-dot" style={{ background: r.color }} />}
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
}: {
  period: string
  cards: EngagementPayrollCardDto[] | null
  error: string | null
  colors: Map<string, string>
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
          const lines = c.lines.filter(
            (l) => l.budget > 0 || l.billedThisPeriod > 0 || l.previouslyBilled > 0
          )
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
                <span className="wps-name">{c.engagementName}</span>
                <Chip tone="muted">{REPORT_STATUS_LABELS[c.monthStatus]}</Chip>
              </header>
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
                          No approved budget yet.
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
                View financial details →
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
/** A run's payroll the books and the payroll files both have, for the same amount. */
const agrees = (r: BooksRunDto) =>
  r.books !== null && r.files !== null && Math.abs(r.books - r.files) < 0.005

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

interface Row {
  key: string
  kind: ResolveKind
  /** What the search reads: names, engagement, file, amount. */
  text: string
  /** The proofs it lacks, for the "missing:" filter. */
  missing: PayrollSlot[]
  paid: ReactNode
  engagement: ReactNode
  date: ReactNode
  amount: number | null
  proof: ReactNode
  act: ReactNode
}

/** The tiles over the grid (owner's decisions, 2026-10-20): each row kind counts under one of them. */
type Tile = 'missing' | 'tocheck' | 'not-funded' | 'differ' | 'nocharge' | 'proved'
const TILE_OF: Record<ResolveKind, Tile> = {
  missing: 'missing',
  // Proof on file that a person must look at (owner's decision, 2026-10-20): not missing, so not under Missing proof.
  guessed: 'tocheck',
  two: 'tocheck',
  dropped: 'tocheck',
  differ: 'differ',
  staff: 'not-funded',
  unassigned: 'not-funded',
  'not-funded': 'not-funded',
  nocharge: 'nocharge',
  proved: 'proved',
}
/** The row kind a tile's click filters by: any kind of that tile picks the whole tile. */
const KIND_OF_TILE: Record<Tile, ResolveKind> = {
  missing: 'missing',
  tocheck: 'guessed',
  'not-funded': 'not-funded',
  differ: 'differ',
  nocharge: 'nocharge',
  proved: 'proved',
}
const TILE_LABEL: Record<Tile, string> = {
  missing: 'Missing proof',
  tocheck: 'To check',
  'not-funded': 'Paid, not grant-funded',
  differ: 'Expenses differ',
  nocharge: 'Staff w/o charges',
  proved: 'Proof complete',
}
const TILES: { key: Tile; label: string; tone: 'red' | 'yellow' | 'grey' | 'ok' }[] = [
  { key: 'missing', label: TILE_LABEL.missing, tone: 'red' },
  { key: 'tocheck', label: TILE_LABEL.tocheck, tone: 'yellow' },
  { key: 'not-funded', label: TILE_LABEL['not-funded'], tone: 'yellow' },
  { key: 'differ', label: TILE_LABEL.differ, tone: 'yellow' },
  { key: 'nocharge', label: TILE_LABEL.nocharge, tone: 'grey' },
  { key: 'proved', label: TILE_LABEL.proved, tone: 'ok' },
]

/** What the month's files hold, in one short line for File Management. */
export function FileStats({
  files,
  data,
}: {
  files: WorkspacePayrollFilesDto | null
  data: PayrollReconciliationDto | null
}) {
  if (!files || !data) return null
  const n = (k: string) => files.files.filter((f) => f.kind === k).length
  const runs = n('payroll-register')
  const debits = data.pays.filter(
    (p) => p.kind === 'bank-statement' && p.state === 'matched'
  ).length
  return (
    <p className="wpd-filestats">
      <span className="wpd-pill wpd-pill-ok">
        <b>{runs}</b> pay {runs === 1 ? 'run' : 'runs'}
      </span>
      <span className="wpd-pill wpd-pill-ok">
        <b>{n('paystub')}</b> pay stubs
      </span>
      <span className={`wpd-pill ${debits < runs ? 'wpd-pill-bad' : 'wpd-pill-ok'}`}>
        {debits < runs ? '⚠️' : '✓'}{' '}
        <b>
          {debits} of {runs}
        </b>{' '}
        bank debits found
      </span>
      <span className="wpd-pill wpd-pill-muted">
        <b>{data.otherBankLines}</b> other bank lines, not payroll
      </span>
    </p>
  )
}

const dateWords = (start: string, end: string) =>
  start === end ? shortDate(start) : `${shortDate(start)} – ${shortDate(end)}`

/**
 * The reconciliation: the month in figures (what the files hold, what is charged to the grant, what the
 * months bill), then one grid like the bookkeeper's Payroll & Proof with an Engagement column: every engagement's
 * payroll item with its proofs, and every pay or person still to place, then the books against the payroll files. A
 * tile filters both: Expenses differ and Proof complete pick the books' lines too (owner's decisions, 2026-10-20).
 */
export function ResolveGrid({
  workspaceId,
  data,
  cards,
  colors,
  filter,
  onFilter,
  action,
}: {
  workspaceId: string
  data: PayrollReconciliationDto
  cards: EngagementPayrollCardDto[] | null
  colors: Map<string, string>
  filter: ResolveKind | null
  onFilter: (k: ResolveKind | null) => void
  action?: (p: PayLineDto) => ReactNode
}) {
  const counts = resolveCounts(data)
  const [text, setText] = useState('')
  const [tokens, setTokens] = useState<FilterToken[]>([])
  const grid = data.items.filter((i) => i.item.kind === 'staff' || i.item.kind === 'participant')
  const fullyProved = counts.proved
  const differ = data.books.filter((r) => !agrees(r))
  const agree = data.books.filter(agrees)
  const tileCount = (t: Tile) =>
    rows.filter((r) => TILE_OF[r.kind] === t).length +
    (t === 'differ' ? differ.length : t === 'proved' ? agree.length : 0)

  const engagement = (id: string, name: string, reportId: string) => (
    <Link to={`/reports/${reportId}`} className="wpd-eng">
      <span className="wps-dot" style={{ background: colorOf(colors, id) }} />
      {name}
    </Link>
  )
  const rows: Row[] = []
  for (const i of grid) {
    const missing = missingOf(i)
    rows.push({
      key: `i-${keyOf(i.item)}`,
      kind: missing.length ? 'missing' : 'proved',
      text: `${i.item.title} ${i.item.sub} ${i.item.engagementName} ${i.item.amount.toFixed(2)}`,
      missing,
      paid: (
        <>
          <span className="font-semibold">{i.item.title}</span>
          <span className="ad-table-sub">{i.item.sub}</span>
        </>
      ),
      engagement: engagement(i.item.engagementId, i.item.engagementName, i.item.reportId),
      date: dateWords(i.item.start, i.item.end),
      amount: i.item.amount,
      proof: (
        <span className="flex flex-wrap gap-1">
          {i.needed.map((s) =>
            i.item.proved.includes(s) ? (
              <Chip key={s} tone="ok" fill>
                ✓ {SLOT_LABEL[s]}
              </Chip>
            ) : (
              <Chip key={s} tone="danger" fill>
                missing {SLOT_LABEL[s]}
              </Chip>
            )
          )}
        </span>
      ),
      act: missing.length ? <Link to={`/reports/${i.item.reportId}`}>Open month →</Link> : null,
    })
  }
  for (const p of data.pays)
    if (p.state !== 'matched')
      rows.push({
        key: p.id,
        kind: p.state as ResolveKind,
        text: `${p.mark?.text ?? ''} ${p.fileName} ${p.staff?.name ?? ''} ${p.item?.engagementName ?? ''}`,
        missing: [],
        paid: (
          <>
            <span className="ad-mono text-sm">{p.mark?.text ?? 'The whole file (scanned)'}</span>
            <span className="ad-table-sub">
              {p.staff ? `${p.staff.name} · ` : ''}
              {p.notFunded ? `“${p.notFunded.reason}” · ${p.notFunded.by}` : ''}
            </span>
          </>
        ),
        engagement: p.item ? (
          engagement(p.item.engagementId, p.item.engagementName, p.item.reportId)
        ) : (
          <span className="text-soft">None</span>
        ),
        date: p.notFunded ? shortDate(p.notFunded.at) : '—',
        amount: null,
        proof: (
          <span className="flex flex-wrap gap-1">
            <Chip tone="muted">
              {kindWord(p.kind)}: {p.fileName}
              {p.mark ? `, page ${p.mark.page}` : ''}
            </Chip>
            <Chip tone={RESOLVE[p.state as ResolveKind].warn ? 'warn' : 'muted'}>
              {RESOLVE[p.state as ResolveKind].sign} {PAY_LINE_STATE_LABELS[p.state]}
            </Chip>
            {p.flags.map((f) => (
              <Chip key={f} tone="warn">
                ⚠️ {PAY_LINE_FLAG_LABELS[f]}
              </Chip>
            ))}
          </span>
        ),
        act: action?.(p) ?? null,
      })
  // People on no engagement: charged by payroll details (not billed), paid with no charge (not grant-funded), or
  // neither (no charges).
  for (const s of data.staffOnNoEngagement)
    if (s.inFiles) {
      const kind: ResolveKind =
        s.charged !== null ? 'staff' : s.paid !== null ? 'not-funded' : 'nocharge'
      rows.push({
        key: `s-${s.id}`,
        kind,
        text: s.name,
        missing: [],
        paid: (
          <>
            <span className="font-semibold">{s.name}</span>
            <span className="ad-table-sub">
              {kind === 'staff'
                ? 'Charged to the grant in payroll details, on no engagement'
                : kind === 'not-funded'
                  ? 'Paid in the files, on no engagement'
                  : 'In the files, no charge and no pay found this month'}
            </span>
          </>
        ),
        engagement: <span className="text-soft">None</span>,
        date: '—',
        amount: s.charged ?? s.paid,
        proof: kind === 'staff' ? <Chip tone="warn">👤 On no engagement</Chip> : '—',
        act:
          kind === 'staff' ? (
            <Link to={`/workspaces/${workspaceId}/staff`}>Tag to an engagement →</Link>
          ) : null,
      })
    }
  // Staff tagged to an engagement that payroll details charges nothing this month: no charge, so nothing to prove.
  const seen = new Set<string>()
  for (const card of cards ?? [])
    for (const st of card.staff)
      if (st.charged === null && !seen.has(st.staffId)) {
        seen.add(st.staffId)
        rows.push({
          key: `n-${st.staffId}`,
          kind: 'nocharge',
          text: `${st.name} ${card.engagementName}`,
          missing: [],
          paid: (
            <>
              <span className="font-semibold">{st.name}</span>
              <span className="ad-table-sub">Staff · no charge in this month&apos;s data</span>
            </>
          ),
          engagement: engagement(card.engagementId, card.engagementName, card.reportId),
          date: '—',
          amount: null,
          proof: '—',
          act: null,
        })
      }
  for (const t of data.twoProofs)
    rows.push({
      key: `t-${t.target}-${t.id}-${t.slot}`,
      kind: 'two',
      text: `${t.message} ${t.engagementName}`,
      missing: [],
      paid: <span className="font-semibold">{t.message}</span>,
      engagement: <Link to={`/reports/${t.reportId}`}>{t.engagementName}</Link>,
      date: '—',
      amount: null,
      proof: <Chip tone="warn">⚖️ {SLOT_LABEL[t.slot]}</Chip>,
      act: <Link to={`/reports/${t.reportId}`}>Open month →</Link>,
    })
  data.dropped.forEach((d, n) =>
    rows.push({
      key: `d-${d.id ?? n}`,
      kind: 'dropped',
      text: d.fileName,
      missing: [],
      paid: (
        <>
          <span className="font-semibold">{d.fileName}</span>
          <span className="ad-table-sub">{kindWord(d.kind)}</span>
        </>
      ),
      engagement: <span className="text-soft">—</span>,
      date: d.at ? shortDate(d.at) : '—',
      amount: null,
      proof: <Chip tone="warn">↩️ Dropped with its file</Chip>,
      act: null,
    })
  )
  // Problems first, as the tiles list them; then complete items; not grant-funded last.
  const order: ResolveKind[] = [
    ...RESOLVE_KINDS.filter((k) => k !== 'not-funded'),
    'proved',
    'not-funded',
    'nocharge',
  ]
  rows.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))
  const fields: FieldChoices[] = [
    {
      field: 'missing',
      hint: 'a proof it lacks',
      options: (['timesheet', 'register', 'stub', 'bank'] as PayrollSlot[]).map((x) => ({
        value: x,
        label: SLOT_LABEL[x],
      })),
    },
  ]
  const search = searchOf(text, fields).toLowerCase()
  const words = search.split(/\s+/).filter(Boolean)
  const plain = (x: string) => x.toLowerCase().replace(/[$,]/g, '')
  // Fully proved rows are hidden until asked for: by their tile, or by a search.
  const shown = rows.filter(
    (r) =>
      (filter ? TILE_OF[r.kind] === TILE_OF[filter] : r.kind !== 'proved' || words.length > 0) &&
      tokens.every((t) => r.missing.includes(t.value as PayrollSlot)) &&
      words.every((w) => plain(r.text).includes(plain(w)))
  )
  const hidden = !filter && !words.length ? rows.filter((r) => r.kind === 'proved').length : 0
  // The books' lines: those that differ until a tile says otherwise; none under a tile or a "missing:" of the grid's.
  const tile = filter ? TILE_OF[filter] : null
  const books = (
    tile === 'proved'
      ? agree
      : tile === 'differ'
        ? differ
        : tile || tokens.length
          ? []
          : words.length
            ? data.books
            : differ
  ).filter((r) =>
    words.every((w) =>
      plain(
        `${r.engagementName} ${PAYROLL_BUDGET_KIND_LABELS[r.kind]} ${r.books ?? ''} ${r.files ?? ''}`
      ).includes(plain(w))
    )
  )
  const booksHidden = !filter && !words.length ? agree.length : 0
  const gridShown = tile !== 'differ'
  return (
    <div className="grid gap-5">
      <section className="grid gap-3" aria-label="Payroll & Proof" id="wpd-grid">
        <h3 className="wpd-stats-head">
          Payroll &amp; Proof · {fullyProved} of {grid.length}{' '}
          {grid.length === 1 ? 'item' : 'items'} fully proved
        </h3>
        <div className="wpd-tiles">
          {TILES.map((t) => (
            <button
              key={t.key}
              type="button"
              className={`ad-tile wpd-tilebtn wpd-tile-${tileCount(t.key) ? t.tone : 'ok'}`}
              aria-pressed={!!filter && TILE_OF[filter] === t.key}
              onClick={() =>
                onFilter(filter && TILE_OF[filter] === t.key ? null : KIND_OF_TILE[t.key])
              }
            >
              <span className="ad-tile-label">{t.label}</span>
              <span className="ad-tile-value">{tileCount(t.key)}</span>
            </button>
          ))}
        </div>
        <FilterBar
          fields={fields}
          tokens={tokens}
          onTokens={setTokens}
          text={text}
          onText={setText}
          pinned={
            filter ? { label: TILE_LABEL[TILE_OF[filter]], onRemove: () => onFilter(null) } : null
          }
          placeholder="Search name, engagement, file or amount · type missing:"
        />
        {(filter || tokens.length > 0 || words.length > 0) && (
          <div className="rl-c-filternote wpd-filternote" role="status">
            <span>
              Showing <strong>{(gridShown ? shown.length : 0) + books.length}</strong> of{' '}
              {rows.length + data.books.length} rows
              {filter ? ` · ${TILE_LABEL[TILE_OF[filter]]}` : ''}
              {tokens.length ? ` · missing: ${tokens.map((t) => t.label).join(', ')}` : ''}
              {words.length ? ` · matching "${search}"` : ''}
            </span>
            <Button
              size="sm"
              kind="navy"
              onClick={() => {
                onFilter(null)
                setTokens([])
                setText('')
              }}
            >
              Clear filter
            </Button>
          </div>
        )}
        {hidden > 0 && (
          <p className="text-sm text-soft">
            {hidden} fully proved {hidden === 1 ? 'row is' : 'rows are'} hidden: the Proof complete
            tile shows them.
          </p>
        )}
        {!gridShown ? null : rows.length === 0 ? (
          <Empty>No payroll this month.</Empty>
        ) : shown.length === 0 ? (
          <Empty>
            {hidden
              ? 'Nothing left to resolve: every row is fully proved.'
              : 'No row matches this filter.'}
          </Empty>
        ) : (
          <div className="ad-tablewrap">
            <table className="ad-table">
              <thead>
                <tr>
                  <th>Vendor/Participant Paid</th>
                  <th>Engagement</th>
                  <th>Date</th>
                  <th className="ad-num">Amount</th>
                  <th>Proof</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.key}>
                    <td>{r.paid}</td>
                    <td>{r.engagement}</td>
                    <td className="whitespace-nowrap">{r.date}</td>
                    <td className="ad-num font-semibold">
                      {r.amount === null ? '' : money(r.amount)}
                    </td>
                    <td>{r.proof}</td>
                    <td className="whitespace-nowrap">{r.act}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <BooksAgainstFiles
          rows={books}
          total={data.books.length}
          agree={agree.length}
          hidden={booksHidden}
          colors={colors}
        />
      </section>
    </div>
  )
}

/**
 * The books against the payroll files (owner's decisions, 2026-10-20): each run's payroll as the books have it (the
 * payroll transactions kept from imports) beside what the match found for it (the staff lines it wrote, the
 * participants' payments). They agree, or the difference shows; a run only one side has says so.
 */
function BooksAgainstFiles({
  rows,
  total,
  agree,
  hidden,
  colors,
}: {
  /** The lines the tiles and the search leave. */
  rows: BooksRunDto[]
  total: number
  agree: number
  /** Lines that agree, hidden until the Proof complete tile or a search asks for them. */
  hidden: number
  colors: Map<string, string>
}) {
  if (!rows.length && !hidden) return null
  return (
    <section className="grid gap-2" aria-label="Expenses against the payroll files">
      <h3 className="wpd-stats-head">
        Expenses vs payroll files · {agree} of {total} agree
      </h3>
      {agree < total && (
        <p className="text-sm">
          <b>A difference means the expenses are off, not the report:</b> the budget counts what the
          payroll files prove. Correct the payroll lines in your accounting system, then import the
          month&apos;s transactions again.
        </p>
      )}
      {hidden > 0 && (
        <p className="text-sm text-soft">
          {hidden} {hidden === 1 ? 'line that agrees is' : 'lines that agree are'} hidden: the Proof
          complete tile shows them.
        </p>
      )}
      {rows.length > 0 && (
        <div className="ad-tablewrap">
          <table className="ad-table">
            <thead>
              <tr>
                <th>Engagement</th>
                <th>Run paid</th>
                <th>Payroll</th>
                <th className="ad-num">Expenses</th>
                <th className="ad-num">Payroll files</th>
                <th>Difference</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const diff = r.books !== null && r.files !== null ? r.files - r.books : null
                return (
                  <tr key={`${r.reportId}-${r.date}-${r.kind}`}>
                    <td>
                      <span
                        className="wps-dot"
                        style={{ background: colorOf(colors, r.engagementId) }}
                      />
                      {r.engagementName}
                    </td>
                    <td className="whitespace-nowrap">{shortDate(r.date)}</td>
                    <td>{PAYROLL_BUDGET_KIND_LABELS[r.kind]}</td>
                    <td className="ad-num">{r.books === null ? '—' : money(r.books)}</td>
                    <td className="ad-num">{r.files === null ? '—' : money(r.files)}</td>
                    <td>
                      {r.books === null ? (
                        <Chip tone="warn">Not in expenses</Chip>
                      ) : r.files === null ? (
                        <Chip tone="warn">Not in the payroll files</Chip>
                      ) : Math.abs(diff!) < 0.005 ? (
                        <Chip tone="ok" fill>
                          ✓ Agree
                        </Chip>
                      ) : (
                        <Chip tone="danger" fill>
                          {diff! > 0 ? '+' : '−'}
                          {money(Math.abs(diff!))}
                        </Chip>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
