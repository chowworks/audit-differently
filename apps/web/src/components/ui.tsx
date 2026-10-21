import { Fragment, useEffect, useState } from 'react'
import { REPORT_STATUS_LABELS, type CheckSeverity, type ReportStatus } from '@ad/types'

export type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'muted' | 'accent'

/** Outlined, upper-case label in the tone's colour; `fill` for the state that must be seen first. */
export function Chip({
  tone,
  fill,
  children,
  title,
  className = '',
}: {
  tone: Tone
  fill?: boolean
  children: React.ReactNode
  title?: string
  className?: string
}) {
  return (
    <span
      title={title}
      className={`ad-chip ad-chip-${tone} ${fill ? 'ad-chip-fill' : ''} ${className}`}
    >
      {children}
    </span>
  )
}

export const statusTone: Record<ReportStatus, Tone> = {
  draft: 'muted',
  closed: 'info',
  submitted: 'ok',
}

export const severityTone: Record<CheckSeverity, Tone> = {
  blocker: 'danger',
  attention: 'warn',
  info: 'info',
}

export function StatusChip({ status }: { status: ReportStatus }) {
  return <Chip tone={statusTone[status]}>{REPORT_STATUS_LABELS[status] ?? status}</Chip>
}

export function Button({
  kind = 'secondary',
  size,
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  kind?: 'primary' | 'secondary' | 'navy' | 'danger' | 'ghost'
  size?: 'sm'
}) {
  const kinds = {
    primary: 'ad-btn',
    secondary: 'ad-btn-secondary',
    navy: 'ad-btn ad-btn-navy',
    danger: 'ad-btn-secondary ad-btn-danger',
    ghost: 'ad-btn-quiet',
  }
  return (
    <button
      type="button"
      {...props}
      className={`${kinds[kind]} ${size === 'sm' ? 'ad-btn-sm' : ''} ${className}`}
    />
  )
}

export function Field({
  label,
  children,
  hint,
  error,
  required,
  className = '',
}: {
  label: string
  children: React.ReactNode
  hint?: string
  /** What is wrong with this field, in red under it (replaces the hint while it shows). */
  error?: string | null
  /** Marks the label with the usual asterisk. */
  required?: boolean
  className?: string
}) {
  return (
    <label className={`ad-field ${className}`}>
      <span>
        {label}
        {required && (
          <i className="ad-req" aria-label="required">
            *
          </i>
        )}
      </span>
      {children}
      {error ? (
        <small className="ad-field-error" role="alert">
          {error}
        </small>
      ) : (
        hint && <small>{hint}</small>
      )}
    </label>
  )
}

export const inputClass = 'ad-input'

const fmtMoney = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** A dollar amount typed as people write it ("12,500" or "12500.5") and shown with separators and cents. */
export function MoneyInput({
  value,
  onChange,
  className = '',
  ...rest
}: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
  value: number | null
  onChange: (v: number | null) => void
}) {
  const [text, setText] = useState(value == null ? '' : fmtMoney(value))
  const [focused, setFocused] = useState(false)
  useEffect(() => {
    if (!focused) setText(value == null ? '' : fmtMoney(value))
  }, [value, focused])
  const parse = (t: string) => {
    const n = Number(t.replace(/[^0-9.]/g, ''))
    return t.trim() === '' || !Number.isFinite(n) ? null : n
  }
  return (
    <span className="ad-money">
      <span aria-hidden="true">$</span>
      <input
        {...rest}
        inputMode="decimal"
        className={`ad-input ${className}`}
        value={text}
        onFocus={() => setFocused(true)}
        onChange={(e) => {
          setText(e.target.value)
          onChange(parse(e.target.value))
        }}
        onBlur={() => {
          setFocused(false)
          const n = parse(text)
          setText(n == null ? '' : fmtMoney(n))
          onChange(n)
        }}
      />
    </span>
  )
}

export function Card({
  eyebrow,
  title,
  aside,
  children,
  className = '',
}: {
  /** A small line over the title, e.g. "Don't miss a date". */
  eyebrow?: string
  title?: React.ReactNode
  aside?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={`ad-card ${className}`}>
      {(title || aside) && (
        <header className="ad-card-head">
          <div>
            {eyebrow && <p className="ad-eyebrow !mb-1">{eyebrow}</p>}
            <h2 className="ad-card-title">{title}</h2>
          </div>
          {aside && <div className="ad-card-aside">{aside}</div>}
        </header>
      )}
      <div className="ad-card-body">{children}</div>
    </section>
  )
}

/** One of the numbers that matter, Learn Differently style: label, big value, a note. */
export function Tile({
  label,
  value,
  note,
  warn,
  progress,
}: {
  label: string
  value: React.ReactNode
  note?: React.ReactNode
  warn?: boolean
  /** 0 to 100: a bar under the value. */
  progress?: number
}) {
  return (
    <div className={`ad-tile ${warn ? 'ad-tile-warn' : ''}`}>
      <span className="ad-tile-label">{label}</span>
      <span className="ad-tile-value">{value}</span>
      {progress != null && (
        <span className="ad-progress my-1">
          <i style={{ width: `${Math.max(0, Math.min(100, progress))}%` }} />
        </span>
      )}
      {note && <span className="ad-tile-note">{note}</span>}
    </div>
  )
}

export function Modal({
  title,
  onClose,
  children,
  wide,
  full,
  className = '',
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
  wide?: boolean
  /** As wide as the screen allows, for a grid with several columns to fill in. */
  full?: boolean
  /** One dialog's own look (the verification model's navy header). */
  className?: string
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="ad-backdrop" onClick={onClose}>
      <div
        className={`ad-modal ${wide ? 'ad-modal-wide' : ''} ${full ? 'ad-modal-full' : ''} ${className}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="ad-modal-head">
          <h2 className="ad-modal-title">{title}</h2>
          <button type="button" className="ad-modal-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="ad-modal-body">{children}</div>
      </div>
    </div>
  )
}

export function Notice({
  tone = 'info',
  fade = false,
  children,
}: {
  tone?: 'ok' | 'danger' | 'warn' | 'info'
  /** A "that worked" message: it fades after a few seconds. A warning or a standing state stays. */
  fade?: boolean
  children: React.ReactNode
}) {
  const [shown, setShown] = useState(true)
  const text = typeof children === 'string' ? children : null
  useEffect(() => {
    setShown(true)
    if (!fade) return
    const t = setTimeout(() => setShown(false), 4000)
    return () => clearTimeout(t)
  }, [fade, text])
  return (
    <p className={`ad-quiet ad-quiet-${tone} ${shown ? '' : 'ad-quiet-gone'}`} role="status">
      {tone === 'ok' && <span aria-hidden="true">✓ </span>}
      {children}
    </p>
  )
}

/**
 * A short confirmation beside the button that did it ("Renamed", "List saved"): a green check that fades after a
 * few seconds. `at` changes on every save (a timestamp), so saving twice shows it again.
 */
export function SavedMark({ at, children }: { at: number | null; children: React.ReactNode }) {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (!at) return
    setShown(true)
    const t = setTimeout(() => setShown(false), 4000)
    return () => clearTimeout(t)
  }, [at])
  return (
    <span className={`ad-saved${shown ? ' ad-saved-on' : ''}`} role="status" aria-live="polite">
      {shown && (
        <>
          <span className="ad-saved-check" aria-hidden="true">
            ✓
          </span>
          {children}
        </>
      )}
    </span>
  )
}

/**
 * What went wrong, as the one red line at the top of a form, a dialog or a section (CLAUDE.md, "Messages, tips and
 * notes on screen"): never a box. A problem with one field goes beside that field instead (`Field`'s `error`).
 */
export function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <p className="ad-error" role="alert">
      <span aria-hidden="true">⚠️</span>
      <span>{message}</span>
    </p>
  )
}

/**
 * An email address that wraps where it reads well, before the @ and after each dot (a hyphen already allows it), so a
 * narrow table column never breaks it mid-word or widens past its card.
 */
export function EmailText({ value }: { value: string }) {
  return (
    <>
      {value.split(/(?=@)|(?<=\.)/).map((part, i) => (
        <Fragment key={i}>
          {i > 0 && <wbr />}
          {part}
        </Fragment>
      ))}
    </>
  )
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="ad-empty">{children}</p>
}

/**
 * A flow's steps, as the month page's stepper: each done step green with its number and a ✓ before its name, the
 * current one outlined in navy, the rest grey. The last step counts as done once reached.
 */
export function Stepper<S extends string>({ steps, current }: { steps: readonly S[]; current: S }) {
  const at = steps.indexOf(current)
  const last = at === steps.length - 1
  return (
    <ol className="ad-stepper" aria-label="Steps">
      {steps.map((s, i) => {
        const state = i < at || last ? 'done' : i === at ? 'current' : 'todo'
        return (
          <li
            key={s}
            className={`ad-stepper-${state}`}
            aria-current={state === 'current' ? 'step' : undefined}
          >
            <span className="ad-stepper-mark" aria-hidden="true">
              {i + 1}
            </span>
            <span className="ad-stepper-label">
              {state === 'done' && (
                <span className="ad-stepper-check" aria-hidden="true">
                  ✓{' '}
                </span>
              )}
              {s}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

/** The full demo workspace's mark (as Learn Differently's): fictional data that shows every feature. */
export function FullDemoChip() {
  return (
    <span className="ad-demo" title="Full demo: fictional data that shows every feature">
      <span aria-hidden="true">⭐ </span>Full demo
    </span>
  )
}
