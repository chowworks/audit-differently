import { useState } from 'react'
import {
  DEFAULT_ELIGIBILITY_ITEMS,
  ENGAGEMENT_KINDS,
  ENGAGEMENT_KIND_LABELS,
  type DocumentKind,
  type EligibilityItemDef,
  type EngagementDetail,
  type EngagementInput,
} from '@ad/types'
import { useApi } from '@/hooks/useApi'
import { Button, ErrorNote, Field, Modal, MoneyInput, inputClass } from '@/components/ui'
import { TagPicker } from '@/components/Tags'

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : '')

/** The records of the first four steps that may not exist for an engagement, and how to say so. */
export const WAIVABLE: { kind: DocumentKind; label: string; example: string }[] = [
  { kind: 'proposal', label: 'proposal', example: 'the funder invited us directly, no proposal' },
  {
    kind: 'award-letter',
    label: 'award letter',
    example: 'the funder sent the contract with no letter',
  },
  {
    kind: 'budget-narrative',
    label: 'budget narrative',
    example: 'this funder does not ask for one',
  },
  { kind: 'contract', label: 'signed contract', example: 'the award letter is the agreement' },
]

/** The facts of an engagement, grouped as they arrive: proposal, award, contract, reporting, participants. */
export function EditEngagementModal({
  engagement: c,
  focus,
  onClose,
  onSaved,
}: {
  engagement: EngagementDetail
  /** Which group to open on, e.g. 'award-letter' when the missing record was the award amount. */
  focus?: 'proposal' | 'award-letter' | 'contract' | 'reporting' | 'participants' | 'waivers'
  onClose: () => void
  /** Gets the engagement as saved, so the page shows it without fetching it again. */
  onSaved: (saved: EngagementDetail) => void
}) {
  const api = useApi()
  const [form, setForm] = useState<Partial<EngagementInput>>({
    kind: c.kind,
    name: c.name,
    solicitation: c.solicitation ?? '',
    funder: c.funder ?? '',
    funderContact: c.funderContact ?? '',
    tags: c.tags,
    requestedAmount: c.requestedAmount,
    proposalSubmittedOn: day(c.proposalSubmittedOn),
    awardedOn: day(c.awardedOn),
    awardAmount: c.awardAmount,
    number: c.number ?? '',
    code: c.code ?? '',
    periodStart: day(c.periodStart),
    periodEnd: day(c.periodEnd),
    reportDueDay: c.reportDueDay,
    reportTo: c.reportTo ?? '',
    submissionMethod: c.submissionMethod ?? '',
    preparerName: c.preparerName ?? '',
    preparerOrganization: c.preparerOrganization ?? '',
    authorizerName: c.authorizerName ?? '',
    authorizerOrganization: c.authorizerOrganization ?? '',
    eligibilityItems: c.eligibilityItems.map((i) => ({ ...i })),
    waivers: { ...c.waivers },
  })
  const [newItem, setNewItem] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const set = <K extends keyof EngagementInput>(k: K, v: EngagementInput[K]) =>
    setForm((f) => ({ ...f, [k]: v }))
  const items = form.eligibilityItems ?? []
  const setItems = (next: EligibilityItemDef[]) => set('eligibilityItems', next)
  const addItem = () => {
    if (!newItem.trim()) return
    setItems([...items, { key: '', label: newItem.trim(), required: false }])
    setNewItem('')
  }
  const save = async (ev: React.FormEvent) => {
    ev.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const saved = await api.patch<EngagementDetail>(`/engagements/${c.id}`, {
        ...form,
        requestedAmount: form.requestedAmount || null,
        awardAmount: form.awardAmount || null,
        reportDueDay: Number(form.reportDueDay),
      })
      onSaved(saved)
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }
  const text = (k: keyof EngagementInput, label: string, hint?: string, className?: string) => (
    <Field label={label} hint={hint} className={className}>
      <input
        className={inputClass}
        value={(form[k] as string | null | undefined) ?? ''}
        onChange={(e) => set(k, e.target.value as never)}
      />
    </Field>
  )
  const group = (key: string, title: string, children: React.ReactNode) => (
    <details open={!focus || focus === key}>
      <summary className="ad-group-title cursor-pointer">{title}</summary>
      <div className="grid gap-4 pb-3 sm:grid-cols-2">{children}</div>
    </details>
  )
  return (
    <Modal title={`Details of ${c.name}`} onClose={onClose} wide>
      <form onSubmit={save} className="grid gap-3">
        <ErrorNote message={error} />
        <div className="grid gap-4 pb-2 sm:grid-cols-2">
          <Field label="Name" required>
            <input
              className={inputClass}
              value={form.name ?? ''}
              onChange={(e) => set('name', e.target.value)}
              required
            />
          </Field>
          <Field label="Kind" required>
            <select
              className={inputClass}
              value={form.kind}
              onChange={(e) => set('kind', e.target.value as EngagementInput['kind'])}
            >
              {ENGAGEMENT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {ENGAGEMENT_KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="Engagement code"
            hint="Put it in the subject of an emailed receipt to file it here, e.g. Receipt CP26"
          >
            <input
              className={`${inputClass} ad-mono`}
              value={form.code ?? ''}
              maxLength={20}
              onChange={(e) => set('code', e.target.value.toUpperCase())}
            />
          </Field>
        </div>
        {group(
          'proposal',
          'Step 1 · Proposal',
          <>
            {text('solicitation', 'Proposal name', undefined, 'sm:col-span-2')}
            {text('funder', 'Funding organization', 'Who awards it and audits it')}
            {text('funderContact', 'Funding organization contact')}
            <div className="ad-field sm:col-span-2">
              <span>Tags</span>
              <TagPicker
                types={c.tagTypes}
                target="engagement"
                value={form.tags ?? []}
                onChange={(tags) => set('tags', tags)}
              />
              <small>The monthly report form prints them under Source of funds.</small>
            </div>
            <Field label="Amount requested">
              <MoneyInput
                value={form.requestedAmount ?? null}
                onChange={(v) => set('requestedAmount', v)}
              />
            </Field>
            <Field label="Submitted on">
              <input
                type="date"
                className={inputClass}
                value={form.proposalSubmittedOn ?? ''}
                onChange={(e) => set('proposalSubmittedOn', e.target.value)}
              />
            </Field>
          </>
        )}
        {group(
          'award-letter',
          'Step 2 · Award',
          <>
            <Field label="Award amount">
              <MoneyInput
                value={form.awardAmount ?? null}
                onChange={(v) => set('awardAmount', v)}
              />
            </Field>
            <Field label="Award letter dated">
              <input
                type="date"
                className={inputClass}
                value={form.awardedOn ?? ''}
                onChange={(e) => set('awardedOn', e.target.value)}
              />
            </Field>
          </>
        )}
        {group(
          'contract',
          'Step 4 · Contract',
          <>
            <Field label="Contract number" className="sm:col-span-2">
              <input
                className={`${inputClass} ad-mono`}
                value={form.number ?? ''}
                onChange={(e) => set('number', e.target.value)}
              />
            </Field>
            <Field label="Starts">
              <input
                type="date"
                className={inputClass}
                value={form.periodStart ?? ''}
                onChange={(e) => set('periodStart', e.target.value)}
              />
            </Field>
            <Field label="Ends">
              <input
                type="date"
                className={inputClass}
                value={form.periodEnd ?? ''}
                onChange={(e) => set('periodEnd', e.target.value)}
              />
            </Field>
          </>
        )}
        {group(
          'reporting',
          'Reporting',
          <>
            <Field label="Monthly report due on day">
              <input
                type="number"
                min="1"
                max="28"
                className={inputClass}
                value={form.reportDueDay ?? 12}
                onChange={(e) => set('reportDueDay', Number(e.target.value))}
              />
            </Field>
            {text('submissionMethod', 'How it is submitted', 'e.g. by email, or an upload site')}
            {text(
              'reportTo',
              'Submitted to',
              'The contract specialist: name and email',
              'sm:col-span-2'
            )}
            {text(
              'preparerName',
              'Prepared by',
              'Who fills the report and signs it for the organization'
            )}
            {text('preparerOrganization', 'Preparer organization')}
            {text(
              'authorizerName',
              'Authorized by',
              'Who signs for the organization, and the letter to the auditors'
            )}
            {text('authorizerOrganization', 'Authorizer organization')}
          </>
        )}
        {group(
          'participants',
          'Participant files · what each file must hold',
          <div className="grid gap-2 sm:col-span-2">
            <p className="text-sm text-soft">
              The checklist for this program. Required items count toward "complete"; the rest are
              kept when you have them.
            </p>
            {items.map((item, i) => (
              <div key={`${item.key}-${i}`} className="flex flex-wrap items-center gap-2 text-sm">
                <input
                  className={`${inputClass} max-w-[18rem]`}
                  value={item.label}
                  onChange={(e) =>
                    setItems(items.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))
                  }
                />
                <label className="inline-flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={item.required}
                    onChange={(e) =>
                      setItems(
                        items.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x))
                      )
                    }
                  />
                  required
                </label>
                <Button
                  kind="ghost"
                  size="sm"
                  className="text-danger"
                  onClick={() => setItems(items.filter((_, j) => j !== i))}
                >
                  remove
                </Button>
              </div>
            ))}
            <div className="flex flex-wrap gap-2">
              <input
                className={`${inputClass} max-w-[18rem]`}
                placeholder="Add an item, e.g. Photo ID"
                value={newItem}
                onChange={(e) => setNewItem(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    addItem()
                  }
                }}
              />
              <Button onClick={addItem} disabled={!newItem.trim()}>
                Add
              </Button>
              <Button
                kind="ghost"
                onClick={() => setItems(DEFAULT_ELIGIBILITY_ITEMS.map((x) => ({ ...x })))}
              >
                Reset to defaults
              </Button>
            </div>
          </div>
        )}
        {group(
          'waivers',
          'Records that do not exist for this engagement',
          <div className="grid gap-3 sm:col-span-2">
            <p className="text-sm text-soft">
              Some funders skip a step. Say so here and the audit package counts the reason as the
              record, instead of asking for a file that never existed.
            </p>
            {WAIVABLE.map((wv) => {
              const reason = form.waivers?.[wv.kind] ?? ''
              const on = reason !== ''
              return (
                <div key={wv.kind} className="grid gap-2 sm:grid-cols-[auto_1fr] sm:items-center">
                  <label className="inline-flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={(e) =>
                        set('waivers', {
                          ...form.waivers,
                          [wv.kind]: e.target.checked ? `no ${wv.label}` : '',
                        })
                      }
                    />
                    No {wv.label}
                  </label>
                  {on && (
                    <input
                      className={inputClass}
                      placeholder={`Why, e.g. ${wv.example}`}
                      value={reason}
                      onChange={(e) =>
                        set('waivers', { ...form.waivers, [wv.kind]: e.target.value })
                      }
                    />
                  )}
                </div>
              )
            })}
          </div>
        )}
        <div className="mt-2 flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" kind="primary" disabled={busy}>
            Save
          </Button>
        </div>
      </form>
    </Modal>
  )
}
