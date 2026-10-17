import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import {
  ENGAGEMENT_KINDS,
  ENGAGEMENT_KIND_LABELS,
  ENGAGEMENT_TRACKS,
  ENGAGEMENT_TRACK_LABELS,
  tagValueLabel,
  type DocumentDto,
  type DocumentKind,
  type EngagementDetail,
  type EngagementInput,
  type EngagementKind,
  type EngagementTrack,
  type WorkspaceDto,
} from '@ad/types'
import { useApi, useLoad } from '@/hooks/useApi'
import { money, shortDate } from '@/lib/format'
import {
  Button,
  Card,
  Chip,
  Empty,
  ErrorNote,
  Field,
  MoneyInput,
  inputClass,
} from '@/components/ui'
import { HandCard } from '@/components/HandCard'
import { TagPicker } from '@/components/Tags'

const KIND_BLURB: Record<EngagementKind, string> = {
  grant: 'Money awarded to run a program. Reports by budget line, proof per expense.',
  contract: 'A signed agreement for services, paid against invoices or monthly reports.',
  other: 'Anything else you must account for to a funder.',
}

type StepKey = 'what' | 'proposal' | 'award' | 'contract' | 'review'
const STEPS: { key: StepKey; title: string; blurb: string; help: string; later: string }[] = [
  {
    key: 'what',
    title: 'What are you tracking?',
    blurb: 'The kind of engagement, its name, which workspace keeps it, and what you keep for it.',
    help: 'Every engagement keeps its financials. Tick the other records you keep here; the steps you leave out show greyed out, and you can bring any of them back later.',
    later: '',
  },
  {
    key: 'proposal',
    title: 'The proposal',
    blurb: 'Who you sent it to, what you asked for, and when.',
    help: 'Keep the proposal exactly as you sent it. The auditor compares what you asked for with what was awarded and what you spent.',
    later: '',
  },
  {
    key: 'award',
    title: 'The award',
    blurb: 'What the award letter says: how much, dated when.',
    help: 'The letter names the amount; the contract number usually comes later, with the contract. If the letter came by email, save the email as a PDF too.',
    later: 'Later, when the award letter arrives.',
  },
  {
    key: 'contract',
    title: 'The contract and reporting',
    blurb: 'The contract number and dates, then when the monthly report is due.',
    help: 'Nothing can be spent before the agreement is fully executed, so the start date is the date that matters. Reports are usually due on the 12th.',
    later: 'Later, when the contract is signed.',
  },
  {
    key: 'review',
    title: 'Review',
    blurb: 'One look before it exists.',
    help: 'After this, the engagement opens at its first missing step. Nothing here is final: every field can be changed later from the engagement page.',
    later: '',
  },
]
/** The setup step that asks for each record kept besides the financials. */
const STEP_FOR: Partial<Record<EngagementTrack, StepKey>> = {
  proposal: 'proposal',
  'award-letter': 'award',
}
/** What the financials checkbox covers, in the words of the steps it keeps. */
const FINANCIALS_BLURB =
  'Budget narrative, contract dates and approved budget, participants, monthly reports. Always kept.'

type Files = Partial<Record<'proposal' | 'award-letter' | 'contract', File>>

/**
 * What is posted for a new engagement. A step the person left out sends none of its own fields (they may have typed
 * some before unticking it); the funder and the amount are asked on another step then, so they always go.
 */
export function engagementBody(
  form: EngagementInput,
  kind: EngagementKind | null,
  tracks: EngagementTrack[]
): EngagementInput {
  const body: EngagementInput = {
    ...form,
    kind: kind ?? 'grant',
    tracks,
    requestedAmount: form.requestedAmount || null,
    awardAmount: form.awardAmount || null,
    reportDueDay: Number(form.reportDueDay),
  }
  if (!tracks.includes('proposal')) {
    delete body.solicitation
    delete body.requestedAmount
    delete body.proposalSubmittedOn
  }
  if (!tracks.includes('award-letter')) delete body.awardedOn
  return body
}

/** The setup flow for a new engagement: short steps, starting wherever the paperwork is. */
export function NewEngagementPage() {
  const api = useApi()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const { data: workspaces } = useLoad<WorkspaceDto[]>('/workspaces')
  const [tracks, setTracks] = useState<EngagementTrack[]>([...ENGAGEMENT_TRACKS])
  const [kind, setKind] = useState<EngagementKind | null>(null)
  const [at, setAt] = useState(0) // index into the active steps
  const [form, setForm] = useState<EngagementInput>({
    workspaceId: params.get('workspace') ?? '',
    kind: 'grant',
    name: '',
    solicitation: '',
    funder: '',
    funderContact: '',
    tags: [],
    requestedAmount: null,
    proposalSubmittedOn: '',
    awardedOn: '',
    awardAmount: null,
    number: '',
    periodStart: '',
    periodEnd: '',
    reportDueDay: 12,
    reportTo: '',
    preparerName: '',
    authorizerName: '',
  })
  const [files, setFiles] = useState<Files>({})
  // The workspace's budget items this engagement does not use; every item is ticked to start with.
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const set = <K extends keyof EngagementInput>(k: K, v: EngagementInput[K]) =>
    setForm((f) => ({ ...f, [k]: v }))
  useEffect(() => {
    // One workspace: no choice to make. Several: the person picks, unless the link named one.
    if (workspaces?.length === 1 && form.workspaceId !== workspaces[0].id)
      set('workspaceId', workspaces[0].id)
    if (workspaces && workspaces.length > 1 && !workspaces.some((w) => w.id === form.workspaceId))
      set('workspaceId', '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaces])
  const workspace = workspaces?.find((w) => w.id === form.workspaceId)
  const active: StepKey[] = [
    'what',
    ...ENGAGEMENT_TRACKS.flatMap((t) => (tracks.includes(t) && STEP_FOR[t] ? [STEP_FOR[t]!] : [])),
    'contract',
    'review',
  ]
  // The proposal step asks for the funder and the award step for the amount: when a step is not kept, the
  // first step that is asks for them instead.
  const funderHere = active[1]
  const amountHere = active.includes('award') ? 'award' : 'contract'
  const toggle = (t: EngagementTrack) =>
    setTracks((ts) =>
      ts.includes(t)
        ? ts.filter((x) => x !== t)
        : ENGAGEMENT_TRACKS.filter((x) => x === t || ts.includes(x))
    )
  const kindWord =
    kind === 'other' || !kind ? 'engagement' : ENGAGEMENT_KIND_LABELS[kind].toLowerCase()
  const stepKey = active[Math.min(at, active.length - 1)]
  const step = STEPS.find((s) => s.key === stepKey)!

  const problems: string[] = []
  if (stepKey === 'what') {
    if (!kind) problems.push('a kind')
    if (!form.name.trim()) problems.push('a name')
    if (!form.workspaceId) problems.push('a workspace')
  }
  if (stepKey === funderHere && !form.funder?.trim()) problems.push('the funding organization')
  // Amounts and dates may not exist yet: the engagement page asks for them until they do.
  if (
    stepKey === 'contract' &&
    form.periodStart &&
    form.periodEnd &&
    form.periodEnd < form.periodStart
  )
    problems.push('an end date after the start')

  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const c = await api.post<EngagementDetail>('/engagements', engagementBody(form, kind, tracks))
      // A file chosen for a record the person then stopped tracking stays behind.
      const kept = (Object.entries(files) as [DocumentKind, File][]).filter(([k]) =>
        tracks.includes(k as EngagementTrack)
      )
      for (const [kind, file] of kept) {
        const body = new FormData()
        body.append('file', file)
        body.append('workspaceId', c.workspaceId)
        body.append('engagementId', c.id)
        body.append('kind', kind)
        await api.upload<DocumentDto>('/documents', body)
      }
      navigate(`/engagements/${c.id}`)
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  if (workspaces && workspaces.length === 0)
    return <Empty>No workspace yet. Ask a platform admin to set one up.</Empty>

  const fileField = (kind: keyof Files, label: string, hint: string) => (
    <Field label={label} hint={hint} className="sm:col-span-2">
      <input
        type="file"
        accept=".pdf,.png,.jpg,.jpeg,.docx,.xlsx"
        className="block w-full text-sm"
        onChange={(e) => setFiles((f) => ({ ...f, [kind]: e.target.files?.[0] ?? undefined }))}
      />
    </Field>
  )
  // Who funds it: asked on the first step this engagement uses.
  const funderFields = (
    <>
      <Field
        label="Funding organization"
        required
        hint="Who you sent it to; they award it and audit it"
      >
        <input
          className={inputClass}
          value={form.funder ?? ''}
          onChange={(e) => set('funder', e.target.value)}
        />
      </Field>
      <Field label="Funding organization contact" hint="A name or email there">
        <input
          className={inputClass}
          value={form.funderContact ?? ''}
          onChange={(e) => set('funderContact', e.target.value)}
        />
      </Field>
      <div className="ad-field sm:col-span-2">
        <span>Tags</span>
        <TagPicker
          types={workspace?.tagTypes ?? []}
          target="engagement"
          value={form.tags ?? []}
          onChange={(tags) => set('tags', tags)}
        />
        <small>
          The funding programs this is paid from, and any other tag for the engagement. The monthly
          report form prints them under Source of funds.
        </small>
      </div>
    </>
  )
  const leave = () => {
    if (
      at === 0 && !form.name.trim() && !kind
        ? true
        : confirm('Leave the setup? What you entered here is not saved.')
    )
      navigate(workspace ? `/workspaces/${workspace.id}` : '/workspaces')
  }

  return (
    <>
      <nav className="ad-crumbs" aria-label="Breadcrumb">
        {workspace ? (
          <Link to={`/workspaces/${workspace.id}`}>{workspace.name}</Link>
        ) : (
          <Link to="/workspaces">Workspace Manager</Link>
        )}{' '}
        / Set up an award
      </nav>
      <div className="ad-head">
        <div>
          <p className="ad-eyebrow">New engagement</p>
          <h1 className="ad-h1">Set up an award</h1>
          <p className="ad-sub">
            Start wherever the paperwork is. The steps on the left follow your answer, and the
            engagement opens at its first missing step when you are done.
          </p>
        </div>
      </div>

      <div className="ad-wizard">
        <div className="grid content-start gap-4">
          <Card>
            <ol className="ad-steps ad-steps-compact">
              {active.map((key, i) => {
                const s = STEPS.find((x) => x.key === key)!
                const cls = i < at ? 'ad-step-done' : i === at ? 'ad-step-current' : 'ad-step-later'
                return (
                  <li key={s.key} className={`ad-step ${cls}`}>
                    <span className="ad-step-dot" aria-hidden="true">
                      {i < at ? '✓' : i + 1}
                    </span>
                    <div className="ad-step-body">
                      <h3 className="ad-step-title">{s.title}</h3>
                      <p className="ad-step-blurb !mb-0">{s.blurb}</p>
                    </div>
                  </li>
                )
              })}
            </ol>
          </Card>
          <HandCard lead={step.title}>
            <p>{step.help}</p>
          </HandCard>
        </div>

        <Card eyebrow={`Step ${at + 1} of ${active.length}`} title={step.title}>
          <ErrorNote message={error} />
          {stepKey === 'what' && (
            <div className="grid gap-5">
              <fieldset className="ad-field">
                <span>
                  Kind<i className="ad-req">*</i>
                </span>
                <div className="ad-kinds">
                  {ENGAGEMENT_KINDS.map((k) => (
                    <label key={k} className="ad-kind">
                      <input
                        type="radio"
                        name="kind"
                        value={k}
                        checked={kind === k}
                        onChange={() => setKind(k)}
                      />
                      <b>{ENGAGEMENT_KIND_LABELS[k]}</b>
                      <span>{KIND_BLURB[k]}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <Field label="Name" required hint="The program or project, as your team calls it">
                <input
                  className={inputClass}
                  value={form.name}
                  onChange={(e) => set('name', e.target.value)}
                  autoFocus
                />
              </Field>
              {workspaces && workspaces.length > 1 ? (
                <Field label="Workspace" required hint="Which team keeps this engagement">
                  <select
                    className={inputClass}
                    value={form.workspaceId}
                    onChange={(e) => set('workspaceId', e.target.value)}
                  >
                    <option value="">Choose a workspace</option>
                    {workspaces.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                  </select>
                </Field>
              ) : (
                workspace && (
                  <p className="text-sm text-soft">
                    Kept in <b className="text-ink">{workspace.name}</b>.
                  </p>
                )
              )}
              <fieldset className="ad-field">
                <span>What do you want to track for this {kindWord}?</span>
                <div className="grid gap-2 text-sm">
                  {ENGAGEMENT_TRACKS.map((t) => (
                    <label key={t} className="inline-flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={tracks.includes(t)}
                        onChange={() => toggle(t)}
                      />
                      {ENGAGEMENT_TRACK_LABELS[t]}
                    </label>
                  ))}
                  <label className="inline-flex items-start gap-2">
                    <input type="checkbox" className="mt-1" checked disabled />
                    <span>
                      Financials <span className="text-soft">· {FINANCIALS_BLURB}</span>
                    </span>
                  </label>
                </div>
                <small>
                  What you leave out shows greyed out as not used. You can bring it back later.
                </small>
              </fieldset>
            </div>
          )}

          {stepKey === 'proposal' && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Proposal name"
                hint="As you titled it, or the request it answered"
                className="sm:col-span-2"
              >
                <input
                  className={inputClass}
                  value={form.solicitation ?? ''}
                  onChange={(e) => set('solicitation', e.target.value)}
                  autoFocus
                />
              </Field>
              {funderFields}
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
              {fileField(
                'proposal',
                'The proposal as submitted',
                'PDF or DOCX. Optional now; it is step 1 of the workflow.'
              )}
            </div>
          )}

          {stepKey === 'award' && (
            <div className="grid gap-4 sm:grid-cols-2">
              {funderHere === 'award' && funderFields}
              <Field label="Award amount" hint="Often less than you asked for">
                <MoneyInput
                  value={form.awardAmount ?? null}
                  onChange={(v) => set('awardAmount', v)}
                  autoFocus
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
              {fileField(
                'award-letter',
                'Award letter',
                'PDF, PNG, JPG or DOCX. Optional now; it is step 2 of the workflow.'
              )}
            </div>
          )}

          {stepKey === 'contract' && (
            <div className="grid gap-4 sm:grid-cols-2">
              {funderHere === 'contract' && funderFields}
              <p className="ad-group-title sm:col-span-2 !mb-0">Contract</p>
              <Field
                label="Contract number"
                hint="As the funder wrote it on the contract"
                className="sm:col-span-2"
              >
                <input
                  className={`${inputClass} ad-mono`}
                  value={form.number ?? ''}
                  onChange={(e) => set('number', e.target.value)}
                  autoFocus
                />
              </Field>
              {amountHere === 'contract' && (
                <Field
                  label="Contract amount"
                  hint="The total the contract awards"
                  className="sm:col-span-2"
                >
                  <MoneyInput
                    value={form.awardAmount ?? null}
                    onChange={(v) => set('awardAmount', v)}
                  />
                </Field>
              )}
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
              {tracks.includes('contract') &&
                fileField(
                  'contract',
                  'Signed contract',
                  'PDF or DOCX. Optional now; it is step 4 of the workflow.'
                )}
              <p className="ad-group-title sm:col-span-2 !mb-0 mt-2">Reporting</p>
              <Field
                label="Monthly report due on day"
                hint="Unless another date was agreed by email"
              >
                <input
                  type="number"
                  min="1"
                  max="28"
                  className={`${inputClass} max-w-[8rem]`}
                  value={form.reportDueDay ?? 12}
                  onChange={(e) => set('reportDueDay', Number(e.target.value))}
                />
              </Field>
              <Field
                label="Submitted to"
                hint="The contract specialist: name and email"
                className="sm:col-span-2"
              >
                <input
                  className={inputClass}
                  value={form.reportTo ?? ''}
                  onChange={(e) => set('reportTo', e.target.value)}
                />
              </Field>
              <Field
                label="Prepared by"
                hint="Who fills the report and signs it for the organization"
              >
                <input
                  className={inputClass}
                  value={form.preparerName ?? ''}
                  onChange={(e) => set('preparerName', e.target.value)}
                />
              </Field>
              <Field label="Authorized by" hint="Who signs for the organization">
                <input
                  className={inputClass}
                  value={form.authorizerName ?? ''}
                  onChange={(e) => set('authorizerName', e.target.value)}
                />
              </Field>
            </div>
          )}

          {stepKey === 'review' && (
            <dl className="ad-dl">
              <dt>Kind</dt>
              <dd>
                <Chip tone="muted">{kind ? ENGAGEMENT_KIND_LABELS[kind] : '—'}</Chip>
              </dd>
              <dt>Name</dt>
              <dd>{form.name}</dd>
              <dt>Workspace</dt>
              <dd>{workspace?.name}</dd>
              <dt>Tracking</dt>
              <dd>{[...tracks.map((t) => ENGAGEMENT_TRACK_LABELS[t]), 'Financials'].join(', ')}</dd>
              <dt>{active.includes('proposal') ? 'Proposal' : 'Funder'}</dt>
              <dd>
                {[
                  form.solicitation?.trim(),
                  form.funder?.trim() &&
                    (active.includes('proposal') ? `to ${form.funder.trim()}` : form.funder.trim()),
                  form.tags?.length
                    ? form.tags.map((t) => tagValueLabel(workspace?.tagTypes ?? [], t)).join(', ')
                    : null,
                  form.requestedAmount ? `${money(Number(form.requestedAmount))} requested` : null,
                  form.proposalSubmittedOn
                    ? `sent ${shortDate(`${form.proposalSubmittedOn}T00:00:00Z`)}`
                    : null,
                  files.proposal?.name,
                ]
                  .filter(Boolean)
                  .join(' · ') || 'nothing yet'}
              </dd>
              <dt>Award</dt>
              <dd>
                {!tracks.includes('award-letter')
                  ? `not used${form.awardAmount ? ` · contract amount ${money(Number(form.awardAmount))}` : ''}`
                  : active.includes('award')
                    ? [
                        form.awardAmount ? money(Number(form.awardAmount)) : null,
                        form.awardedOn ? `dated ${shortDate(`${form.awardedOn}T00:00:00Z`)}` : null,
                        files['award-letter']?.name,
                      ]
                        .filter(Boolean)
                        .join(' · ') || 'nothing yet'
                    : 'later, when it arrives'}
              </dd>
              <dt>Contract</dt>
              <dd>
                {active.includes('contract')
                  ? [
                      form.number?.trim(),
                      form.periodStart && form.periodEnd
                        ? `${shortDate(`${form.periodStart}T00:00:00Z`)} to ${shortDate(`${form.periodEnd}T00:00:00Z`)}`
                        : null,
                      `report due day ${form.reportDueDay}`,
                      files.contract?.name,
                    ]
                      .filter(Boolean)
                      .join(' · ')
                  : 'later, when it is signed'}
              </dd>
            </dl>
          )}

          <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
            <div className="text-sm text-soft">
              {problems.length > 0 ? `Still needed: ${problems.join(', ')}.` : ''}
            </div>
            <div className="ad-actions">
              <Button kind="ghost" onClick={leave} disabled={busy}>
                Cancel
              </Button>
              {at > 0 && (
                <Button onClick={() => setAt(at - 1)} disabled={busy}>
                  Back
                </Button>
              )}
              {at < active.length - 1 ? (
                <Button
                  kind="primary"
                  onClick={() => setAt(at + 1)}
                  disabled={problems.length > 0}
                  data-testid="wizard-next"
                >
                  Continue
                </Button>
              ) : (
                <Button kind="primary" onClick={create} disabled={busy} data-testid="wizard-create">
                  Create and open
                </Button>
              )}
            </div>
          </div>
        </Card>
      </div>
    </>
  )
}
