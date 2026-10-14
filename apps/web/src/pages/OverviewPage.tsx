import { Link } from 'react-router-dom'
import { ENGAGEMENT_KINDS, ENGAGEMENT_KIND_LABELS, type EngagementSummary } from '@ad/types'
import { useSession } from '@/auth/session'
import { useLoad } from '@/hooks/useApi'
import { periodLabel, shortDate } from '@/lib/format'
import { daysUntil, nextDue, workflow } from '@/lib/workflow'
import { Card, Chip, Empty, ErrorNote, Tile } from '@/components/ui'
import { EngagementCard } from '@/components/EngagementCard'
import { CheerCard, HandCard } from '@/components/HandCard'

/** By the clock on this person's machine. */
const greeting = (d: Date) => {
  const h = d.getHours()
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}

/** Across every engagement: what is due, what is missing, and where each one stands in its eight steps. */
export function OverviewPage() {
  const { displayName } = useSession()
  const { data, error, loading } = useLoad<EngagementSummary[]>('/engagements')
  const today = new Date()
  const engagements = data ?? []
  const workspaces = new Set(engagements.map((c) => c.workspaceId)).size
  const flows = engagements.map((c) => ({ c, w: workflow(c, null, today) }))
  const active = engagements.filter(
    (c) => !c.periodEnd || c.periodEnd >= today.toISOString()
  ).length

  const due = engagements
    .map((c) => ({ c, d: nextDue(c, today) }))
    .filter((x): x is { c: EngagementSummary; d: NonNullable<ReturnType<typeof nextDue>> } => !!x.d)
    .sort((a, b) => a.d.dueDate.localeCompare(b.d.dueDate))
  const dueSoon = due.filter((x) => daysUntil(x.d.dueDate, today) <= 14)
  const readiness = flows.length
    ? Math.round(flows.reduce((t, f) => t + f.w.readiness.pct, 0) / flows.length)
    : 0

  // Records to check: the first missing records of each engagement's current step, and months that block.
  const toCheck = flows.flatMap(({ c, w }) => {
    const items: { key: string; label: string; note: string; href: string; bad: boolean }[] = []
    const seen = new Set<string>()
    for (const r of w.current.records.filter((r) => !r.done).slice(0, 2)) {
      seen.add(r.key)
      items.push({
        key: `${c.id}:${r.key}`,
        label: r.task,
        note: `${c.name}${r.note ? ` · ${r.note}` : ''}`,
        href: r.href ?? `/engagements/${c.id}`,
        bad: !!r.note?.includes('blocking'),
      })
    }
    for (const r of c.reports.filter((r) => r.openBlockers > 0 && !seen.has(`ledger:${r.period}`)))
      items.push({
        key: `${c.id}:${r.id}`,
        label: `${periodLabel(r.period)} has ${r.openBlockers} blocking check${r.openBlockers === 1 ? '' : 's'}`,
        note: c.name,
        href: `/reports/${r.id}`,
        bad: true,
      })
    return items
  })

  return (
    <>
      <div className="ad-head">
        <div>
          <p className="ad-eyebrow">
            {today.toLocaleDateString('en-US', {
              weekday: 'long',
              month: 'long',
              day: 'numeric',
              year: 'numeric',
            })}
          </p>
          <h1 className="ad-h1">
            {greeting(today)}, {displayName.split(' ')[0]}
          </h1>
          <p className="ad-sub">
            {toCheck.length === 0
              ? 'Your records are in good shape. Nothing is waiting on you.'
              : `${toCheck.length} record${toCheck.length === 1 ? '' : 's'} to look at before the next report.`}
          </p>
        </div>
        <div className="ad-actions">
          <Link to="/engagements/new" className="ad-btn">
            + Set up an award
          </Link>
        </div>
      </div>
      <ErrorNote message={error} />
      {loading && !data && <Empty>Loading…</Empty>}

      <div className="ad-tiles">
        <Tile
          label="Active engagements"
          value={active}
          note={workspaces > 1 ? `${workspaces} workspaces` : engagements[0]?.workspaceName}
        />
        <Tile
          label="Reports due soon"
          value={dueSoon.length}
          note={
            due[0]
              ? `${periodLabel(due[0].d.period)} due ${shortDate(due[0].d.dueDate)}`
              : 'Nothing due'
          }
          warn={dueSoon.some((x) => daysUntil(x.d.dueDate, today) < 0)}
        />
        <Tile
          label="Audit readiness"
          value={`${readiness}%`}
          progress={readiness}
          note={
            active === 1
              ? 'Records on file over records the audit asks for'
              : 'Across all active engagements'
          }
        />
        <CheerCard lead="A little progress, a lot less stress.">
          Keep your records up to date as you go. Future you will thank you.
        </CheerCard>
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        <div className="grid content-start gap-4 lg:col-span-3">
          <p className="ad-eyebrow !mb-0">Your portfolio</p>
          {ENGAGEMENT_KINDS.filter((k) => engagements.some((c) => c.kind === k)).map((k) => {
            const group = engagements.filter((c) => c.kind === k)
            const live = group.filter(
              (c) => !c.periodEnd || c.periodEnd >= today.toISOString()
            ).length
            return (
              <div key={k} className="grid gap-4">
                <div className="ad-head !mb-0 !items-end">
                  <h2 className="ad-card-title">
                    {ENGAGEMENT_KIND_LABELS[k]}
                    {group.length === 1 ? '' : 's'}
                  </h2>
                  <span className="text-sm text-soft">
                    {live} active{group.length > live ? ` · ${group.length - live} ended` : ''}
                  </span>
                </div>
                {group.map((c) => (
                  <EngagementCard key={c.id} c={c} showWorkspace />
                ))}
              </div>
            )
          })}
          {data?.length === 0 && (
            <Empty>Nothing tracked yet. Set up the first award from its letter.</Empty>
          )}
        </div>

        <div className="grid content-start gap-4 lg:col-span-2">
          {/* The same two header rows as "Your portfolio", kept but hidden, so the first cards start level. */}
          <p className="ad-eyebrow !mb-0 invisible hidden lg:block" aria-hidden="true">
            Don't miss a date
          </p>
          <div className="ad-head !mb-0 !items-end invisible hidden lg:flex" aria-hidden="true">
            <h2 className="ad-card-title">Coming up</h2>
          </div>
          <Card eyebrow="Don't miss a date" title="Coming up">
            {due.length === 0 && <Empty>Nothing due.</Empty>}
            <ul className="ad-rows">
              {due.slice(0, 5).map(({ c, d }) => {
                const days = daysUntil(d.dueDate, today)
                const when = new Date(d.dueDate)
                return (
                  <li key={`${c.id}:${d.period}`} className="ad-row">
                    <span className="ad-date">
                      <b>{when.getUTCDate()}</b>
                      <span>
                        {when.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' })}
                      </span>
                    </span>
                    <span className="ad-row-main">
                      <b>
                        <Link to={d.report ? `/reports/${d.report.id}` : `/engagements/${c.id}`}>
                          Monthly financial report · {periodLabel(d.period)}
                        </Link>
                      </b>
                      <span>
                        {c.name} ·{' '}
                        {days < 0
                          ? `${-days} days late`
                          : days === 0
                            ? 'due today'
                            : `due in ${days} day${days === 1 ? '' : 's'}`}
                        {d.report?.status === 'draft' && d.report.openBlockers > 0
                          ? ` · ${d.report.openBlockers} blocking`
                          : ''}
                      </span>
                    </span>
                    {days <= 7 && (
                      <Chip tone={days < 0 ? 'danger' : 'warn'}>{days < 0 ? 'late' : 'soon'}</Chip>
                    )}
                  </li>
                )
              })}
            </ul>
          </Card>

          <Card
            eyebrow="Stay audit-ready"
            title="Records to check"
            aside={
              toCheck.length > 0 && (
                <Chip tone={toCheck.some((t) => t.bad) ? 'danger' : 'warn'}>{toCheck.length}</Chip>
              )
            }
          >
            {toCheck.length === 0 && (
              <Empty>Everything the audit asks for so far is on file.</Empty>
            )}
            <ul className="ad-rows">
              {toCheck.slice(0, 6).map((t) => (
                <li key={t.key} className="ad-row">
                  <span className={`ad-check-dot ${t.bad ? 'bad' : ''}`} aria-hidden="true">
                    !
                  </span>
                  <span className="ad-row-main">
                    <b>
                      <Link to={t.href}>{t.label}</Link>
                    </b>
                    <span>{t.note}</span>
                  </span>
                </li>
              ))}
            </ul>
          </Card>

          <HandCard lead="Your records, one step at a time.">
            <p>
              Each engagement walks the same eight steps, from the proposal to the final audit. The
              next step is always marked, and the audit package builds itself from what you save
              along the way.
            </p>
          </HandCard>
        </div>
      </div>
    </>
  )
}
