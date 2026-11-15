/*
 * Step 3, Review staff payroll (owner's choice, 2026-11-15, option A of three): the month end's Payroll & Proof grid
 * over the upload's staff pay lines. The same three tiles, the same engagement groups (a click folds one; "+ N fully
 * proved" shows the complete rows), each row's proofs as chips and each problem in one plain sentence with its fix.
 */
import { useState, type ReactNode } from 'react'
import { Chip } from '@/components/ui'
import { engagementColors } from '@/lib/engagement-colors'
import { money } from '@/lib/format'
import { GroupedRows, ReconcileTiles } from '@/pages/WorkspacePayrollSummary'
import type { Tone } from '@/pages/workspace-reconcile'

export interface ReviewSlot {
  /** Timesheet, Payroll register, Bank line. */
  label: string
  state: 'ok' | 'guess' | 'missing'
  /** The file that proves it. */
  file?: string
  /** What is wrong, in plain words: shown in red (missing) or amber (a guess). */
  problem?: string
  onShow?: () => void
  /** The control that fixes it here (choose a file, confirm a guess), if it can be fixed here. */
  fix?: ReactNode
}
export interface ReviewRow {
  key: string
  engagementId: string
  engagementName: string
  reportId: string
  title: string
  sub: string
  date: string
  amount: number
  slots: ReviewSlot[]
}

const toneOf = (r: ReviewRow): Tone =>
  r.slots.some((s) => s.state === 'missing')
    ? 'red'
    : r.slots.some((s) => s.state === 'guess')
      ? 'yellow'
      : 'green'

/** A proof as the month page shows it: green with a ✓ (opens the file), amber to check, red when missing. */
function ProofChip({ s }: { s: ReviewSlot }) {
  if (s.state === 'ok')
    return (
      <Chip tone="ok" fill title={s.file}>
        {s.onShow ? (
          <button type="button" className="sr-chipbtn" onClick={s.onShow}>
            ✓ {s.label}
          </button>
        ) : (
          <>✓ {s.label}</>
        )}
      </Chip>
    )
  if (s.state === 'guess')
    return (
      <Chip tone="warn" fill title={s.file}>
        ⚠️ {s.label}: check
      </Chip>
    )
  return (
    <Chip tone="danger" fill>
      ✕ {s.label}
    </Chip>
  )
}

/** Each problem in one plain sentence, with its fix beside it. */
function Problems({ row }: { row: ReviewRow }) {
  const bad = row.slots.filter((s) => s.state !== 'ok')
  if (!bad.length) return null
  return (
    <ul className="sr-problems">
      {bad.map((s) => (
        <li key={s.label} className={s.state === 'missing' ? 'sr-red' : 'sr-amber'}>
          <span className="sr-problem-words">
            <b>{s.label}:</b> {s.problem ?? (s.state === 'missing' ? 'not found' : 'check it')}
          </span>
          {s.fix && <span className="sr-fix">{s.fix}</span>}
        </li>
      ))}
    </ul>
  )
}

export function StaffReview({ rows }: { rows: ReviewRow[] }) {
  const [filter, setFilter] = useState<Tone | null>(null)
  const counts: Record<Tone, number> = { red: 0, yellow: 0, green: 0 }
  for (const r of rows) counts[toneOf(r)]++
  const all = rows.map((r) => ({ ...r, tone: toneOf(r), group: r.engagementId }))
  const shown = filter ? all.filter((r) => r.tone === filter) : all
  const names = new Map(rows.map((r) => [r.engagementId, r.engagementName]))
  const reports = new Map(rows.map((r) => [r.engagementId, r.reportId]))
  const colors = engagementColors([...names.keys()])
  return (
    <div className="grid gap-3">
      <ReconcileTiles counts={counts} filter={filter} onFilter={setFilter} show="Show them below" />
      <div className="ad-tablewrap">
        <table className="ad-table wpd-recgrid sr-grid">
          <thead>
            <tr>
              <th>Paid</th>
              <th>Date</th>
              <th className="ad-num">Amount</th>
              <th>Proof, and what&apos;s wrong</th>
            </tr>
          </thead>
          <GroupedRows
            rows={shown}
            all={all}
            names={names}
            reports={reports}
            colors={colors}
            columns={4}
            narrowed={!!filter}
            foldWords={() => 'fully proved'}
            foldComplete
            row={(r) => (
              <tr className={`sr-row-${r.tone}`}>
                <td>
                  <span className="font-semibold">{r.title}</span>
                  <span className="ad-table-sub">{r.sub}</span>
                </td>
                <td className="whitespace-nowrap">{r.date}</td>
                <td className="ad-num font-semibold">{money(r.amount)}</td>
                <td>
                  <span className="flex flex-wrap gap-1">
                    {r.slots.map((s) => (
                      <ProofChip key={s.label} s={s} />
                    ))}
                  </span>
                  <Problems row={r} />
                </td>
              </tr>
            )}
          />
        </table>
      </div>
    </div>
  )
}

/** People the files name who are on no list: each with its one action (owners). */
export function OnNoList({
  people,
}: {
  people: { name: string; where: string; action: string; onAdd: () => void }[]
}) {
  if (!people.length) return null
  return (
    <section className="sr-nolist">
      <h3>
        {people.length} {people.length === 1 ? 'person' : 'people'} in your files on no list
      </h3>
      <ul>
        {people.map((p, n) => (
          <li key={`${p.name}-${n}`}>
            <span>
              <b>{p.name}</b> <span className="text-soft">· found {p.where}</span>
            </span>
            <button type="button" className="wpd-linkbtn" onClick={p.onAdd}>
              {p.action} →
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
