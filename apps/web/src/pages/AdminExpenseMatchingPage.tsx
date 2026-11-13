import { useState } from 'react'
import {
  DEFAULT_EXPENSE_MATCHING,
  EXPENSE_MATCHING_DAYS,
  type ExpenseMatching,
  type ExpenseMatchingDto,
} from '@ad/types'
import { useApi, useLoad } from '@/hooks/useApi'
import { ApiError } from '@/services/api'
import { shortDate } from '@/lib/format'
import { Button, Card, Empty, ErrorNote, inputClass } from '@/components/ui'
import { AdminHow } from '@/pages/AdminPage'
import './admin-highlights.css'

type Key = keyof ExpenseMatching

const MATCHING_HOW =
  "The month's expenses from the books match each bill behind a line to its receipt and to the line of the month's bank or card statements that paid it: the amount to the cent, on a date within these days of the bill's date in the books, and only when exactly one fits. Each change saves at once and is kept in the history below, with who made it and when; it holds for every month's expenses opened after, and saved lines change only when the month's expenses are saved again."

/**
 * Admin tools → File Matching, its expense matching (owner's decision, 2026-11-12): how many days a receipt's date and
 * a statement line's date may be from the books' date of the bill they prove, for the whole system. Beside the payroll
 * reading and apart from it. Each change saves at once; Restore defaults puts both back.
 */
export function ExpenseMatchingSection({ onSaved }: { onSaved: () => void }) {
  const api = useApi()
  const { data, error, setData } = useLoad<ExpenseMatchingDto>('/admin/expense-matching')
  const [saving, setSaving] = useState<Key | 'all' | null>(null)
  const [saved, setSaved] = useState<Key | 'all' | null>(null)
  const [problems, setProblems] = useState<Partial<Record<Key, string>>>({})
  const [saveError, setSaveError] = useState<string | null>(null)
  if (error) return <ErrorNote message={error} />
  if (!data) return <Empty>Loading…</Empty>

  const save = async (key: Key | 'all', matching: ExpenseMatching) => {
    const before = data
    setData({ ...data, matching })
    setSaving(key)
    setSaved(null)
    setSaveError(null)
    setProblems({})
    try {
      setData(await api.put<ExpenseMatchingDto>('/admin/expense-matching', matching))
      setSaved(key)
      onSaved()
    } catch (e) {
      setData(before)
      const list = e instanceof ApiError ? (e.body as { problems?: unknown })?.problems : null
      if (Array.isArray(list))
        setProblems(
          Object.fromEntries(
            (list as { field: Key; message: string }[]).map((p) => [p.field, p.message])
          )
        )
      else setSaveError((e as Error).message)
    } finally {
      setSaving(null)
    }
  }
  const status = (key: Key) =>
    saving === key || saving === 'all'
      ? 'Saving…'
      : saved === key || saved === 'all'
        ? '✓ Saved'
        : data.changedAt
          ? `Changed by ${data.changedByEmail ?? 'an admin'}, ${shortDate(data.changedAt)}`
          : 'Defaults'
  const isDefault = EXPENSE_MATCHING_DAYS.every(
    ({ key }) => data.matching[key] === DEFAULT_EXPENSE_MATCHING[key]
  )
  return (
    <Card
      title="Expense matching: day windows"
      aside={
        <Button
          kind="navy"
          size="sm"
          disabled={saving !== null || isDefault}
          onClick={() => {
            if (
              confirm(
                'Put both day windows back as the app ships them? Your changes stay in the history.'
              )
            )
              void save('all', DEFAULT_EXPENSE_MATCHING)
          }}
        >
          Restore defaults
        </Button>
      }
    >
      <ErrorNote message={saveError} />
      <div className="ad-hl-list">
        {EXPENSE_MATCHING_DAYS.map(({ key, title, line }) => (
          <div key={key} className="ad-pr-row">
            <div className="ad-hl-head">
              <b>{title}</b>
              <span className="text-xs text-soft">{line}</span>
              <span className="text-xs text-soft" role="status">
                {status(key)}
              </span>
            </div>
            <div className="grid gap-1">
              <label className="flex items-center gap-2 text-sm">
                <input
                  key={`${key}-${data.matching[key]}`}
                  type="number"
                  min={0}
                  max={60}
                  className={`${inputClass} ad-pr-days`}
                  defaultValue={data.matching[key]}
                  aria-label={title}
                  onBlur={(e) => {
                    const n = Number(e.target.value)
                    if (e.target.value === '' || n === data.matching[key]) return
                    void save(key, { ...data.matching, [key]: n })
                  }}
                />
                days
              </label>
              {problems[key] && (
                <p className="text-sm font-semibold text-danger">{problems[key]}</p>
              )}
            </div>
          </div>
        ))}
      </div>
      <AdminHow to="/admin/matching" text={MATCHING_HOW} />
    </Card>
  )
}
