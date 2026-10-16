import { useState } from 'react'
import { tagLabel, tagValueLabel, type TagTarget, type TagType } from '@ad/types'
import { Button, ErrorNote, Modal, inputClass } from '@/components/ui'
import { MultiSelect, type MultiOption } from '@/components/MultiSelect'

/** The tag types that apply to a kind of record. */
export const typesFor = (types: TagType[], target: TagTarget) =>
  types.filter((t) => t.appliesTo.includes(target))

/** A record's tags as small chips; the type is in the tooltip. */
export function TagChips({ types, tags }: { types: TagType[]; tags: string[] }) {
  if (!tags.length) return null
  return (
    <span className="ad-tagchips">
      {tags.map((t) => (
        <span key={t} className="ad-tagchip" title={tagLabel(types, t)}>
          {tagValueLabel(types, t)}
        </span>
      ))}
    </span>
  )
}

/**
 * Pick tags from the workspace's list: one multi-select per type that applies to this kind of record. Only values of
 * the list, no free text. A tag the record has that is no longer offered here shows under "No longer in the list",
 * and can be taken off.
 */
export function TagPicker({
  types,
  target,
  value,
  onChange,
}: {
  types: TagType[]
  target: TagTarget
  value: string[]
  onChange: (tags: string[]) => void
}) {
  const shown = typesFor(types, target)
  const known = new Set(shown.flatMap((t) => t.values.map((v) => `${t.key}:${v.key}`)))
  const old = value.filter((t) => !known.has(t))
  /** The record's tags with one group's choice replaced, in the list's order (the ones no longer offered last). */
  const set = (group: string[], chosen: string[]) => {
    const rest = value.filter((t) => !group.includes(t))
    const all = [...rest, ...chosen]
    onChange([...[...known].filter((t) => all.includes(t)), ...all.filter((t) => !known.has(t))])
  }
  const row = (label: string, options: MultiOption[]) => {
    const group = options.map((o) => o.value)
    return (
      <div key={label} className="grid gap-1">
        <span className="text-xs font-semibold text-soft">{label}</span>
        <MultiSelect
          label={label}
          options={options}
          value={value.filter((t) => group.includes(t))}
          onChange={(chosen) => set(group, chosen)}
        />
      </div>
    )
  }
  if (!shown.length && !old.length)
    return (
      <p className="text-sm text-soft">
        No tags for these records yet. Owners add them in workspace settings.
      </p>
    )
  return (
    <div className="grid gap-3">
      {shown.map((t) =>
        row(
          t.label,
          t.values.map((v) => ({ value: `${t.key}:${v.key}`, label: v.label }))
        )
      )}
      {old.length > 0 &&
        row(
          'No longer in the list',
          old.map((tag) => ({ value: tag, label: tagLabel(types, tag) }))
        )}
    </div>
  )
}

/** Change one record's tags; saves when the person says so. */
export function TagsModal({
  title,
  types,
  target,
  tags,
  onClose,
  onSave,
}: {
  title: string
  types: TagType[]
  target: TagTarget
  tags: string[]
  onClose: () => void
  onSave: (tags: string[]) => Promise<void>
}) {
  const [value, setValue] = useState(tags)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      await onSave(value)
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }
  return (
    <Modal title={title} onClose={onClose}>
      <div className="grid gap-4">
        <ErrorNote message={error} />
        <TagPicker types={types} target={target} value={value} onChange={setValue} />
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" kind="primary" onClick={save} disabled={busy}>
            Save tags
          </Button>
        </div>
      </div>
    </Modal>
  )
}

/** "Any tag" or one value of the list, for filtering a list of records. */
export function TagFilter({
  types,
  target,
  value,
  onChange,
}: {
  types: TagType[]
  target: TagTarget
  value: string
  onChange: (tag: string) => void
}) {
  const shown = typesFor(types, target)
  if (!shown.length) return null
  return (
    <select
      className={`${inputClass} ad-input-sm w-auto`}
      aria-label="Show only records with this tag"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">Any tag</option>
      {shown.map((t) => (
        <optgroup key={t.key} label={t.label}>
          {t.values.map((v) => (
            <option key={v.key} value={`${t.key}:${v.key}`}>
              {v.label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  )
}
