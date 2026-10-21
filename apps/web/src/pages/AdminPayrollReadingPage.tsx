import { useState } from 'react'
import {
  DEFAULT_PAYROLL_READING,
  PAYROLL_READING_DAYS,
  PAYROLL_READING_LISTS,
  type PayrollReading,
  type PayrollReadingDto,
} from '@ad/types'
import { useApi, useLoad } from '@/hooks/useApi'
import { ApiError } from '@/services/api'
import { shortDate } from '@/lib/format'
import { Button, Card, Empty, ErrorNote, inputClass } from '@/components/ui'
import { AdminHow } from '@/pages/AdminPage'
import './admin-highlights.css'

type Key = keyof PayrollReading

const READING_HOW =
  "Both payroll match screens read each payroll file by these words: a register's pay date and pay period, the total its bank debit is stated under, a pay stub's gross and net pay and the name it pays, and which bank lines are money coming in. Add the words a payroll company prints that aren't here yet; a space also matches a hyphen. The day windows say how far a bank debit may be from its pay date, and a staff charge from its payroll run. Each change saves at once and is kept in the history below, with who made it and when; it holds for every match worked out after, and saved months stay as they were until matched again. Restore defaults puts every word and day back as the app ships them, and is kept in the history too. When a file still can't be read, the match screen asks the person for its payroll period."

/** The words and days as the app ships them (the server answers them in the defaults' order). */
const isDefault = (r: PayrollReading) =>
  JSON.stringify({ ...DEFAULT_PAYROLL_READING, ...r }) === JSON.stringify(DEFAULT_PAYROLL_READING)

/**
 * Admin tools → File Matching, its payroll reading: the words and day windows both payroll match screens read payroll
 * files by, for the whole system (owner's decision, 2026-10-19). One row per list of words, as chips with a remove ×,
 * and a box to add one; then the day windows. Each change saves at once, kept with who made it and when; Restore
 * defaults puts them all back.
 */
export function PayrollReadingSection({ onSaved }: { onSaved: () => void }) {
  const api = useApi()
  const { data, error, setData } = useLoad<PayrollReadingDto>('/admin/payroll-reading')
  const [saving, setSaving] = useState<Key | 'all' | null>(null)
  const [saved, setSaved] = useState<Key | 'all' | null>(null)
  const [problems, setProblems] = useState<Partial<Record<Key, string>>>({})
  const [saveError, setSaveError] = useState<string | null>(null)
  const [adding, setAdding] = useState<Partial<Record<Key, string>>>({})
  if (error) return <ErrorNote message={error} />
  if (!data) return <Empty>Loading…</Empty>

  /** One change saves the whole set at once (a new row of the setting's history). */
  const save = async (key: Key | 'all', reading: PayrollReading) => {
    const before = data
    setData({ ...data, reading })
    setSaving(key)
    setSaved(null)
    setSaveError(null)
    setProblems({})
    try {
      setData(await api.put<PayrollReadingDto>('/admin/payroll-reading', reading))
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
  const words = (key: Key) => data.reading[key] as string[]
  const add = (key: Key) => {
    const word = (adding[key] ?? '').replace(/\s+/g, ' ').trim()
    if (!word) return
    if (words(key).some((w) => w.toLowerCase() === word.toLowerCase()))
      return setProblems({ [key]: 'Already on the list' })
    setAdding((a) => ({ ...a, [key]: '' }))
    void save(key, { ...data.reading, [key]: [...words(key), word] })
  }
  return (
    <>
      <Card
        title="Payroll reading: words"
        aside={
          <Button
            kind="navy"
            size="sm"
            disabled={saving !== null || isDefault(data.reading)}
            onClick={() => {
              if (
                confirm(
                  'Put every word and day window back as the app ships them? Your changes stay in the history.'
                )
              )
                void save('all', DEFAULT_PAYROLL_READING)
            }}
          >
            Restore defaults
          </Button>
        }
      >
        <ErrorNote message={saveError} />
        <div className="ad-hl-list">
          {PAYROLL_READING_LISTS.map(({ key, title, line }) => (
            <div key={key} className="ad-pr-row">
              <div className="ad-hl-head">
                <b>{title}</b>
                <span className="text-xs text-soft">{line}</span>
                <span className="text-xs text-soft" role="status">
                  {status(key)}
                </span>
              </div>
              <div className="grid gap-2">
                <div className="ad-hl-chips">
                  {words(key).map((w) => (
                    <span key={w} className="ad-hl-chip ad-hl-chip-on">
                      {w}
                      {words(key).length > 1 && (
                        <button
                          type="button"
                          className="ad-pr-x"
                          aria-label={`Remove ${w}`}
                          disabled={saving !== null}
                          onClick={() =>
                            void save(key, {
                              ...data.reading,
                              [key]: words(key).filter((x) => x !== w),
                            })
                          }
                        >
                          ×
                        </button>
                      )}
                    </span>
                  ))}
                </div>
                <form
                  className="flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault()
                    add(key)
                  }}
                >
                  <input
                    className={`${inputClass} ad-pr-add`}
                    placeholder="Add a word"
                    aria-label={`Add to ${title}`}
                    value={adding[key] ?? ''}
                    onChange={(e) => setAdding((a) => ({ ...a, [key]: e.target.value }))}
                  />
                  <button
                    type="submit"
                    className="ad-btn ad-btn-navy ad-btn-sm"
                    disabled={saving !== null}
                  >
                    Add
                  </button>
                </form>
                {problems[key] && (
                  <p className="text-sm font-semibold text-danger">{problems[key]}</p>
                )}
              </div>
            </div>
          ))}
        </div>
      </Card>
      <Card title="Payroll reading: day windows">
        <div className="ad-hl-list">
          {PAYROLL_READING_DAYS.map(({ key, title, line }) => (
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
                    key={`${key}-${data.reading[key]}`}
                    type="number"
                    min={0}
                    max={60}
                    className={`${inputClass} ad-pr-days`}
                    defaultValue={data.reading[key] as number}
                    aria-label={title}
                    onBlur={(e) => {
                      const n = Number(e.target.value)
                      if (e.target.value === '' || n === data.reading[key]) return
                      void save(key, { ...data.reading, [key]: n })
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
        <AdminHow to="/admin/matching" text={READING_HOW} />
      </Card>
    </>
  )
}
