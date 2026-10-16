/*
 * The month page grids' search with type-ahead filters ("tag:", "budget line:" or "line:", "missing:").
 */
import { useId, useState } from 'react'

export type FilterField = 'tag' | 'line' | 'missing'

/** A chosen filter, shown as a removable chip: tag:age:under-18, "Age: Under 18". */
export interface FilterToken {
  field: FilterField
  value: string
  label: string
}

/** What one field offers as you type its name. */
export interface FieldChoices {
  field: FilterField
  /** What the field filters by, in a few words, e.g. "a tag". */
  hint: string
  options: { value: string; label: string }[]
}

/** How each field reads on screen: "line" is the expense's budget line. */
export const FIELD_WORDS: Record<FilterField, string> = {
  tag: 'tag',
  line: 'budget line',
  missing: 'missing',
}

/** The field a typed name means: its own name ("line") or its screen words ("budget line"). */
const fieldFor = (typed: string, fields: FieldChoices[]) => {
  const t = typed.trim().toLowerCase().replace(/\s+/g, ' ')
  return fields.find((f) => f.field === t || FIELD_WORDS[f.field] === t)
}

/** A field name typed so far, "tag:" and what follows; null when the text is a plain search. */
export function draftOf(text: string, fields: FieldChoices[]) {
  const m = /^([a-z]+(?: +[a-z]+)?):(.*)$/i.exec(text.trimStart())
  const field = m && fieldFor(m[1]!, fields)
  return field ? { field, rest: m[2]!.trim().toLowerCase() } : null
}

/** The plain search words, or '' while a field is being typed. */
export const searchOf = (text: string, fields: FieldChoices[]) =>
  draftOf(text, fields) ? '' : text.trim()

interface Suggestion {
  key: string
  label: string
  note?: string
  pick: () => void
}

/**
 * One input: plain text searches the rows; typing a field name ("tag:") suggests its values, and the one picked
 * becomes a chip. Arrow keys move, Enter picks, Backspace on an empty input takes the last chip off.
 */
export function FilterBar({
  fields,
  tokens,
  onTokens,
  text,
  onText,
  placeholder,
  pinned,
}: {
  fields: FieldChoices[]
  tokens: FilterToken[]
  onTokens: (t: FilterToken[]) => void
  text: string
  onText: (t: string) => void
  placeholder: string
  /** A filter set from outside the bar (a tile or a step), shown as the first chip; ✕ clears it. */
  pinned?: { label: string; onRemove: () => void } | null
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const listId = useId()
  const offered = fields.filter((f) => f.options.length > 0)
  const draft = draftOf(text, offered)
  const chosen = new Set(tokens.map((t) => `${t.field}|${t.value}`))

  const suggestions: Suggestion[] = draft
    ? draft.field.options
        .filter((o) => !chosen.has(`${draft.field.field}|${o.value}`))
        .filter(
          (o) =>
            !draft.rest ||
            o.label.toLowerCase().includes(draft.rest) ||
            o.value.toLowerCase().includes(draft.rest)
        )
        .slice(0, 12)
        .map((o) => ({
          key: o.value,
          label: o.label,
          pick: () => {
            onTokens([...tokens, { field: draft.field.field, value: o.value, label: o.label }])
            onText('')
          },
        }))
    : offered
        .filter((f) => {
          const t = text.trim().toLowerCase()
          return f.field.startsWith(t) || FIELD_WORDS[f.field].startsWith(t)
        })
        .map((f) => ({
          key: f.field,
          label: `${FIELD_WORDS[f.field]}:`,
          note: `filter by ${f.hint}`,
          pick: () => onText(`${FIELD_WORDS[f.field]}:`),
        }))
  const shown = open && suggestions.length > 0
  const at = Math.min(active, suggestions.length - 1)

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setOpen(true)
      const n = suggestions.length
      if (n) setActive((at + (e.key === 'ArrowDown' ? 1 : n - 1)) % n)
    } else if (e.key === 'Enter' && shown) {
      e.preventDefault()
      suggestions[at]?.pick()
      setActive(0)
    } else if (e.key === 'Escape') {
      setOpen(false)
    } else if (e.key === 'Backspace' && !text) {
      if (tokens.length) onTokens(tokens.slice(0, -1))
      else pinned?.onRemove()
    }
  }

  return (
    <div className="rl-c-filter">
      <div className="rl-c-filter-box">
        <svg
          className="rl-c-filter-icon"
          viewBox="0 0 24 24"
          width="18"
          height="18"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="M15.5 15.5 21 21" />
        </svg>
        {pinned && (
          <span className="rl-c-token">
            {pinned.label}
            <button
              type="button"
              aria-label={`Remove the filter ${pinned.label}`}
              onClick={pinned.onRemove}
            >
              ✕
            </button>
          </span>
        )}
        {tokens.map((t) => (
          <span key={`${t.field}|${t.value}`} className="rl-c-token">
            <span className="rl-c-token-field">{FIELD_WORDS[t.field]}:</span> {t.label}
            <button
              type="button"
              aria-label={`Remove the filter ${FIELD_WORDS[t.field]} ${t.label}`}
              onClick={() => onTokens(tokens.filter((x) => x !== t))}
            >
              ✕
            </button>
          </span>
        ))}
        <input
          className="rl-c-filter-input"
          role="combobox"
          aria-expanded={shown}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-label="Search or filter the rows"
          placeholder={tokens.length || pinned ? 'Add a filter…' : placeholder}
          value={text}
          onChange={(e) => {
            onText(e.target.value)
            setActive(0)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKey}
        />
      </div>
      {shown && (
        <ul className="rl-c-suggest" id={listId} role="listbox">
          {suggestions.map((s, i) => (
            <li
              key={s.key}
              role="option"
              aria-selected={i === at}
              className={i === at ? 'rl-c-suggest-on' : undefined}
              // mousedown, so the pick lands before the input's blur closes the list
              onMouseDown={(e) => {
                e.preventDefault()
                s.pick()
                setActive(0)
              }}
            >
              <b>{s.label}</b>
              {s.note && <span> {s.note}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
