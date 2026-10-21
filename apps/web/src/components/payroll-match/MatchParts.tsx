import type { ReactNode } from 'react'
import { MAX_PAY_LINES, type PayrollMatchRunDto } from '@ad/types'
import { shortDate } from '@/lib/format'
import { Button, ErrorNote, Notice } from '@/components/ui'
import '@/components/match-pairs.css'
import { WHY_RESULT, provedWords, type WhyBlock } from './why'

/**
 * The pieces of the Match step both payroll match screens render (owner's decision, 2026-10-19): the bookkeeper's
 * per-engagement wizard (`PayrollProof.tsx`) and the owner's workspace match (`WorkspacePayrollPage.tsx`). Change one
 * here and both change.
 */

/** "N of M payroll items fully proved", beside the card's title. */
export function ProvedCount({ proved, total }: { proved: number; total: number }) {
  return <span className="text-xs text-soft">{provedWords(proved, total)}</span>
}

/** What the match was worked out from (#22): the runs the registers print, payroll details, and the files AI read. */
export function MatchedBy({ run }: { run: PayrollMatchRunDto }) {
  const details = run.files.filter((f) => f.kind === 'payroll-details').length
  const day = (d: string) => shortDate(d).replace(/, \d{4}$/, '')
  const parts = [
    run.runs.length
      ? `the ${run.runs.map((r) => day(r.payDate)).join(' and ')} payroll ${run.runs.length === 1 ? 'run' : 'runs'}`
      : "the files' own pay dates",
    ...(details ? ['payroll details'] : []),
    ...(run.ai.read.length ? [`AI (${run.ai.read.length} files)`] : []),
  ]
  return (
    <p className="text-sm">
      <b>Matched with</b>{' '}
      {parts.length > 1
        ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
        : parts[0]}
      .
    </p>
  )
}

/** Nothing is saved until Save; the upload waits a day. */
export function UnsavedNote({
  removing = 0,
  what = 'upload',
}: {
  removing?: number
  what?: string
}) {
  return (
    <p className="ad-replacing" role="status">
      Nothing is saved until you press Save
      {removing
        ? `, which also removes the ${removing} earlier payroll ${removing === 1 ? 'file' : 'files'}`
        : ''}
      . Close any time: this {what} waits here for a day.
    </p>
  )
}

/** The work still to do, with its red count. */
export function RemainingSection({ count, children }: { count: number; children: ReactNode }) {
  return (
    <section className="mx-work" aria-label="To match">
      <h3 className="mx-work-title">
        Remaining to match: <span className="mx-count">{count}</span>
      </h3>
      {children}
    </section>
  )
}

/** A box that opens: a chevron, its title and one line, and Show/Hide. */
export function MatchPanel({
  label,
  title,
  sub,
  children,
}: {
  label: string
  title: ReactNode
  sub: string
  children: ReactNode
}) {
  return (
    <section className="mx-panel" aria-label={label}>
      <details>
        <summary>
          <span className="mx-chevron" aria-hidden="true">
            ▸
          </span>
          <span className="mx-panel-title">{title}</span>
          <span className="text-sm text-soft">{sub}</span>
          <span className="mx-toggle" aria-hidden="true">
            <span className="mx-toggle-show">Show</span>
            <span className="mx-toggle-hide">Hide</span>
          </span>
        </summary>
        {children}
      </details>
    </section>
  )
}

const WHY_INTRO =
  "Auto-Match opens every file in your zip and looks for each person's name, pay and pay period. Below, for every item, you see which file it picked for each proof and what it found there, or why it found nothing. Show, on the grid, opens that file with those words highlighted."

/** "How Auto-Match decided": one block per item (or person), one row per proof. */
export function WhyPanel({
  blocks,
  intro = WHY_INTRO,
  source,
}: {
  blocks: WhyBlock[]
  intro?: string
  /** What the match was worked out from (`MatchedBy`), under the intro (owner's decision, 2026-10-19). */
  source?: ReactNode
}) {
  return (
    <MatchPanel
      label="How Auto-Match decided"
      title="How Auto-Match decided"
      sub="Why each file was matched, or why nothing was."
    >
      <p className="mx-why-intro">{intro}</p>
      {source}
      <div className="mx-why-list">
        {blocks.map((b) => (
          <div key={b.key} className="mx-why">
            <div className="mx-why-head">
              <b>{b.title}</b>
              {b.sub && <span className="text-soft">{b.sub}</span>}
            </div>
            <table className="mx-why-table">
              <tbody>
                {b.rows.map((row, n) => (
                  <tr key={`${row.label}-${n}`} className={`mx-why-${row.tone}`}>
                    <th scope="row">{row.label}</th>
                    <td className="mx-why-result">{WHY_RESULT[row.tone]}</td>
                    <td className="mx-why-file" title={row.file}>
                      {row.file ?? '—'}
                    </td>
                    <td>{row.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </MatchPanel>
  )
}

/** How sure a found proof is: found (green), a guess to check (amber) or missing (red), as the bookkeeper's grid says. */
export type ProofState = 'ok' | 'guess' | 'missing'

const NOTE_CLASS: Record<ProofState, string> = {
  ok: 'ad-match-note-ok',
  guess: 'ad-match-note-guess',
  missing: 'ad-match-note-missing',
}
const NOTE_WORDS: Record<ProofState, string> = {
  ok: '✓ Found',
  guess: '⚠️ Best guess: check it',
  missing: '✕ Missing',
}

/** "✓ Found, page 2", or "✓ ✨ Found by AI, page 2" when AI read it from the file. */
export const foundWords = (page?: number | null, ai?: boolean) =>
  `✓ ${ai ? '✨ Found by AI' : 'Found'}${page ? `, page ${page}` : ''}`

/** The line under a proof on both grids: how sure it is, in its colour, and Show when there is a line to highlight. */
export function ProofFoot({
  state,
  text,
  onShow,
  children,
}: {
  state: ProofState
  /** The words, when not the plain ones ("✓ Chosen", "✓ ⚡ Found, page 1"). */
  text?: string
  onShow?: () => void
  /** Another small action beside Show (Confirm a guess). */
  children?: ReactNode
}) {
  return (
    <span className="ad-match-foot">
      <small className={NOTE_CLASS[state]}>{text ?? NOTE_WORDS[state]}</small>
      {children}
      {onShow && (
        <button type="button" className="ad-match-show" onClick={onShow}>
          Show
        </button>
      )}
    </span>
  )
}

/** A proof found in the files, read-only: its file's name (in full on hover), then `ProofFoot`. */
export function FoundProof({
  fileName,
  state,
  text,
  onShow,
}: {
  fileName?: string
  state: ProofState
  text?: string
  onShow?: () => void
}) {
  return (
    <>
      {fileName && (
        <span className="mx-proof-file" title={fileName}>
          {fileName}
        </span>
      )}
      <ProofFoot state={state} text={text} onShow={onShow} />
    </>
  )
}

/** Beside a section's heading, as a plain line: a green "✓ N auto-matched", then in red what the owner must act on. */
export function Tally({
  matched,
  off = 0,
  toReview,
}: {
  matched: number
  /** On no engagement (owner's wording, 2026-10-19): "12 not on an engagement". */
  off?: number
  toReview: number
}) {
  const n = (x: number) => x.toLocaleString('en-US')
  return (
    <span className="mx-tally">
      <span className="mx-tally-ok">✓ {n(matched)} auto-matched</span>
      {off > 0 && <span className="mx-tally-warn">{n(off)} not on an engagement</span>}
      {toReview > 0 && <span className="mx-tally-danger">{n(toReview)} to review</span>}
    </span>
  )
}

/** The Match step's footer: Back: upload and Discard (a red text link) on the left, the green Save on the right. */
export function MatchFooter({
  error,
  onBack,
  backLabel = 'Back: upload',
  onDiscard,
  discardLabel = 'Discard this upload',
  saving,
  save,
}: {
  error?: string | null
  onBack: () => void
  backLabel?: string
  /** Only while there is an upload to discard. */
  onDiscard?: () => void
  discardLabel?: string
  saving: boolean
  save: { label: string; disabled: boolean; onClick: () => void }
}) {
  return (
    <>
      <ErrorNote message={error ?? null} />
      <div className="ad-actions justify-between">
        <span className="flex items-center gap-3">
          <Button kind="ghost" onClick={onBack}>
            {backLabel}
          </Button>
          {onDiscard && (
            <button type="button" className="mx-discard" onClick={onDiscard} disabled={saving}>
              {discardLabel}
            </button>
          )}
        </span>
        <Button kind="primary" onClick={save.onClick} disabled={save.disabled}>
          {save.label}
        </Button>
      </div>
    </>
  )
}

/**
 * A file with more payroll lines than are read (MAX_PAY_LINES): a standing warning on both match screens and in the
 * reconciliation, one line per file, so a long file is never cut short in silence (owner's decision, 2026-10-19).
 */
export function LineCapNotes({ files }: { files: { fileName: string }[] }) {
  if (!files.length) return null
  const max = MAX_PAY_LINES.toLocaleString('en-US')
  return (
    <>
      {files.map((f) => (
        <Notice key={f.fileName} tone="warn">
          ⚠️ {f.fileName} has over {max} payroll lines: only the first {max} were read. Split it
          into smaller files and upload them.
        </Notice>
      ))}
    </>
  )
}

/** The fix for a row the person must look at: a small link that opens its dialog, not a button. */
export function Resolve({ onClick, label = 'Resolve' }: { onClick: () => void; label?: string }) {
  return (
    <button type="button" className="mx-resolve" onClick={onClick}>
      🛠️ {label}
    </button>
  )
}
