import { useEffect, useId, useRef, useState } from 'react'

export interface MultiOption {
  value: string
  label: string
}

/** The options whose label holds every word of the query, in their order; all of them for an empty query. */
export function matching(options: MultiOption[], query: string): MultiOption[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return options.filter((o) => words.every((w) => o.label.toLowerCase().includes(w)))
}

/** The chosen values with `v` added or taken off, kept in the options' order (anything else chosen stays, last). */
export function toggled(options: MultiOption[], chosen: string[], v: string): string[] {
  const next = chosen.includes(v) ? chosen.filter((x) => x !== v) : [...chosen, v]
  const order = options.map((o) => o.value)
  return [...order.filter((x) => next.includes(x)), ...next.filter((x) => !order.includes(x))]
}

/** The highlighted row after an arrow key: down from nothing is the first, and it wraps at both ends. */
export function moved(active: number, delta: 1 | -1, count: number): number {
  if (count === 0) return -1
  if (active < 0) return delta === 1 ? 0 : count - 1
  return (active + delta + count) % count
}

/**
 * Choose any number of values from a list: a button showing the chosen ones as chips that opens a searchable list of
 * checkable options. Arrow keys move, Enter (or Space with an empty search) ticks, Escape closes; a click outside
 * closes it too.
 */
export function MultiSelect({
  label,
  options,
  value,
  onChange,
  placeholder = 'Choose',
  disabled,
}: {
  /** What is being chosen, for screen readers ("Funding source"). */
  label: string
  options: MultiOption[]
  value: string[]
  onChange: (value: string[]) => void
  placeholder?: string
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(-1)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const id = useId()
  const shown = matching(options, query)
  const words = (v: string) => options.find((o) => o.value === v)?.label ?? v

  useEffect(() => {
    if (!open) return
    search.current?.focus()
    const outside = (e: MouseEvent | TouchEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', outside)
    document.addEventListener('touchstart', outside)
    return () => {
      document.removeEventListener('mousedown', outside)
      document.removeEventListener('touchstart', outside)
    }
  }, [open])

  const show = () => {
    setQuery('')
    setActive(-1)
    setOpen(true)
  }
  const close = (refocus: boolean) => {
    setOpen(false)
    if (refocus) trigger.current?.focus()
  }
  const tick = (v: string) => onChange(toggled(options, value, v))

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setActive(moved(active, e.key === 'ArrowDown' ? 1 : -1, shown.length))
    } else if (e.key === 'Enter' || (e.key === ' ' && query === '')) {
      e.preventDefault()
      const o = shown[active] ?? (shown.length === 1 ? shown[0] : undefined)
      if (o) tick(o.value)
    } else if (e.key === 'Escape') {
      // Only this list closes, not a modal it sits in.
      e.preventDefault()
      e.stopPropagation()
      close(true)
    } else if (e.key === 'Tab') setOpen(false)
  }

  return (
    <div className="ad-ms" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="ad-input ad-ms-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${value.length ? value.map(words).join(', ') : 'none chosen'}`}
        disabled={disabled}
        onClick={() => (open ? close(false) : show())}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault()
            show()
          }
        }}
      >
        <span className="ad-ms-chips">
          {value.length === 0 && <span className="text-soft">{placeholder}</span>}
          {value.map((v) => (
            <span key={v} className="ad-ms-chip">
              {words(v)}
            </span>
          ))}
        </span>
        <span aria-hidden="true" className="ad-ms-caret">
          ▾
        </span>
      </button>
      {open && (
        <div className="ad-ms-pop">
          <input
            ref={search}
            type="search"
            className="ad-input ad-input-sm ad-ms-search"
            placeholder="Search"
            aria-label={`Search ${label}`}
            aria-controls={`${id}-list`}
            aria-activedescendant={active >= 0 ? `${id}-${active}` : undefined}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActive(-1)
            }}
            onKeyDown={onKey}
          />
          <ul id={`${id}-list`} role="listbox" aria-multiselectable="true" aria-label={label}>
            {shown.map((o, n) => (
              <li
                key={o.value}
                id={`${id}-${n}`}
                role="option"
                aria-selected={value.includes(o.value)}
                className={n === active ? 'ad-ms-active' : undefined}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(n)}
                onClick={() => tick(o.value)}
              >
                <span className="ad-ms-box" aria-hidden="true">
                  {value.includes(o.value) ? '✓' : ''}
                </span>
                {o.label}
              </li>
            ))}
            {shown.length === 0 && <li className="ad-ms-none">Nothing matches.</li>}
          </ul>
        </div>
      )}
    </div>
  )
}
