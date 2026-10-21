import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Modal } from '@/components/ui'
import './verification-model.css'

/**
 * "Mental model for verification" (#22; owner's decisions, 2026-10-19): what the funder's auditor checks for each person
 * the payroll pays, one row per question, the document that answers it, what that document must show, and how it must
 * match the next; under each, a plain example. One for participants, one for staff, opened from the right of their
 * section's heading. The example is fictional, never a real person's pay.
 */
interface Row {
  asks: string
  /** As the match window's column names it: Timesheet, Payroll register, Pay stub, Bank line. */
  evidence: string
  /** Which file it comes from, when the column's name alone doesn't say. */
  detail?: string
  shows: string[]
  match: string
  example: string
}

const PARTICIPANT_ROWS: Row[] = [
  {
    asks: 'Did they work the hours?',
    evidence: 'Timesheet',
    shows: ['Their name', 'Hours for the pay period'],
    match: 'Same name and period as the pay stub',
    example: "Casey Demo's timesheet shows 20 hours worked Aug 24 – Sep 6.",
  },
  {
    asks: 'What was the grant charged?',
    evidence: 'Payroll register',
    detail: 'From payroll details',
    shows: ["Their row for the program's job", 'The amount charged'],
    match: 'Same amount as the pay stub',
    example: 'Payroll details charges $140.00 to the Youth Coding Program for Casey Demo.',
  },
  {
    asks: 'Were they paid that?',
    evidence: 'Pay stub',
    shows: ['Gross pay', 'Pay period and pay date'],
    match: 'Paid in the Sep 11 payroll run',
    example: "Casey Demo's pay stub shows $140.00 gross, paid Sep 11.",
  },
  {
    asks: 'Did the money leave the bank?',
    evidence: 'Bank line',
    detail: 'From the bank statement',
    shows: ["The run's one payroll debit", 'Dated with the run'],
    match: 'Same total as the payroll register',
    example:
      "The bank paid $4,200.00 on Sep 10 for everyone in the Sep 11 run, Casey Demo's $140.00 included.",
  },
]

const STAFF_ROWS: Row[] = [
  {
    asks: 'Did they work on the grant?',
    evidence: 'Timesheet',
    detail: 'From the time report',
    shows: ["Hours on the program's job", 'The pay period'],
    match: 'Same job and period as payroll details',
    example: "Morgan Lee's time report shows 32 hours on the Youth Coding Program, Aug 24 – Sep 6.",
  },
  {
    asks: 'What was the grant charged?',
    evidence: 'Payroll register',
    detail: 'From payroll details',
    shows: ['Their salary rows for the job', 'The amount charged'],
    match: 'Part of the Sep 11 payroll run',
    example: "Payroll details charges $612.50 of Morgan Lee's salary to the program.",
  },
  {
    asks: 'Was the run paid as recorded?',
    evidence: 'Payroll register',
    detail: "The run's total",
    shows: ["The run's total direct deposits", 'The pay date'],
    match: 'Same total as the bank debit',
    example: "The Sep 11 register's direct deposits total $4,200.00.",
  },
  {
    asks: 'Did the money leave the bank?',
    evidence: 'Bank line',
    detail: 'From the bank statement',
    shows: ["The run's one payroll debit", 'Dated with the run'],
    match: 'Same $4,200.00',
    example: "The bank paid $4,200.00 on Sep 10, which covers Morgan Lee's pay.",
  },
]

const WHO = {
  participants: { rows: PARTICIPANT_ROWS, title: 'Participants', per: 'each participant payment' },
  staff: { rows: STAFF_ROWS, title: 'Staff', per: 'each staff member charged to the grant' },
}

/** The link at the right of a section's heading, and its popup. */
export function VerificationModelLink({ who }: { who: keyof typeof WHO }) {
  const [open, setOpen] = useState(false)
  const { rows, title, per } = WHO[who]
  return (
    <>
      <button
        type="button"
        className="ad-btn ad-btn-navy vm-link"
        onClick={() => setOpen(true)}
        title="Our Mental Model for Verification"
      >
        <span className="vm-link-mark" aria-hidden="true">
          ?
        </span>
        What will the auditor check?
      </button>
      {open &&
        // Rendered at the page, not inside the section's heading it opens from.
        createPortal(
          <Modal
            title={`Our Mental Model for Verification: ${title}`}
            onClose={() => setOpen(false)}
            wide
            className="vm-modal"
          >
            <div className="vm-intro">
              What the auditor checks for {per}, described here so you can understand what the app
              is looking for in its proofs. The examples are made up.
            </div>
            <TableOption rows={rows} />
            <p className="vm-close">
              <b>Auto-Match ticks a check only when the file itself shows it.</b> On the match
              screen, anything not ticked is what you, or the auditor, still need: add the missing
              file, or fix what doesn&apos;t match.
            </p>
          </Modal>,
          document.body
        )}
    </>
  )
}

/** The green number of a row: its place in the chain the auditor follows. */
const StepNumber = ({ n }: { n: number }) => (
  <span className="vm-num" aria-hidden="true">
    {n}
  </span>
)

/** What a row's evidence must show: the checks, then what must match the next document. */
const Shows = ({ r }: { r: Row }) => (
  <>
    <ul className="vm-shows">
      {r.shows.map((x) => (
        <li key={x}>
          <span aria-hidden="true">✓</span> {x}
        </li>
      ))}
    </ul>
    <span className="vm-match">🔗 {r.match}</span>
  </>
)

/** The table: each question numbered, its evidence, what it must show, and an example under it (owner's pick). */
function TableOption({ rows }: { rows: Row[] }) {
  return (
    <div className="vm-table-wrap">
      <table className="vm-table">
        <colgroup>
          <col className="vm-col-asks" />
          <col className="vm-col-evidence" />
          <col />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">The auditor asks</th>
            <th scope="col">Document evidence</th>
            <th scope="col">Evidence must show</th>
          </tr>
        </thead>
        {rows.map((r, i) => (
          <tbody key={r.asks}>
            <tr>
              <th scope="row" className="vm-asks">
                <StepNumber n={i + 1} />
                {r.asks}
              </th>
              <td>
                <span className="vm-evidence">{r.evidence}</span>
                {r.detail && <span className="vm-detail">{r.detail}</span>}
              </td>
              <td>
                <Shows r={r} />
              </td>
            </tr>
            <tr className="vm-example">
              <td colSpan={3}>
                <span className="vm-example-label">For example</span> {r.example}
              </td>
            </tr>
          </tbody>
        ))}
      </table>
    </div>
  )
}
