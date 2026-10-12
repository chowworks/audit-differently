import { Link, useParams } from 'react-router-dom'
import type { ReportDetail } from '@ad/types'
import { useLoad } from '@/hooks/useApi'
import { money, periodLabel, shortDate } from '@/lib/format'
import { Button, Empty, ErrorNote } from '@/components/ui'

/** The funder's review steps, in neutral words; a funder's own checklist is a per-workspace list later. */
const CHECKLIST: [keyof NonNullable<ReportDetail['review']>, string][] = [
  ['newServicesEntered', 'Services for the period are entered in the case system'],
  ['newEnrollmentsEntered', 'New enrollments for the period are entered'],
  ['servicesInProgress', 'Services in progress for the period were reviewed'],
  ['caseNotesChecked', 'A sample of case notes confirms services were delivered'],
  ['fileReviewCompleted', 'A file review or desk audit supports the services billed'],
  ['siteVisitConducted', 'A site visit during the period observed service delivery'],
]

/** The funder's monthly financial report form, filled from the ledger. Print it or save it as a PDF. */
export function ReportFormPage() {
  const { id } = useParams()
  const { data: r, error } = useLoad<ReportDetail>(id ? `/reports/${id}` : null)
  if (error) return <ErrorNote message={error} />
  if (!r) return <Empty>Loading…</Empty>
  const total = (
    k: 'previouslyBilled' | 'billedThisPeriod' | 'cumulative' | 'budget' | 'remaining'
  ) => r.lines.reduce((t, l) => t + l[k], 0)
  const box = (on: boolean | undefined) => (
    <span className="inline-block w-5 border border-ink text-center font-mono text-xs">
      {on ? 'X' : ' '}
    </span>
  )
  const wex = new Set(['participant-wages', 'participant-fringes', 'wex'])
  // The boxes come from the workspace's list; whatever the engagement ticked outside it still prints.
  const funding = [...new Set([...r.engagement.fundingOptions, ...r.engagement.fundingSources])]
  return (
    <div className="mx-auto max-w-4xl">
      <div className="ad-head print:hidden">
        <div>
          <nav className="ad-crumbs" aria-label="Breadcrumb">
            <Link to={`/workspaces/${r.engagement.workspace.id}`}>
              {r.engagement.workspace.name}
            </Link>{' '}
            /{' '}
            <Link to={`/engagements/${r.engagement.id}`} className="ad-mono">
              {r.engagement.number ?? '—'}
            </Link>{' '}
            / <Link to={`/reports/${r.id}`}>{periodLabel(r.period)}</Link>
          </nav>
          <h1 className="ad-h1">Funder's form</h1>
          <p className="ad-sub">
            The funder's monthly financial report, filled from the ledger. Print it or save it as a
            PDF.
          </p>
        </div>
        <div className="ad-actions">
          <Button kind="primary" onClick={() => window.print()}>
            Print / Save as PDF
          </Button>
        </div>
      </div>
      <div className="border border-ink bg-white p-6 font-sans text-[13px] leading-tight text-ink">
        <h1 className="text-center text-xs font-semibold">{r.engagement.funder ?? ''}</h1>
        <h2 className="text-center text-lg font-extrabold">MONTHLY FINANCIAL REPORT</h2>
        <div className="mt-2 bg-alt px-2 text-center text-xs font-bold">
          SECTION I CONTRACTOR DATA
        </div>
        <div className="mt-2 grid grid-cols-2 gap-x-8 gap-y-1">
          <div>
            <b>Month Submitted:</b> {r.submittedAt ? shortDate(r.submittedAt) : '—'}
          </div>
          <div>
            <b>Billed this Period Covers (one month period):</b> {periodLabel(r.period)}
          </div>
          <div>
            <b>Contract Period:</b> {shortDate(r.engagement.periodStart)} –{' '}
            {shortDate(r.engagement.periodEnd)}
          </div>
          <div>
            <b>Final Financial Report:</b> {box(!r.isFinal)} No {box(r.isFinal)} Yes
          </div>
          <div>
            <b>Agency Name:</b> {r.engagement.workspace.name}
          </div>
          <div>
            <b>SOURCE OF FUNDS</b>{' '}
            {funding.map((f) => (
              <span key={f} className="mr-2 whitespace-nowrap">
                {box(r.engagement.fundingSources.includes(f))} {f}
              </span>
            ))}
          </div>
          <div>
            <b>Contract Number:</b> {r.engagement.number ?? '—'}
          </div>
          <div>
            <b>Program Name:</b> {r.engagement.name}
          </div>
        </div>
        <div className="mt-3 bg-alt px-2 text-center text-xs font-bold">
          SECTION II ACCOUNT OF EXPENDITURES BY LINE ITEM (INCLUDING ACCRUALS)
        </div>
        <table className="mt-1 w-full border-collapse">
          <thead>
            <tr className="text-xs">
              <th className="border border-ink px-1 py-0.5"></th>
              <th className="border border-ink px-1 py-0.5 text-left"></th>
              <th className="border border-ink px-1 py-0.5">Work experience</th>
              <th className="border border-ink px-1 py-0.5">Previously Billed</th>
              <th className="border border-ink px-1 py-0.5">Billed this Period</th>
              <th className="border border-ink px-1 py-0.5">Cumulative Expenses</th>
              <th className="border border-ink px-1 py-0.5">Budget</th>
              <th className="border border-ink px-1 py-0.5">Remaining Amount</th>
            </tr>
          </thead>
          <tbody>
            {r.lines.map((l, i) => (
              <tr key={l.line}>
                <td className="border border-ink px-1 py-0.5 text-center">
                  {i < 2 ? i + 1 : i === 2 ? 4 : i + 2}
                </td>
                <td className="border border-ink px-1 py-0.5">{l.label}</td>
                <td className="border border-ink px-1 py-0.5 text-center font-bold">
                  {wex.has(l.line) ? 'X' : ''}
                </td>
                <td className="border border-ink px-1 py-0.5 text-right">
                  {l.previouslyBilled ? money(l.previouslyBilled) : '-'}
                </td>
                <td className="border border-ink px-1 py-0.5 text-right">
                  {l.billedThisPeriod ? money(l.billedThisPeriod) : '-'}
                </td>
                <td className="border border-ink px-1 py-0.5 text-right">
                  {l.cumulative ? money(l.cumulative) : '-'}
                </td>
                <td className="border border-ink px-1 py-0.5 text-right">
                  {l.budget ? money(l.budget) : '-'}
                </td>
                <td
                  className={`border border-ink px-1 py-0.5 text-right ${l.remaining < 0 ? 'font-bold text-danger' : ''}`}
                >
                  {l.budget || l.cumulative ? money(l.remaining) : '-'}
                </td>
              </tr>
            ))}
            <tr className="font-extrabold">
              <td className="border border-ink px-1 py-1" colSpan={3}>
                TOTAL
              </td>
              <td className="border border-ink px-1 py-1 text-right">
                {money(total('previouslyBilled'))}
              </td>
              <td className="border border-ink px-1 py-1 text-right">
                {money(total('billedThisPeriod'))}
              </td>
              <td className="border border-ink px-1 py-1 text-right">
                {money(total('cumulative'))}
              </td>
              <td className="border border-ink px-1 py-1 text-right">{money(total('budget'))}</td>
              <td className="border border-ink px-1 py-1 text-right">
                {money(total('remaining'))}
              </td>
            </tr>
          </tbody>
        </table>
        <div className="mt-3 bg-alt px-2 text-center text-xs font-bold">SECTION III - Comments</div>
        <p className="min-h-[2.5rem] px-1 py-1">{r.comments ?? ''}</p>
        <div className="bg-alt px-2 text-center text-xs font-bold">
          SECTION IV - SUB-RECIPIENT APPROVAL
        </div>
        <p className="px-1 py-1 text-xs">
          I certify that, to the best of my knowledge and belief, this report is correct and
          complete. All expenses reported here are for the purposes of this sub-recipient's
          participants and this sub-recipient agreement alone.
        </p>
        <div className="grid grid-cols-2 gap-8 px-1 py-1">
          <div>
            <b>Prepared By:</b> {r.preparedByName ?? r.engagement.preparerName ?? '—'}
            {r.engagement.preparerOrganization ? `, ${r.engagement.preparerOrganization}` : ''}
            <br />
            <span className="text-xs text-soft">
              {r.submittedAt ? `Submitted ${shortDate(r.submittedAt)}` : 'Not submitted'}
            </span>
          </div>
          <div>
            <b>Authorized By:</b> {r.authorizedByName ?? r.engagement.authorizerName ?? '—'}
            {r.engagement.authorizerOrganization ? `, ${r.engagement.authorizerOrganization}` : ''}
            <br />
            <span className="text-xs text-soft">
              {r.authorizedAt ? `Certified ${shortDate(r.authorizedAt)}` : ''}
            </span>
          </div>
        </div>
        <div className="mt-2 bg-alt px-2 text-center text-xs font-bold">
          SECTION V - Submission Instructions
        </div>
        <p className="px-1 py-1 text-center text-xs">
          This form must be submitted to: {r.engagement.reportTo ?? 'the funder'}.{' '}
          <b>REPORT IS DUE ON THE {r.engagement.reportDueDay}TH OF EACH MONTH</b>
        </p>
        <div className="bg-alt px-2 text-center text-xs font-bold">
          SECTION VI - {(r.engagement.funder ?? 'FUNDER').toUpperCase()} REVIEW
        </div>
        <div className="grid grid-cols-2 gap-8 px-1 py-1">
          <div>
            <div>Received form on {r.review?.receivedOn ?? '________'}</div>
            <ul className="mt-1 space-y-0.5">
              {CHECKLIST.map(([k, label]) => (
                <li key={k}>
                  {box(!!r.review?.[k])} {label}
                </li>
              ))}
              <li>
                {box(r.status === 'approved' || r.status === 'paid')} Approved for Payment by
                Contract Specialist {r.reviewedAt ? `on ${shortDate(r.reviewedAt)}` : ''}
              </li>
              <li>
                {box(r.status === 'denied')} Denied for Payment Due to: {r.deniedReason ?? ''}
              </li>
            </ul>
          </div>
          <div>
            <b>IV# for payment of this Financial Report:</b> {r.review?.invoiceNumber ?? '________'}
          </div>
        </div>
      </div>
      <p className="mt-2 text-xs text-soft print:hidden">
        Computed from the ledger: line totals are the sum of the month's expenses by report line;
        previously billed is every earlier month of this engagement.
      </p>
    </div>
  )
}
