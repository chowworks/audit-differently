import { useState } from 'react'
import {
  DOCUMENT_KIND_LABELS,
  HIGHLIGHT_FIELD_LABELS,
  type HighlightField,
  type HighlightSettingDto,
} from '@ad/types'
import { useApi, useLoad } from '@/hooks/useApi'
import { shortDate } from '@/lib/format'
import { Card, Empty, ErrorNote } from '@/components/ui'
import { AdminHow, AdminToolHead } from '@/pages/AdminPage'
import './admin-highlights.css'

const kindTitle = (k: string) => {
  const w = DOCUMENT_KIND_LABELS[k as keyof typeof DOCUMENT_KIND_LABELS] ?? k
  return w.charAt(0).toUpperCase() + w.slice(1)
}

/** Which things make sense on each proof: a bank line has no name or pay period, a stub no bank date. */
const FIELDS_FOR: Record<string, HighlightField[]> = {
  timesheet: ['row', 'name', 'payPeriod', 'amount'],
  'payroll-register': ['payPeriod', 'payDate', 'amount', 'name'],
  paystub: ['name', 'payPeriod', 'payDate', 'amount'],
  'bank-statement': ['date', 'amount'],
}

/** Fictional sample lines for the preview (the sample zip's Jordan Sample), each part tagged with what it shows. */
const SAMPLE: Record<string, { label?: string; parts: [string, HighlightField | null][] }[]> = {
  paystub: [
    {
      label: 'Paid to',
      parts: [
        ['Jordan', 'name'],
        [' ', null],
        ['Sample', 'name'],
      ],
    },
    {
      label: 'Pay period',
      parts: [
        ['09/07/2026', 'payPeriod'],
        [' – ', null],
        ['09/20/2026', 'payPeriod'],
      ],
    },
    { label: 'Pay date', parts: [['09/25/2026', 'payDate']] },
    { label: 'Gross pay', parts: [['$280.00', 'amount']] },
  ],
  timesheet: [
    {
      parts: [
        ['Jordan Sample', 'name'],
        [' · ', null],
        ['09/07/2026 – 09/20/2026', 'payPeriod'],
        [' · ', null],
        ['$280.00', 'amount'],
        [' · 20.0 h', null],
      ],
    },
    { parts: [['Casey Demo · 09/07/2026 – 09/20/2026 · $280.00 · 20.0 h', null]] },
  ],
  'payroll-register': [
    {
      label: 'Pay period',
      parts: [
        ['09/07/2026', 'payPeriod'],
        [' – ', null],
        ['09/20/2026', 'payPeriod'],
      ],
    },
    { label: 'Pay date', parts: [['09/25/2026', 'payDate']] },
    { label: 'Employees paid', parts: [['3 · total gross $784.00', null]] },
    { label: 'Jordan Sample', parts: [['$280.00', 'amount']] },
  ],
  'bank-statement': [
    { parts: [['09/04/2026 · DEBIT CARD OFFICE SUPPLY · $212.18', null]] },
    {
      parts: [
        ['09/22/2026', 'date'],
        [' · ACH PAYROLL · ', null],
        ['$724.02', 'amount'],
      ],
    },
    { parts: [['09/30/2026 · CHECK 2209 · $900.00', null]] },
  ],
}

/** The sample lines with the chosen things highlighted, as an item's own copy would show them. */
function Preview({ kind, fields }: { kind: string; fields: HighlightField[] }) {
  const row = fields.includes('row')
  return (
    <div className="ad-hl-doc" aria-label="Preview">
      {SAMPLE[kind]!.map((l, i) => {
        const isRow = kind === 'timesheet' && i === 0 && row
        return (
          <div key={i} className={`ad-hl-line ${isRow ? 'ad-hl-on' : ''}`}>
            {l.label && <span className="ad-hl-label">{l.label}</span>}
            {l.parts.map(([text, f], j) => (
              <span key={j} className={!isRow && f && fields.includes(f) ? 'ad-hl-on' : ''}>
                {text}
              </span>
            ))}
          </div>
        )
      })}
    </div>
  )
}

const lastChanged = (s: HighlightSettingDto) =>
  s.changedAt
    ? `Changed by ${s.changedByEmail ?? 'an admin'}, ${shortDate(s.changedAt)}`
    : 'Defaults'

/**
 * Admin tools → Payroll proof highlighting: what the auditor sees highlighted on each kind of payroll proof, for the
 * whole system. One long row per proof type: its choices as chips and a preview of a fictional sample with them
 * highlighted. Each tick saves at once, kept with who made it and when.
 */
export function AdminHighlightsPage() {
  const api = useApi()
  const { data, error, setData } = useLoad<HighlightSettingDto[]>('/admin/highlights')
  // The proof types being saved, and the last one saved, for the word beside each name.
  const [saving, setSaving] = useState<ReadonlySet<string>>(new Set())
  const [saved, setSaved] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  if (error) return <ErrorNote message={error} />
  if (!data) return <Empty>Loading…</Empty>
  /** A tick saves at once (a new row of the setting's history); the last tick of a proof type cannot be cleared. */
  const toggle = async (s: HighlightSettingDto, f: HighlightField, on: boolean) => {
    const fields = on ? [...s.fields, f] : s.fields.filter((x) => x !== f)
    if (!fields.length) return
    // Only this proof type's row changes, so a save of another type running at the same time keeps its own.
    const put = (row: HighlightSettingDto) =>
      setData((d) => d && d.map((x) => (x.kind === s.kind ? row : x)))
    put({ ...s, fields })
    setSaving((k) => new Set(k).add(s.kind))
    setSaved(null)
    setSaveError(null)
    try {
      const all = await api.put<HighlightSettingDto[]>(`/admin/highlights/${s.kind}`, { fields })
      put(all.find((x) => x.kind === s.kind) ?? { ...s, fields })
      setSaved(s.kind)
    } catch (e) {
      put(s)
      setSaveError((e as Error).message)
    } finally {
      setSaving((k) => {
        const next = new Set(k)
        next.delete(s.kind)
        return next
      })
    }
  }
  return (
    <>
      <AdminToolHead to="/admin/highlights" />
      <ErrorNote message={saveError} />
      <Card title="What is highlighted">
        <div className="ad-hl-list">
          {data.map((s) => (
            <div key={s.kind} className="ad-hl-row">
              <div className="ad-hl-head">
                <b>{kindTitle(s.kind)}</b>
                <span className="text-xs text-soft" role="status">
                  {saving.has(s.kind) ? 'Saving…' : saved === s.kind ? '✓ Saved' : lastChanged(s)}
                </span>
              </div>
              <div className="ad-hl-chips">
                {FIELDS_FOR[s.kind]!.map((f) => {
                  const on = s.fields.includes(f)
                  const last = on && s.fields.length === 1
                  return (
                    <label
                      key={f}
                      className={`ad-hl-chip ${on ? 'ad-hl-chip-on' : ''}`}
                      title={last ? 'Keep at least one' : undefined}
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={last || saving.has(s.kind)}
                        onChange={(e) => void toggle(s, f, e.target.checked)}
                      />
                      {HIGHLIGHT_FIELD_LABELS[f]}
                    </label>
                  )
                })}
              </div>
              <Preview kind={s.kind} fields={s.fields} />
            </div>
          ))}
        </div>
        <AdminHow to="/admin/highlights" />
      </Card>
    </>
  )
}
