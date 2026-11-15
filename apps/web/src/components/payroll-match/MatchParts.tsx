import type { ReactNode } from 'react'
import { MAX_PAY_LINES } from '@ad/types'
import { Button, ErrorNote, Notice } from '@/components/ui'
import '@/components/match-pairs.css'
import { provedWords } from './why'

/**
 * The pieces of the Match step both payroll match screens render (owner's decision, 2026-10-19): the bookkeeper's
 * per-engagement wizard (`PayrollProof.tsx`) and the owner's workspace match (`WorkspacePayrollPage.tsx`). Change one
 * here and both change.
 */

/** "N of M payroll items complete", beside the card's title. */
export function ProvedCount({ proved, total }: { proved: number; total: number }) {
  return <span className="text-xs text-soft">{provedWords(proved, total)}</span>
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

/** A step's footer: Back and Cancel on the left, Next on the right. */
export function MatchFooter({
  error,
  onBack,
  backLabel = 'Back: upload',
  onDiscard,
  saving,
  save,
}: {
  error?: string | null
  onBack: () => void
  backLabel?: string
  /** Only while there is an upload to discard. */
  onDiscard?: () => void
  saving: boolean
  save: { label: string; disabled: boolean; onClick: () => void }
}) {
  // Every footer is Back, Cancel and Next (owner's ask, 2026-11-15).
  return (
    <>
      <ErrorNote message={error ?? null} />
      <div className="ad-actions justify-between">
        <span className="flex items-center gap-3">
          <Button kind="ghost" onClick={onBack}>
            {backLabel}
          </Button>
          {onDiscard && <CancelButton onCancel={onDiscard} disabled={saving} />}
        </span>
        <Button kind="navy" onClick={save.onClick} disabled={save.disabled}>
          {save.label}
        </Button>
      </div>
    </>
  )
}

/** The stepper's Cancel: asks first, then drops the upload; nothing is saved. */
export function CancelButton({ onCancel, disabled }: { onCancel: () => void; disabled?: boolean }) {
  return (
    <Button
      kind="ghost"
      disabled={disabled}
      onClick={() =>
        confirm('Cancel this match? The files you uploaded are dropped and nothing is saved.') &&
        onCancel()
      }
    >
      Cancel
    </Button>
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

/** The two files Set for selected fills in. */
export type BulkFiles = { timesheet: string; register: string }
