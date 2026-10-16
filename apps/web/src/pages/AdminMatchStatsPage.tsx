import { useState } from 'react'
import {
  MATCH_FEATURES,
  MATCH_FEATURE_LABELS,
  MATCH_OUTCOME_LABELS,
  MATCH_STAT_DAYS,
  type AdminMatchStatsDto,
  type MatchFeature,
  type MatchOutcome,
  type MatchStatRowDto,
} from '@ad/types'
import { useLoad } from '@/hooks/useApi'
import { shortDate } from '@/lib/format'
import { Card, Chip, Empty, ErrorNote, Tile, type Tone } from '@/components/ui'
import { AdminHow, AdminToolHead } from '@/pages/AdminPage'

// Each feature keeps its colour whatever the filter shows (categorical slots 1 to 3, checked for colour blindness).
const COLOR: Record<MatchFeature, string> = {
  payroll: '#2a78d6',
  receipts: '#eb6834',
  'emailed-receipts': '#1baf7a',
}
// Solid chips with a sign: finished green, ended without a save grey, failed amber.
const TONE: Record<MatchOutcome, Tone> = {
  saved: 'ok',
  done: 'ok',
  discarded: 'muted',
  expired: 'muted',
  failed: 'warn',
}
const SIGN: Record<MatchOutcome, string> = {
  saved: '✅',
  done: '✅',
  discarded: '✖️',
  expired: '⌛',
  failed: '⚠️',
}

/**
 * Admin tools → Matching statistics: how often the payroll and receipt matchers run, how big the uploads are, how long
 * they take and how well they match, across workspaces. Counts only: no file, name or amount is ever shown here.
 */
export function AdminMatchStatsPage() {
  const [days, setDays] = useState<number>(30)
  const [feature, setFeature] = useState<MatchFeature | ''>('')
  const { data, error, status } = useLoad<AdminMatchStatsDto>(
    `/admin/match-stats?days=${days}${feature ? `&feature=${feature}` : ''}`
  )
  const shown = feature ? [feature] : [...MATCH_FEATURES]
  const filters = (
    <div className="ad-refresh">
      <label className="ad-refresh-auto">
        Period
        <select
          className="ad-refresh-select"
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
        >
          {MATCH_STAT_DAYS.map((d) => (
            <option key={d} value={d}>
              Last {d} days
            </option>
          ))}
        </select>
      </label>
      <label className="ad-refresh-auto">
        Feature
        <select
          className="ad-refresh-select"
          value={feature}
          onChange={(e) => setFeature(e.target.value as MatchFeature | '')}
        >
          <option value="">All features</option>
          {MATCH_FEATURES.map((f) => (
            <option key={f} value={f}>
              {MATCH_FEATURE_LABELS[f]}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
  const t = data?.totals
  return (
    <>
      <AdminToolHead to="/admin/match-stats" />
      <Card title="Match runs" aside={filters}>
        <ErrorNote
          message={status === 403 ? 'You are no longer a platform admin. Reload the page.' : error}
        />
        {!data && !error && <Empty>Loading…</Empty>}
        {data && t && t.runs === 0 && <Empty>No match runs in this period yet.</Empty>}
        {data && t && t.runs > 0 && (
          <>
            <div className="ad-tiles">
              <Tile label="Runs" value={t.runs} />
              <Tile label="Files" value={t.files} note={bytes(t.bytes)} />
              <Tile
                label="Matched"
                value={t.lookedFor ? `${Math.round((100 * t.matched) / t.lookedFor)}%` : '—'}
                note={`${t.matched} of ${t.lookedFor} found sure`}
              />
            </div>
            <div className="ad-stats-charts">
              <LineChart
                title="Runs per day"
                days={data.series.map((d) => d.day)}
                lines={shown.map((f) => ({
                  label: MATCH_FEATURE_LABELS[f],
                  color: COLOR[f],
                  values: data.series.map((d) => d.runs[f]),
                }))}
                format={(n) => String(Math.round(n))}
              />
              <LineChart
                title="Match rate"
                days={data.series.map((d) => d.day)}
                lines={[
                  {
                    label: 'Matched',
                    color: 'var(--navy)',
                    values: data.series.map((d) =>
                      d.matchRate == null ? null : Math.round(d.matchRate * 100)
                    ),
                  },
                ]}
                max={100}
                format={(n) => `${Math.round(n)}%`}
              />
            </div>
            <RunsTable rows={data.rows} total={t.runs} />
          </>
        )}
        <AdminHow to="/admin/match-stats" />
      </Card>
    </>
  )
}

type Line = { label: string; color: string; values: (number | null)[] }

const W = 640
const H = 180
const PAD = { left: 36, right: 12, top: 12, bottom: 24 }

/** A small line graph, one y-axis from 0, a day per point; hover shows that day's values. */
function LineChart({
  title,
  days,
  lines,
  max,
  format,
}: {
  title: string
  days: string[]
  lines: Line[]
  max?: number
  format: (n: number) => string
}) {
  const [at, setAt] = useState<number | null>(null)
  const top =
    max ?? Math.max(1, ...lines.flatMap((l) => l.values.filter((v): v is number => v != null)))
  const x = (i: number) =>
    PAD.left + (days.length < 2 ? 0 : (i * (W - PAD.left - PAD.right)) / (days.length - 1))
  const y = (v: number) => PAD.top + (1 - v / top) * (H - PAD.top - PAD.bottom)
  // Each run of days with a value is its own stretch of line; a day with nothing to show breaks it.
  const paths = (values: (number | null)[]) => {
    let d = ''
    values.forEach((v, i) => {
      if (v == null) return
      d += `${i > 0 && values[i - 1] != null ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`
    })
    return d
  }
  const ticks = [0, top / 2, top]
  const label = (day: string) => shortDate(day).replace(/, \d{4}$/, '')
  return (
    <figure className="ad-stats-chart">
      <figcaption className="ad-stats-chart-title">{title}</figcaption>
      {lines.length > 1 && (
        <ul className="ad-stats-legend">
          {lines.map((l) => (
            <li key={l.label}>
              <i style={{ background: l.color }} aria-hidden="true" />
              {l.label}
            </li>
          ))}
        </ul>
      )}
      <div className="ad-stats-plot">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`${title}, ${label(days[0]!)} to ${label(days[days.length - 1]!)}`}
          onMouseMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            const px = ((e.clientX - r.left) / r.width) * W
            const i = Math.round(((px - PAD.left) / (W - PAD.left - PAD.right)) * (days.length - 1))
            setAt(Math.max(0, Math.min(days.length - 1, i)))
          }}
          onMouseLeave={() => setAt(null)}
        >
          {ticks.map((v) => (
            <g key={v}>
              <line
                x1={PAD.left}
                x2={W - PAD.right}
                y1={y(v)}
                y2={y(v)}
                className="ad-stats-grid"
              />
              <text x={PAD.left - 6} y={y(v) + 4} textAnchor="end" className="ad-stats-axis">
                {format(v)}
              </text>
            </g>
          ))}
          <text x={PAD.left} y={H - 6} className="ad-stats-axis">
            {label(days[0]!)}
          </text>
          <text x={W - PAD.right} y={H - 6} textAnchor="end" className="ad-stats-axis">
            {label(days[days.length - 1]!)}
          </text>
          {at != null && (
            <line
              x1={x(at)}
              x2={x(at)}
              y1={PAD.top}
              y2={H - PAD.bottom}
              className="ad-stats-cross"
            />
          )}
          {lines.map((l) => (
            <g key={l.label}>
              <path d={paths(l.values)} fill="none" stroke={l.color} strokeWidth={2} />
              {at != null && l.values[at] != null && (
                <circle
                  cx={x(at)}
                  cy={y(l.values[at]!)}
                  r={4}
                  fill={l.color}
                  stroke="var(--surface)"
                  strokeWidth={2}
                />
              )}
            </g>
          ))}
        </svg>
        {at != null && (
          <div
            className="ad-stats-tip"
            style={{ left: `${(x(at) / W) * 100}%` }}
            role="status"
            aria-live="polite"
          >
            <strong>{shortDate(days[at])}</strong>
            {lines.map((l) => (
              <span key={l.label}>
                <i style={{ background: l.color }} aria-hidden="true" />
                {l.label}: {l.values[at] == null ? '—' : format(l.values[at]!)}
              </span>
            ))}
          </div>
        )}
      </div>
    </figure>
  )
}

function RunsTable({ rows, total }: { rows: MatchStatRowDto[]; total: number }) {
  return (
    <>
      <div className="ad-tablewrap">
        <table className="ad-table">
          <thead>
            <tr>
              <th>When</th>
              <th>Feature</th>
              <th>Workspace</th>
              <th>Who</th>
              <th className="ad-num">Files</th>
              <th className="ad-num">Size</th>
              <th className="ad-num">Duration</th>
              <th>Outcome</th>
              <th>Results</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="whitespace-nowrap">
                  {shortDate(r.finishedAt)}
                  <span className="ad-table-sub">
                    {new Date(r.finishedAt).toLocaleTimeString([], {
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </span>
                </td>
                <td className="whitespace-nowrap">{MATCH_FEATURE_LABELS[r.feature]}</td>
                <td>{r.workspaceName}</td>
                <td className="ad-mono text-xs">{r.startedByEmail}</td>
                <td className="ad-num">{r.fileCount}</td>
                <td className="ad-num whitespace-nowrap">{bytes(r.totalBytes)}</td>
                <td className="ad-num whitespace-nowrap">
                  {duration(r.durationMs)}
                  {r.readMs != null && (
                    <span className="ad-table-sub">{duration(r.readMs)} reading</span>
                  )}
                </td>
                <td>
                  <Chip tone={TONE[r.outcome]} fill>
                    <span aria-hidden="true">{SIGN[r.outcome]}</span>{' '}
                    {MATCH_OUTCOME_LABELS[r.outcome]}
                  </Chip>
                </td>
                <td className="text-sm">{results(r)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {total > rows.length && (
        <p className="ad-table-sub">
          The newest {rows.length} of {total} runs. The graphs count them all.
        </p>
      )}
    </>
  )
}

/** What the matcher found, in the feature's own words. */
function results(r: MatchStatRowDto): string {
  const parts =
    r.feature === 'payroll'
      ? [
          `${r.items} ${r.items === 1 ? 'item' : 'items'}`,
          `${r.matched} sure`,
          `${r.guessed} guessed`,
          `${r.missing} missing`,
        ]
      : [`${r.matched} matched`, `${r.missing} unmatched`]
  if (r.failed) parts.push(`${r.failed} unreadable`)
  if (r.bankLines) parts.push(`${r.bankLines} bank lines`)
  return parts.join(' · ')
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${Math.round(n / 1024)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

function duration(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)} s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m} min ${Math.round(s % 60)} s` : `${Math.floor(m / 60)} h ${m % 60} min`
}
