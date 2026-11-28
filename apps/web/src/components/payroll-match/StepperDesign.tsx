/*
 * The match wizards as a stepper down the side (owner's decision, 2026-11-15), both the owner's month end and the
 * bookkeeper's payroll proof: each step says what was done and what was found, with an animated "Analyzing and
 * reconciling" step, and every footer is Back, Cancel and Next.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { PayrollMatchFileDto, PayrollMatchProgress } from '@ad/types'
import './StepperDesign.css'

export type RailState = 'done' | 'current' | 'todo' | 'warn' | 'working'
export interface RailStep {
  label: string
  /** The step's result in a few words ("18 of 20 proved"), or what it waits for. */
  note?: string
  state: RailState
  /** The note in amber or red: something still to do there. */
  tone?: 'warn' | 'danger'
}

/** The steps down the side, the step's own screen beside them. */
export function StepRail({ steps, children }: { steps: RailStep[]; children: ReactNode }) {
  // Below 1100px the rail is a strip that scrolls sideways: it keeps the step you're on in view.
  const rail = useRef<HTMLOListElement>(null)
  const at = steps.findIndex((s) => s.state === 'current' || s.state === 'working')
  useEffect(() => {
    const el = rail.current
    const step = el?.children[at] as HTMLElement | undefined
    if (!el || !step || el.scrollWidth <= el.clientWidth) return
    el.scrollLeft = step.offsetLeft - el.offsetLeft - (el.clientWidth - step.offsetWidth) / 2
  }, [at])
  return (
    <div className="sd-layout">
      <ol ref={rail} className="sd-rail" aria-label="Steps">
        {steps.map((s, i) => (
          <li
            key={s.label}
            className={`sd-step sd-${s.state}`}
            aria-current={s.state === 'current' || s.state === 'working' ? 'step' : undefined}
          >
            <span className="sd-mark" aria-hidden="true">
              {s.state === 'done'
                ? '✓'
                : s.state === 'warn'
                  ? '!'
                  : s.state === 'working'
                    ? ''
                    : i + 1}
            </span>
            <span className="sd-words">
              <b>{s.label}</b>
              {s.note && <span className={s.tone ? `sd-note-${s.tone}` : undefined}>{s.note}</span>}
            </span>
          </li>
        ))}
      </ol>
      <div className="sd-main">{children}</div>
    </div>
  )
}

/** A step's heading: "Step N of M", its name and one line on what was done. */
export function StepHead({
  n,
  of,
  title,
  did,
}: {
  n: number
  of: number
  title: string
  did?: ReactNode
}) {
  return (
    <div className="sd-head">
      <span className="sd-count">
        Step {n} of {of}
      </span>
      <h2 className="sd-title">{title}</h2>
      {did && <p className="sd-did">{did}</p>}
    </div>
  )
}

const KIND_WORD: Record<string, string> = {
  timesheet: 'Timesheet',
  'payroll-register': 'Register',
  paystub: 'Pay stub',
  'bank-statement': 'Bank statement',
  'payroll-details': 'Payroll details',
  'allocation-calculation': 'Allocation',
}

export interface AnalyzingStage {
  title: string
  did: string
  /** What it found, shown once the stage has run. */
  result: string
}

const reducedMotion = () =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

/**
 * "Analyzing and reconciling": the files flowing from the zip to matched, each stage with its bar, and the file being
 * read now. Reading is the server's real progress; once every file is read, the matching stages fill one after another
 * with what they found, then Next opens.
 */
export function Analyzing({
  files,
  progress,
  read,
  stages,
  next,
  back,
  instant,
  onFinished,
}: {
  files: PayrollMatchFileDto[]
  progress: PayrollMatchProgress
  /** Every file is read and the match is worked out. */
  read: boolean
  /** The stages after reading, in order. */
  stages: AnalyzingStage[]
  /** Next: shown once every stage has run. */
  next: ReactNode
  /** Back to the upload: shown all along (reading goes on). */
  back?: ReactNode
  /** Seen already (Back from the next step): shown finished at once. */
  instant?: boolean
  /** Every stage has run: the rail's spinner stops. */
  onFinished?: (finished: boolean) => void
}) {
  const [ran, setRan] = useState(() => (read && (instant || reducedMotion()) ? stages.length : 0))
  useEffect(() => {
    if (!read) return
    if (reducedMotion()) return setRan(stages.length)
    if (ran >= stages.length) return
    const t = setTimeout(() => setRan((n) => n + 1), 900)
    return () => clearTimeout(t)
  }, [read, ran, stages.length])
  const { total, read: done, failed } = progress
  const reading = files.find((f) => f.status === 'reading')
  const scans = files.filter((f) => f.status === 'failed' || f.scanned).length
  const finished = read && ran >= stages.length
  useEffect(() => onFinished?.(finished), [finished, onFinished])
  const all: (AnalyzingStage & { state: 'done' | 'run' | 'wait'; share: number })[] = [
    {
      title: 'Read every file',
      did: 'Pulled the text lines out of each PDF and spreadsheet.',
      result: `${done.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} read${scans ? ` · ${scans} to check by eye` : ''}`,
      state: read ? 'done' : 'run',
      share: total ? (done + failed) / total : 0,
    },
    ...stages.map((s, i) => ({
      ...s,
      state: (!read || i > ran ? 'wait' : i < ran ? 'done' : 'run') as 'done' | 'run' | 'wait',
      share: !read || i > ran ? 0 : i < ran ? 1 : 0.6,
    })),
  ]
  const chips = files.slice(0, 6)
  const now = finished
    ? 'Done: everything is matched that can be. Next, check what needs you.'
    : reading
      ? `Now reading ${reading.fileName}`
      : read
        ? `Now: ${all.find((s) => s.state === 'run')?.title ?? 'finishing'}`
        : 'Waiting for the reader to pick up your files…'
  return (
    <div className="sd-analyze">
      <div className={`sd-flow${finished ? ' sd-flow-done' : ''}`} aria-hidden="true">
        <span className="sd-flow-from">Your zip</span>
        <div className="sd-flow-lane">
          {finished ? (
            <span className="sd-flow-all">
              All {files.length.toLocaleString('en-US')} files read and matched
            </span>
          ) : (
            chips.map((f, k) => (
              <span key={f.id} className="sd-chip" style={{ animationDelay: `${k * 1.1}s` }}>
                {KIND_WORD[f.kind] ?? 'File'}
              </span>
            ))
          )}
        </div>
        <span className="sd-flow-to">Matched ✓</span>
      </div>
      <ol className="sd-stages">
        {all.map((s, i) => (
          <li
            key={s.title}
            className={`sd-stage sd-stage-${s.state}`}
            style={{ animationDelay: `${i * 0.12}s` }}
          >
            <span className="sd-stage-mark" aria-hidden="true">
              {s.state === 'done' ? '✓' : ''}
            </span>
            <span className="sd-stage-words">
              <b>{s.title}</b>
              <span>{s.did}</span>
              <span className="sd-bar">
                <span style={{ width: `${Math.round(s.share * 100)}%` }} />
                {s.state === 'run' && <span className="sd-bar-shine" />}
              </span>
            </span>
            <span className="sd-stage-result">
              {s.state === 'done' ? s.result : s.state === 'run' ? 'Working…' : 'Next'}
            </span>
          </li>
        ))}
      </ol>
      <p className="sd-now" role="status">
        <span className={finished ? 'sd-now-dot sd-now-done' : 'sd-now-dot'} aria-hidden="true" />
        {now}
      </p>
      {!finished && (
        <p className="text-sm text-soft">
          You can close this page: it keeps reading, and you pick up here when you come back.
        </p>
      )}
      <div className="ad-actions justify-between">
        {back ?? <span />}
        {finished && next}
      </div>
    </div>
  )
}

/** The owner's month end as a stepper; the bookkeeper's wizard leaves out "Review expenses". */
export const DESIGN_STEPS = [
  'Upload your files',
  'Analyzing and reconciling',
  'Review staff payroll',
  'Review participant pay',
  'Find missing bank lines',
  'Review expenses',
  'Save and finish',
  'Summary',
] as const
export type DesignStep = (typeof DESIGN_STEPS)[number]

/** The rail for a flow at `current`: steps before it done, those after it to do, each with its note if known. */
export function railSteps(
  steps: readonly DesignStep[],
  current: DesignStep,
  notes: Partial<Record<DesignStep, { note?: string; tone?: 'warn' | 'danger' }>> = {},
  working = false
): RailStep[] {
  const at = steps.indexOf(current)
  return steps.map((label, i) => {
    const n = notes[label] ?? {}
    const state: RailState =
      // A step looked at is done (owner's decision, 2026-11-15): what it left stays amber in its note.
      i < at ? 'done' : i === at ? (working ? 'working' : 'current') : 'todo'
    return { label, state, ...n }
  })
}

export interface CaptureRow {
  label: string
  value: ReactNode
  /** Something Save leaves to do, or asks first: amber. */
  warn?: boolean
}

/**
 * "Save and finish" (owner's ask, 2026-11-15: save as you go quietly, celebrate at the end, in its own look, not the
 * summary's): what the month end captured, as a ledger whose lines slide in, then each is stamped saved.
 */
export function SaveCapture({
  period,
  what = 'payroll',
  rows,
  saved,
  footer,
}: {
  period: string
  /** What was captured, after the month: "payroll", "month end". */
  what?: string
  rows: CaptureRow[]
  /** Save went through: the lines are stamped. */
  saved: boolean
  footer: ReactNode
}) {
  return (
    <div className="sd-capture">
      <div className={`sd-ledger${saved ? ' sd-ledger-saved' : ''}`}>
        <div className="sd-ledger-top">
          {!saved && <span className="sd-ledger-eyebrow">Saving</span>}
          <b>
            {period} {what}
          </b>
          {saved && (
            <span className="sd-stamp" aria-hidden="true">
              Saved
            </span>
          )}
        </div>
        <ul className="sd-ledger-rows" role="status">
          {rows.map((r, i) => (
            <li
              key={r.label}
              className={r.warn ? 'sd-ledger-row sd-ledger-warn' : 'sd-ledger-row'}
              style={{ ['--i' as string]: i }}
            >
              <span className="sd-ledger-label">{r.label}</span>
              <span className="sd-ledger-dots" aria-hidden="true" />
              <span className="sd-ledger-value">{r.value}</span>
              <span className="sd-ledger-state">
                {saved ? (r.warn ? '! Left to do' : '✓ Saved') : 'Ready'}
              </span>
            </li>
          ))}
        </ul>
      </div>
      {footer}
    </div>
  )
}

/** How long the stamps take to land before the next step opens. */
export const STAMP_MS = 1900
