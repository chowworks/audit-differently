import { Link } from 'react-router-dom'
import type { ReceiptsInboxDto, StaffListDto, WorkspacePayrollPeriodDto } from '@ad/types'
import { useLoad } from '@/hooks/useApi'
import { periodLabel } from '@/lib/format'
import './workspace-actions.css'

/** One thing only an owner can do, waiting on them now. */
export interface OwnerAction {
  key: string
  icon: string
  /** What is waiting, in a few words: "2 emailed receipts to file". */
  title: string
  /** One line on why it matters. */
  line: string
  count: number
  action: string
  href: string
}

const thisMonth = () => new Date().toISOString().slice(0, 7)

/**
 * What waits on the workspace's owners: emailed receipts to file, engagements with nobody tagged, and (when
 * bookkeepers don't see staff payroll) a finished month whose payroll files aren't in yet. Nothing when all is done.
 */
export function useOwnerActions(workspaceId: string, bookkeepersSeeStaffPayroll: boolean) {
  const { data: inbox } = useLoad<ReceiptsInboxDto>(`/workspaces/${workspaceId}/receipts-inbox`)
  const { data: staff } = useLoad<StaffListDto>(`/workspaces/${workspaceId}/staff`)
  const { data: periods } = useLoad<WorkspacePayrollPeriodDto[]>(
    bookkeepersSeeStaffPayroll ? null : `/workspaces/${workspaceId}/payroll`
  )
  const actions: OwnerAction[] = []
  const toFile = (inbox?.items ?? []).filter((r) => r.status === 'unmatched')
  if (toFile.length)
    actions.push({
      key: 'receipts',
      icon: '✉️',
      title: `${toFile.length} emailed ${toFile.length === 1 ? 'receipt' : 'receipts'} to file`,
      line: 'Receipts sent to the workspace address that need an engagement and a month.',
      count: toFile.length,
      action: 'File receipts',
      href: '#receipts',
    })
  const failed = (inbox?.items ?? []).filter((r) => r.status === 'failed')
  if (failed.length)
    actions.push({
      key: 'receipts-failed',
      icon: '🔄',
      title: `${failed.length} emailed ${failed.length === 1 ? "receipt didn't" : "receipts didn't"} go through`,
      line: "The email provider didn't answer. Run it again, or dismiss it if it's not needed.",
      count: failed.length,
      action: 'Run again or dismiss',
      href: '#receipts',
    })
  const tagged = new Set((staff?.staff ?? []).flatMap((s) => s.engagements.map((e) => e.id)))
  const untagged = (staff?.engagements ?? []).filter(
    (e) => (e.status === 'active' || e.status === 'awarded') && !tagged.has(e.id)
  )
  if (staff && untagged.length)
    actions.push({
      key: 'staffing',
      icon: '👥',
      title:
        untagged.length === 1
          ? `Tag staff for ${untagged[0]!.name}`
          : `Tag staff for ${untagged.length} engagements`,
      line: 'Their timecards and pay are filed to the engagements they are tagged to.',
      count: untagged.length,
      action: 'Tag staff',
      href: `/workspaces/${workspaceId}/staff`,
    })
  const missing = (periods ?? []).filter(
    (p) => p.period < thisMonth() && p.months > 0 && p.payLines === 0
  )
  if (missing.length) {
    const first = missing[missing.length - 1]!
    actions.push({
      key: 'month-end',
      icon: '🗓️',
      title:
        missing.length === 1
          ? `Provide ${periodLabel(first.period)} payroll`
          : `Provide payroll for ${missing.length} months`,
      line: "Bookkeepers don't see staff payroll here, so month end waits on your files.",
      count: missing.length,
      action: 'Process month end',
      href: `/workspaces/${workspaceId}/payroll?period=${first.period}`,
    })
  }
  return actions
}

function Go({ a, className }: { a: OwnerAction; className: string }) {
  return a.href.startsWith('#') ? (
    <a href={a.href} className={className}>
      {a.action}
    </a>
  ) : (
    <Link to={a.href} className={className}>
      {a.action}
    </Link>
  )
}

const Badge = ({ n }: { n: number }) => <span className="wa-badge">{n}</span>

/** The owner's actions at the top of the workspace page; nothing shows when nothing waits. */
export function WorkspaceActions({
  workspaceId,
  bookkeepersSeeStaffPayroll,
}: {
  workspaceId: string
  bookkeepersSeeStaffPayroll: boolean
}) {
  const actions = useOwnerActions(workspaceId, bookkeepersSeeStaffPayroll)
  const total = actions.reduce((t, a) => t + a.count, 0)
  if (!actions.length) return null
  return (
    <section className="ad-card wa-list" aria-label="Workspace Owner Actions">
      <header>
        <h2 className="ad-card-title">Workspace Owner Actions</h2>
        <Badge n={total} />
      </header>
      <ul>
        {actions.map((a) => (
          <li key={a.key}>
            <span className="wa-tile-icon" aria-hidden="true">
              {a.icon}
            </span>
            <span>
              <b>{a.title}</b>
              <small>{a.line}</small>
            </span>
            <Go a={a} className="ad-btn ad-btn-navy ad-btn-sm" />
          </li>
        ))}
      </ul>
    </section>
  )
}
