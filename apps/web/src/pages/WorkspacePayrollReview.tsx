import { Link } from 'react-router-dom'
import {
  DROPPED_DECISION_WHY_LABELS,
  PAY_LINE_FLAG_LABELS,
  PAYROLL_BUDGET_KIND_LABELS,
  PAYROLL_RUN_UNKNOWN,
  REPORT_STATUS_LABELS,
  type DroppedDecisionDto,
  type PayrollMatchSaveInput,
  type PayrollSlot,
  type PlanProofDto,
  type ProofSpotDto,
  type StaffFoundDto,
  type StubPayDto,
  type WorkspacePayrollMonthDto,
  type WorkspacePayrollRunDto,
} from '@ad/types'
import { money, shortDate } from '@/lib/format'
import { Chip, Empty } from '@/components/ui'
import { FoundProof, Resolve, Tally, foundWords } from '@/components/payroll-match/MatchParts'
import { SLOT_LABEL } from '@/components/payroll-match/why'
import { VerificationModelLink } from '@/components/payroll-match/VerificationModel'
import {
  filesWords,
  kindWord,
  participantRows,
  participantTally,
  paymentNote,
  paymentsWords,
  runLabel,
  proofWords,
  staffRows,
  staffTally,
  staffWords,
  stubMatched,
} from '@/pages/workspace-payroll-plan'

/**
 * Step 2 of the workspace payroll page, by people (GitHub issue #22; owner's decisions, 2026-10-19): the staff and
 * participants found, and what Save will do. The words are worked out in `workspace-payroll-plan.ts`; what lands on
 * nobody is the last block of "How Auto-Match decided". Each proof found reads as on the bookkeeper's grid: its file,
 * "✓ Found, page N" (or a guess, or missing) and Show, which opens the file with the line found highlighted.
 */

/** Opens a file of the run with one line highlighted. */
export type ShowSpot = (spot: ProofSpotDto, title: string, slot: PayrollSlot) => void

type Run = WorkspacePayrollRunDto

/** One proof cell: the first place it was found, or a guess, or missing. */
function SpotCell({
  run,
  spots,
  guesses = [],
  title,
  slot,
  onShow,
}: {
  run: Run
  spots: ProofSpotDto[]
  guesses?: ProofSpotDto[]
  title: string
  slot: PayrollSlot
  onShow: ShowSpot
}) {
  const shown = spots.length ? spots : guesses
  if (!shown.length) return <FoundProof state="missing" />
  // One line per run that paid them: "Sep 11 run", then the file, how sure, and Show.
  return (
    <span className="mx-runs">
      {shown.map((spot, n) => {
        const file = run.files.find((f) => f.id === spot.fileId)
        const fileName = file?.fileName
        // Payroll details is a spreadsheet: its yellow rows are on the saved copy, not in the viewer.
        const sheet = file?.kind === 'payroll-details'
        // A run whose pay date and period can't be read says so (owner's decision, 2026-10-19).
        const label = spot.payDate ? runLabel(spot.payDate) : PAYROLL_RUN_UNKNOWN
        return (
          <span key={`${spot.fileId}-${n}`} className="mx-run">
            {label && <span className="mx-run-label">{label}:</span>}
            <FoundProof
              fileName={fileName}
              state={spots.length ? 'ok' : 'guess'}
              text={
                spots.length
                  ? sheet
                    ? `✓ ${spot.source === 'ai' ? '✨ ' : ''}Payroll details${spot.amount != null ? `: ${money(spot.amount)}` : ''}`
                    : slot === 'register' && spot.run
                      ? `✓ Run total${spot.mark ? `, page ${spot.mark.page}` : ''}`
                      : foundWords(spot.mark?.page, spot.source === 'ai')
                  : undefined
              }
              onShow={
                spot.mark && !sheet
                  ? () =>
                      onShow(
                        spot,
                        `${title}: ${SLOT_LABEL[slot].toLowerCase()}${label ? ` (${label})` : ''}`,
                        slot
                      )
                  : undefined
              }
            />
          </span>
        )
      })}
    </span>
  )
}

/** Their pay found: per run when more than one paid them, then the month's total. */
/**
 * A staff member's pay, run by run, and whether the grant pays it (owner's decision, 2026-10-19), as the participants'
 * Payment shows: what payroll details charges to the grant. With payroll details in the zip, a person or run it charges
 * nothing for is not grant-funded; without it, nothing is said. How much of a person's pay is not the grant's is printed
 * nowhere reliable (payroll details lists the grant's job alone), so no amount is claimed.
 */
function PaymentCell({ run, s }: { run: Run; s: StaffFoundDto }) {
  const hasDetails = run.files.some((f) => f.kind === 'payroll-details')
  const ai = s.found.register.some((x) => x.source === 'ai') ? '✨ ' : ''
  const notFunded = hasDetails && <span className="block text-xs text-soft">Not grant-funded</span>
  const rows = run.runs
    .map((r) => ({
      r,
      charged: s.charged.find((c) => c.start === r.start && c.end === r.end)?.amount ?? null,
      pay: s.payByRun.find((p) => p.payDate === r.payDate)?.amount ?? null,
    }))
    .filter((x) => x.charged !== null || x.pay !== null)
  if (!rows.length)
    return (
      <span className="mx-run">
        <span className="font-semibold">{s.pay === null ? '—' : ai + money(s.pay)}</span>
        {notFunded}
      </span>
    )
  return (
    <span className="mx-runs">
      {rows.map(({ r, charged, pay }) => (
        <span key={r.payDate} className="mx-run">
          {rows.length > 1 && <span className="mx-run-label">{runLabel(r.payDate)}:</span>}
          <span className="font-semibold">
            {ai}
            {money(charged ?? pay!)}
          </span>
          {charged !== null ? (
            <span className="block text-xs text-soft">Charged to the grant</span>
          ) : (
            notFunded
          )}
        </span>
      ))}
    </span>
  )
}

/** One row per person on the staff list found in the files or tagged to an engagement, then the people on no list. */
export function StaffFound({
  run,
  workspaceId,
  onShow,
  onAdd,
}: {
  run: Run
  workspaceId: string
  onShow: ShowSpot
  /** Adds someone on no list to the staff list, from here (owners). */
  onAdd?: (name: string) => void
}) {
  const rows = staffRows(run)
  const unlisted = run.plan.unlisted
  const tally = staffTally(run)
  return (
    <section className="mx-work" aria-label="Staff">
      <h3 className="mx-work-title">
        Staff <Tally {...tally} />
        <VerificationModelLink who="staff" />
      </h3>
      {rows.length + unlisted.length === 0 ? (
        <Empty>Nobody on your staff list is tagged to an engagement or found in the files.</Empty>
      ) : (
        <div className="ad-tablewrap">
          <table className="ad-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Engagements</th>
                <th>Timesheet</th>
                <th>Payroll register</th>
                <th>Bank line</th>
                <th className="ad-num">Payment</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s: StaffFoundDto) => (
                <tr key={s.staffId}>
                  <td className="font-semibold">{s.name}</td>
                  <td>
                    {s.engagements.length ? (
                      <span className="flex flex-wrap gap-1">
                        {s.engagements.map((e) => (
                          <Chip key={e.id} tone="info">
                            {e.name}
                          </Chip>
                        ))}
                      </span>
                    ) : (
                      <span className="text-sm">
                        None · Fix:{' '}
                        <Link to={`/workspaces/${workspaceId}/staff`}>Tag Engagements</Link>
                      </span>
                    )}
                  </td>
                  {(['timesheet', 'register', 'bank'] as const).map((slot) => (
                    <td key={slot} className="ad-matchcell">
                      <SpotCell
                        run={run}
                        spots={s.found[slot]}
                        guesses={slot === 'bank' ? s.found.bankGuess : []}
                        title={s.name}
                        slot={slot}
                        onShow={onShow}
                      />
                    </td>
                  ))}
                  <td className="ad-num font-semibold">
                    <PaymentCell run={run} s={s} />
                  </td>
                </tr>
              ))}
              {unlisted.map((u) => (
                <tr key={`unlisted-${u.name}`}>
                  <td className="font-semibold">{u.name}</td>
                  <td>
                    <span className="mx-tally-danger text-sm">Not attached to any engagement</span>
                    {onAdd && <Resolve onClick={() => onAdd(u.name)} />}
                  </td>
                  <td className="ad-matchcell">
                    <SpotCell
                      run={run}
                      spots={u.timesheet}
                      title={u.name}
                      slot="timesheet"
                      onShow={onShow}
                    />
                  </td>
                  <td className="ad-matchcell">
                    <SpotCell
                      run={run}
                      spots={u.register}
                      title={u.name}
                      slot="register"
                      onShow={onShow}
                    />
                  </td>
                  <td className="text-sm text-soft">On no engagement</td>
                  <td className="ad-num">—</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

/** One row per participant, as the staff: each payroll run that paid them a line of its own, then what Save does. */
export function ParticipantsFound({
  run,
  onShow,
  onAdd,
}: {
  run: Run
  onShow: ShowSpot
  /** Adds the person a pay stub names to an engagement's participants, from here (owners). */
  onAdd?: (stub: StubPayDto) => void
}) {
  const rows = participantRows(run)
  const tally = participantTally(run)
  return (
    <section className="mx-work" aria-label="Participants">
      <h3 className="mx-work-title">
        Participants <Tally {...tally} />
        <VerificationModelLink who="participants" />
      </h3>
      {rows.length === 0 ? (
        <Empty>No pay stub in the files.</Empty>
      ) : (
        <div className="ad-tablewrap">
          <table className="ad-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Engagement</th>
                <th>Timesheet</th>
                <th>Payroll register</th>
                <th>Pay stub</th>
                <th>Bank line</th>
                <th className="ad-num">Payment</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ key, stubs }) => {
                const first = stubs[0]!
                const who = first.participant?.name ?? first.named ?? 'Nobody found'
                const label = (x: StubPayDto) =>
                  x.payDate ? runLabel(x.payDate) : PAYROLL_RUN_UNKNOWN
                const warnings = [
                  ...new Set(
                    stubs.flatMap((x) =>
                      stubMatched(run, x)
                        ? []
                        : [
                            ...x.flags
                              .filter((f) => !(f === 'no-participant' && !x.participant))
                              .map((f) => PAY_LINE_FLAG_LABELS[f]),
                            ...run.plan.twoProofs
                              .filter((t) => t.target === 'wex' && t.id === x.wexPaymentId)
                              .map((t) => t.message),
                          ]
                    )
                  ),
                ]
                return (
                  <tr key={key}>
                    <td>
                      <span className="font-semibold">{who}</span>
                      {first.participant && (
                        <span className="ad-table-sub">{first.participant.participantId}</span>
                      )}
                    </td>
                    <td>
                      {first.participant ? (
                        first.participant.engagementName
                      ) : first.flags.includes('no-participant') ? (
                        <>
                          <span className="mx-tally-danger text-sm">
                            {PAY_LINE_FLAG_LABELS['no-participant']}
                          </span>
                          {onAdd && <Resolve onClick={() => onAdd(first)} />}
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    {(['timesheet', 'register'] as const).map((slot) => (
                      <td key={slot} className="ad-matchcell">
                        {first.participant ? (
                          <SpotCell
                            run={run}
                            spots={stubs.flatMap((x) =>
                              x[slot] ? [{ ...x[slot]!, payDate: x.payDate }] : []
                            )}
                            title={who}
                            slot={slot}
                            onShow={onShow}
                          />
                        ) : (
                          <span className="text-sm text-soft">—</span>
                        )}
                      </td>
                    ))}
                    <td className="ad-matchcell">
                      <SpotCell
                        run={run}
                        spots={stubs.map((x) => ({
                          fileId: x.fileId,
                          mark: x.payLine,
                          payDate: x.payDate,
                          source: x.source === 'rules' ? undefined : x.source,
                        }))}
                        title={who}
                        slot="stub"
                        onShow={onShow}
                      />
                    </td>
                    <td className="ad-matchcell">
                      {first.participant ? (
                        <SpotCell
                          run={run}
                          spots={stubs.flatMap((x) =>
                            x.bank ? [{ ...x.bank, payDate: x.payDate }] : []
                          )}
                          title={who}
                          slot="bank"
                          onShow={onShow}
                        />
                      ) : (
                        <span className="text-sm text-soft">—</span>
                      )}
                    </td>
                    <td className="ad-num">
                      <span className="mx-runs">
                        {stubs.map((x) => (
                          <span key={x.fileId} className="mx-run">
                            {stubs.length > 1 && label(x) && (
                              <span className="mx-run-label">{label(x)}:</span>
                            )}
                            <span className="font-semibold">
                              {x.source === 'ai' ? '✨ ' : ''}
                              {x.grossAmount !== null ? money(x.grossAmount) : '—'}
                            </span>
                            <span className="block text-xs text-soft">{paymentNote(x)}</span>
                          </span>
                        ))}
                      </span>
                      {warnings.length > 0 && (
                        <span className="mt-1 flex flex-wrap gap-1">
                          {warnings.map((w) => (
                            <Chip key={w} tone="warn">
                              ⚠️ {w}
                            </Chip>
                          ))}
                        </span>
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
