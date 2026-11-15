import { useState, type ReactNode } from 'react'
import type { PayrollReconciliationDto, WorkspacePayrollItemDto } from '@ad/types'
import { HandCard } from '@/components/HandCard'
import { FindLineModal } from '@/components/PayrollProof'
import { Button, Chip, Empty } from '@/components/ui'
import { money } from '@/lib/format'

const keyOf = (i: { target: string; id: string }) => `${i.target}-${i.id}`

/** The staff lines Save left with no bank line: the bank line is a staff line's evidence of payment. */
export const unmatchedPayments = (recon: PayrollReconciliationDto | null) =>
  (recon?.items ?? [])
    .filter((x) => x.needed.includes('bank') && !x.item.proved.includes('bank'))
    .map((x) => x.item)

/**
 * The owner's Unmatched payments step, after Payroll matching (owner's decision, 2026-11-14: as the bookkeeper's): each
 * staff line Save left with no bank line, with Find the bank line to pick it or draw a box around it on the statement.
 * The list is kept as it was on arrival, so a line found here stays in view with its ✓.
 */
export function WorkspaceUnmatchedPayments({
  recon,
  stepper,
  onFound,
  onBack,
  backLabel = 'Back: match',
  nextLabel = 'Next',
  onNext,
}: {
  recon: PayrollReconciliationDto | null
  stepper: ReactNode
  /** A line was marked: the page reads the reconciliation again. */
  onFound: (text: string) => void
  onBack: () => void
  backLabel?: string
  nextLabel?: string
  onNext: () => void
}) {
  const now = unmatchedPayments(recon)
  // Kept as it was when the reconciliation first arrived.
  const [kept, setKept] = useState<WorkspacePayrollItemDto[] | null>(recon ? now : null)
  if (recon && !kept) setKept(now)
  const shown = kept ?? []
  const [found, setFound] = useState<Set<string>>(new Set())
  const [finding, setFinding] = useState<WorkspacePayrollItemDto | null>(null)
  const open = new Set(now.map(keyOf))
  const done = (i: WorkspacePayrollItemDto) => found.has(keyOf(i)) || !open.has(keyOf(i))
  const left = shown.filter((i) => !done(i)).length
  return (
    <div className="grid gap-4">
      {stepper}
      {!recon && <Empty>Loading…</Empty>}
      <section className="mx-work" aria-label="Unmatched payments" hidden={!recon}>
        <h3 className="mx-work-title">
          {left > 0 ? (
            <>
              Remaining unmatched payments: <span className="mx-count">{left}</span>
            </>
          ) : shown.length ? (
            'Every payment here now has its bank line'
          ) : (
            'Every staff payment has its bank line'
          )}
        </h3>
        {left > 0 && (
          <HandCard
            title="Prove these payments by hand"
            icon="🔎"
            lead="We couldn't find these payees' amounts among the bank statement's transactions."
          >
            <ol className="ad-hand-steps">
              <li>Press Find the bank line beside a payment.</li>
              <li>
                Pick its transaction from the lines we found, or draw a box around it on the
                statement. That box is what the auditor sees highlighted as its evidence of payment.
              </li>
            </ol>
            <p>You can leave any of them for later: press Next.</p>
          </HandCard>
        )}
        <ul className="mx-list">
          {shown.map((i) => (
            <li key={keyOf(i)} className="mx-row">
              <span>
                <b>{i.title}</b> · {money(i.amount)}
                <span className="ad-table-sub">
                  {i.engagementName} · {i.sub}
                </span>
              </span>
              {done(i) ? (
                <Chip tone="ok" fill>
                  ✓ line marked
                </Chip>
              ) : (
                <Button size="sm" kind="navy" onClick={() => setFinding(i)}>
                  Find the bank line
                </Button>
              )}
            </li>
          ))}
        </ul>
      </section>
      <div className="ad-actions justify-between">
        <Button kind="ghost" onClick={onBack}>
          {backLabel}
        </Button>
        <Button kind="navy" onClick={onNext}>
          {nextLabel}
        </Button>
      </div>
      {finding && (
        <FindLineModal
          item={finding}
          onClose={() => setFinding(null)}
          onLinked={() => {
            setFound((s) => new Set(s).add(keyOf(finding)))
            setFinding(null)
            onFound(`Marked the bank statement line for ${finding.title}.`)
          }}
        />
      )}
    </div>
  )
}
