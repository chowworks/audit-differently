import { Fragment } from 'react'
import { Link, useParams } from 'react-router-dom'
import { WEX_REPORT_LINES, tagValueLabel, type LineRow, type ReportDetail } from '@ad/types'
import { useLoad } from '@/hooks/useApi'
import { money, periodLabel, shortDate } from '@/lib/format'
import { Button, Empty, ErrorNote } from '@/components/ui'

/**
 * The funder's own review section (Section VI), in the form's own words: we produce their form (owner's decision,
 * 2026-10-16). The funder fills it in; it prints blank here.
 */
const FUNDER_REVIEW = [
  'New services entered for the billing period (month prior) (Entered by Fiscals for state entities only)',
  'New Enrollment(s) entered for the billing period (month prior)',
  'Services in progress for the billing period (month prior)',
  '5 Participants checked for case notes to ensure services were delivered',
  'Completed File Review or Desk Audit that supported services delivered',
  'Site Visit Conducted during the billing period and service delivery observed',
  'Approved for Payment by Contract Specialist Date ________',
  'Denied for Payment Due to: ________',
]

/** The form's line numbers. 3a is its subtotal of lines 1 and 2, so there is no line 3. */
const LINE_NUMBER: Record<string, string> = {
  'staff-salaries': '1',
  'staff-fringe': '2',
  'program-costs': '4',
  'participant-wages': '5',
  'participant-fringes': '6',
  wex: '7',
  indirect: '8',
}

/** 12 -> "12TH", 1 -> "1ST", 22 -> "22ND". */
const ordinal = (n: number) => {
  const teen = n % 100 >= 11 && n % 100 <= 13
  const suffix = teen ? 'TH' : ({ 1: 'ST', 2: 'ND', 3: 'RD' } as Record<number, string>)[n % 10]
  return `${n}${suffix ?? 'TH'}`
}

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
  const staff = r.lines.filter((l) => l.line === 'staff-salaries' || l.line === 'staff-fringe')
  const sum = (rows: LineRow[], k: keyof Omit<LineRow, 'line' | 'label'>) =>
    rows.reduce((t, l) => t + l[k], 0)
  const amount = (v: number) => (v ? money(v) : '-')
  // Remaining amounts as the form writes them: an overspend in parentheses, (926.48), not -926.48.
  const remaining = (v: number) => (v < 0 ? `(${money(-v)})` : money(v))
  // The engagement's tags of the types that apply to engagements (its sources of funds), in their words.
  const engagementTypes = r.tagTypes.filter((t) => t.appliesTo.includes('engagement'))
  // Every value is listed, ticked or not, as the form does ("Check all that apply"); a tag whose value has left the
  // list still shows, ticked.
  const funding = [
    ...engagementTypes.flatMap((t) =>
      t.values.map((v) => ({ label: v.label, on: r.engagement.tags.includes(`${t.key}:${v.key}`) }))
    ),
    ...r.engagement.tags
      .filter(
        (tag) =>
          engagementTypes.some((x) => tag.startsWith(`${x.key}:`)) &&
          !engagementTypes.some((x) => x.values.some((v) => tag === `${x.key}:${v.key}`))
      )
      .map((tag) => ({ label: tagValueLabel(r.tagTypes, tag), on: true })),
  ]
  const submittedMonth = r.submittedAt
    ? new Date(r.submittedAt).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
    : '—'
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
            <b>Month Submitted:</b> {submittedMonth}
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
          <div className="row-span-3">
            <b>SOURCE OF FUNDS</b> <span className="text-xs">Check all that apply</span>
            <ul className="mt-0.5 space-y-0.5">
              {funding.map((f) => (
                <li key={f.label}>
                  {box(f.on)} {f.label}
                </li>
              ))}
              <li>{box(false)} Other: ________</li>
            </ul>
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
              <th className="border border-ink px-1 py-0.5">Work Experience for 9130</th>
              <th className="border border-ink px-1 py-0.5">Previously Billed</th>
              <th className="border border-ink px-1 py-0.5">Billed this Period</th>
              <th className="border border-ink px-1 py-0.5">Cumulative Expenses</th>
              <th className="border border-ink px-1 py-0.5">Budget</th>
              <th className="border border-ink px-1 py-0.5">Remaining Amount</th>
            </tr>
          </thead>
          <tbody>
            {r.lines.map((l) => (
              <Fragment key={l.line}>
                <tr>
                  <td className="border border-ink px-1 py-0.5 text-center">
                    {LINE_NUMBER[l.line] ?? ''}
                  </td>
                  <td className="border border-ink px-1 py-0.5">{l.label}</td>
                  <td className="border border-ink px-1 py-0.5 text-center font-bold">
                    {WEX_REPORT_LINES.has(l.line) ? 'X' : ''}
                  </td>
                  <td className="border border-ink px-1 py-0.5 text-right">
                    {amount(l.previouslyBilled)}
                  </td>
                  <td className="border border-ink px-1 py-0.5 text-right">
                    {amount(l.billedThisPeriod)}
                  </td>
                  <td className="border border-ink px-1 py-0.5 text-right">
                    {amount(l.cumulative)}
                  </td>
                  <td className="border border-ink px-1 py-0.5 text-right">{amount(l.budget)}</td>
                  <td
                    className={`border border-ink px-1 py-0.5 text-right ${l.remaining < 0 ? 'font-bold text-danger' : ''}`}
                  >
                    {l.budget || l.cumulative ? remaining(l.remaining) : '-'}
                  </td>
                </tr>
                {l.line === 'staff-fringe' && (
                  <tr className="font-bold">
                    <td className="border border-ink px-1 py-0.5 text-center">3a</td>
                    <td className="border border-ink px-1 py-0.5">
                      Total Staff Salary &amp; Fringe (1+2)
                    </td>
                    <td className="border border-ink px-1 py-0.5"></td>
                    <td className="border border-ink px-1 py-0.5 text-right">
                      {amount(sum(staff, 'previouslyBilled'))}
                    </td>
                    <td className="border border-ink px-1 py-0.5 text-right">
                      {amount(sum(staff, 'billedThisPeriod'))}
                    </td>
                    <td className="border border-ink px-1 py-0.5 text-right">
                      {amount(sum(staff, 'cumulative'))}
                    </td>
                    <td className="border border-ink px-1 py-0.5 text-right">
                      {amount(sum(staff, 'budget'))}
                    </td>
                    <td className="border border-ink px-1 py-0.5 text-right">
                      {sum(staff, 'budget') || sum(staff, 'cumulative')
                        ? remaining(sum(staff, 'remaining'))
                        : '-'}
                    </td>
                  </tr>
                )}
              </Fragment>
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
                {remaining(total('remaining'))}
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
        <div className="grid grid-cols-2 gap-x-8 gap-y-1 px-1 py-1">
          <div>
            <b>Prepared By:</b> {r.engagement.preparerOrganization ?? r.engagement.workspace.name}
          </div>
          <div>
            <b>Authorized By:</b>{' '}
            {r.engagement.authorizerOrganization ?? r.engagement.workspace.name}
          </div>
          <div>
            <b>Name:</b> {r.preparedByName ?? r.engagement.preparerName ?? '—'}
          </div>
          <div>
            {/* Named only once the month-end closing is approved, so an unapproved form never looks signed. */}
            <b>Name:</b> {r.authorizedByName ?? '—'}
          </div>
          <div>
            <b>Signature:</b> ____________________
            <br />
            <span className="text-xs text-soft">
              {r.submittedAt ? `Submitted ${shortDate(r.submittedAt)}` : 'Not submitted'}
            </span>
          </div>
          <div>
            <b>Signature:</b> ____________________
            <br />
            <span className="text-xs text-soft">
              {r.authorizedAt ? `Certified ${shortDate(r.authorizedAt)}` : 'Not approved yet'}
            </span>
          </div>
        </div>
        <div className="mt-2 bg-alt px-2 text-center text-xs font-bold">
          SECTION V - Submission Instructions
        </div>
        <p className="px-1 py-1 text-center text-xs">
          This form must be submitted to: {r.engagement.reportTo ?? 'the funder'}.{' '}
          <b>REPORT IS DUE ON THE {ordinal(r.engagement.reportDueDay)} OF EACH MONTH</b>
        </p>
        <div className="bg-alt px-2 text-center text-xs font-bold">
          SECTION VI - {(r.engagement.funder ?? 'FUNDER').toUpperCase()} REVIEW
        </div>
        <div className="grid grid-cols-2 gap-8 px-1 py-1">
          <div>
            <div>Received form via email on ________</div>
            <ul className="mt-1 space-y-0.5">
              {FUNDER_REVIEW.map((label) => (
                <li key={label}>
                  {box(false)} {label}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <b>IV# for payment of this Financial Report:</b> ________
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
