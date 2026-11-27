import { Link } from 'react-router-dom'
import {
  DROPPED_DECISION_WHY_LABELS,
  PAYROLL_BUDGET_KIND_LABELS,
  REPORT_STATUS_LABELS,
  type DroppedDecisionDto,
  type PayrollMatchSaveInput,
  type PlanProofDto,
  type WorkspacePayrollMonthDto,
  type WorkspacePayrollRunDto,
} from '@ad/types'
import { money, shortDate } from '@/lib/format'
import {
  filesWords,
  kindWord,
  paymentsWords,
  proofWords,
  staffWords,
} from '@/pages/workspace-payroll-plan'

/**
 * What must be set up before the owner's match can save, on Review participant pay (owner's ask, 2026-11-15: only when
 * the run needs it). The words are worked out in `workspace-payroll-plan.ts`.
 */

/** What the dropped decision was: "Linked to Expense ISY-12 (In-School Youth)" or "Marked not grant-funded". */
const decisionWords = (d: DroppedDecisionDto) =>
  d.decision === 'not-funded'
    ? 'Marked not grant-funded'
    : `Linked to ${d.itemTitle ?? 'a payroll item'}${d.engagementName ? ` (${d.engagementName})` : ''}`

/**
 * What Save will do, in the owner's words, right above Save: the files and where they reach, the payments, the proof
 * attached and the staff found; and, only when there are any, the files leaving, decisions dropped and months to reopen.
 */
export function PlanWords({
  run,
  chosen,
  proof,
  reopen,
}: {
  run: WorkspacePayrollRunDto
  /** The owner's own choices on the table. */
  chosen: PayrollMatchSaveInput['links']
  /** The proof Save attaches, the owner's choices included (`proofList`). */
  proof: PlanProofDto[]
  reopen: WorkspacePayrollMonthDto[]
}) {
  const { plan } = run
  return (
    <section aria-label="What Save will do">
      <h3 className="mx-work-title">What Save will do</h3>
      <ul className="grid list-disc gap-1 pl-5 text-sm">
        {(run.setup ?? []).length > 0 && (
          <li className="text-danger">
            <b>⚠ Not set up for payroll</b> (its pay cannot reach it until this is fixed; then match
            again):
            <ul className="mt-1 grid gap-1">
              {run.setup!.map((x) => (
                <li key={x.engagementId} className="flex flex-wrap items-center gap-2">
                  <span>
                    {x.engagementName}:{' '}
                    {x.missing
                      .map((m) =>
                        m === 'people'
                          ? 'no staff tagged to it and no participants'
                          : 'no budget line holds payroll'
                      )
                      .join('; ')}
                  </span>
                  {x.missing.includes('people') && (
                    <Link to={`/workspaces/${run.workspaceId}/staff`}>Tag staff →</Link>
                  )}
                  {x.missing.includes('budget') && (
                    <Link to={`/engagements/${x.engagementId}?manage=budget`}>
                      Open its budget →
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </li>
        )}
        <li>
          <b>Files:</b> {filesWords(run, chosen).line}.
        </li>
        {plan.change.leaving.length > 0 && (
          <li>
            <b>Leaving:</b>
            <ul className="wpc-files mt-1 grid gap-0.5">
              {plan.change.leaving.map((l) => (
                <li key={l.documentId}>
                  {l.fileName} ({kindWord(l.kind)}):{' '}
                  {l.why === 'changed'
                    ? 'a new copy takes its place'
                    : run.mode === 'remove'
                      ? 'removed'
                      : 'not in the new zip'}
                </li>
              ))}
            </ul>
          </li>
        )}
        <li>
          <b>Work-experience payments:</b> {paymentsWords(run)}.
        </li>
        {plan.payrollLines.write > 0 && (
          <li>
            <b>Staff payroll on the budget:</b> {plan.payrollLines.write}{' '}
            {plan.payrollLines.write === 1 ? 'line' : 'lines'} from payroll details.
          </li>
        )}
        {plan.payrollLines.unbudgeted.length > 0 && (
          <li className="text-danger">
            <b>⛔ Not on the budget</b> (no budget line takes it, so Save leaves it off):
            <ul className="mt-1 grid gap-1">
              {plan.payrollLines.unbudgeted.map((u) => (
                <li key={`${u.reportId}-${u.kind}`} className="flex flex-wrap items-center gap-2">
                  <span>
                    {u.engagementName}: {money(u.amount)} of{' '}
                    {PAYROLL_BUDGET_KIND_LABELS[u.kind].toLowerCase()}
                  </span>
                  <Link to={`/engagements/${u.engagementId}?manage=budget`}>Open its budget →</Link>
                </li>
              ))}
            </ul>
          </li>
        )}
        {plan.payrollLines.keep.length > 0 && (
          <li>
            <b>Kept for reconciliation only</b> (the match counts the same pay, so they stop
            counting):
            <ul className="mt-1 grid gap-0.5">
              {plan.payrollLines.keep.map((e) => (
                <li key={`${e.reportId}-${e.itemNumber}`}>
                  {e.engagementName}: {e.itemNumber}, {money(e.amount)} (
                  {PAYROLL_BUDGET_KIND_LABELS[e.kind].toLowerCase()}, {shortDate(e.date)})
                </li>
              ))}
            </ul>
          </li>
        )}
        <li>
          <b>{proofWords(run, proof)}.</b>
        </li>
        <li>
          <b>Staff:</b> {staffWords(run)}.
        </li>
        {plan.twoProofs.length > 0 && (
          <li>
            <b>⚠️ Two different files as one proof</b> (both are kept):
            <ul className="mt-1 grid gap-0.5">
              {plan.twoProofs.map((t) => (
                <li key={`${t.target}-${t.id}-${t.slot}`}>
                  {t.message} ({t.engagementName})
                </li>
              ))}
            </ul>
          </li>
        )}
        {plan.dropped.length > 0 && (
          <li>
            <b>Your decisions Save drops:</b>
            <ul className="mt-1 grid gap-0.5">
              {plan.dropped.map((d, n) => (
                <li key={`${d.fileName}-${n}`}>
                  {d.fileName}: {decisionWords(d)}. {DROPPED_DECISION_WHY_LABELS[d.why]}.
                </li>
              ))}
            </ul>
          </li>
        )}
        {reopen.length > 0 && (
          <li>
            <b>⚠️ Months to reopen</b> (you say why at Save):
            <ul className="mt-1 grid gap-0.5">
              {reopen.map((m) => (
                <li key={m.reportId}>
                  {m.engagementName}: {REPORT_STATUS_LABELS[m.status].toLowerCase()}
                </li>
              ))}
            </ul>
          </li>
        )}
      </ul>
    </section>
  )
}
