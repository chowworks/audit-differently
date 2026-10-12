import { Link } from 'react-router-dom'
import type { EngagementSummary } from '@ad/types'
import { money, shortDate } from '@/lib/format'
import { workflow } from '@/lib/workflow'
import { Chip } from '@/components/ui'

/** One engagement on the overview and in a workspace: where it is in the eight steps and what is next. */
export function EngagementCard({
  c,
  showWorkspace,
}: {
  c: EngagementSummary
  showWorkspace: boolean
}) {
  const w = workflow(c, null)
  const blockers = c.reports.reduce((t, r) => t + r.openBlockers, 0)
  const meta = [
    c.funder ? `Funded by ${c.funder}` : 'Funder not named yet',
    c.periodStart && c.periodEnd
      ? `${shortDate(c.periodStart)} to ${shortDate(c.periodEnd)}`
      : c.status === 'proposed'
        ? 'proposal stage'
        : 'dates not set',
    c.awardAmount != null
      ? money(c.awardAmount)
      : c.requestedAmount != null
        ? `${money(c.requestedAmount)} requested`
        : null,
  ].filter(Boolean)
  return (
    <section className="ad-card">
      <div className="ad-card-body ad-grant-card">
        <div className="ad-head !mb-0">
          <div>
            {(showWorkspace || c.number) && (
              <p className="ad-eyebrow flex flex-wrap items-center gap-2">
                {showWorkspace && <span>{c.workspaceName}</span>}
                {showWorkspace && c.number && <span>·</span>}
                {c.number && (
                  <span className="ad-mono normal-case tracking-normal">{c.number}</span>
                )}
              </p>
            )}
            <h2 className="ad-card-title">
              <Link to={`/engagements/${c.id}`} className="text-navy no-underline hover:underline">
                {c.name}
              </Link>
            </h2>
            <p className="mt-1 text-sm text-soft">{meta.join(' · ')}</p>
          </div>
          <div className="ad-actions">
            {blockers > 0 ? (
              <Chip tone="danger" fill>
                {blockers} blocking
              </Chip>
            ) : (
              <Chip tone="ok">on track</Chip>
            )}
          </div>
        </div>
        <div>
          <div className="mb-1 flex justify-between text-sm">
            <span className="text-soft">Workflow progress</span>
            <b>
              {w.doneCount} of {w.steps.length} steps
            </b>
          </div>
          <div className="ad-progress">
            <i style={{ width: `${(w.doneCount / w.steps.length) * 100}%` }} />
          </div>
        </div>
        <div className="ad-grant-foot">
          <span>
            <span className="ad-eyebrow mr-2 inline">Next up</span>
            {w.nextUp ? (
              <Link to={w.nextUp.href} className="font-semibold">
                {w.nextUp.label}
              </Link>
            ) : (
              'Nothing waiting'
            )}
          </span>
          <Link to={`/engagements/${c.id}`} className="font-bold">
            Open engagement →
          </Link>
        </div>
      </div>
    </section>
  )
}
