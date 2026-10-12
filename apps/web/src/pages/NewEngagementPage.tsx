import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import {
  ENGAGEMENT_KINDS,
  ENGAGEMENT_KIND_LABELS,
  type DocumentDto,
  type DocumentKind,
  type EngagementDetail,
  type EngagementInput,
  type EngagementKind,
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

const KIND_BLURB: Record<EngagementKind, string> = {
  grant: 'Money awarded to run a program. Reports by budget line, proof per expense.',
  contract: 'A signed agreement for services, paid against invoices or monthly reports.',
  other: 'Anything else you must account for to a funder.',
}

type Stage = 'proposal' | 'award' | 'contract'
const STAGES: { key: Stage; title: string; blurb: string }[] = [
  {
    key: 'proposal',
    title: 'We sent a proposal',
    blurb: 'Nothing awarded yet. Keep the proposal; the rest comes later.',
  },
  {
    key: 'award',
    title: 'We have the award letter',
    blurb: 'The funder said yes. The contract is still being written.',
  },
  {
    key: 'contract',
    title: 'We have a signed contract',
    blurb: 'Everything is settled; the months can start.',
  },
]

type StepKey = 'what' | 'proposal' | 'award' | 'contract' | 'review'
const STEPS: { key: StepKey; title: string; blurb: string; help: string; later: string }[] = [
  {
    key: 'what',
    title: 'What are you tracking?',
    blurb: 'The kind of engagement, its name, which workspace keeps it, and where you are today.',
    help: 'Most engagements start at the proposal. Say where you are and the next steps ask only for what you have; everything else can be added as it arrives.',
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
const ACTIVE: Record<Stage, StepKey[]> = {
  proposal: ['what', 'proposal', 'review'],
  award: ['what', 'proposal', 'award', 'review'],
  contract: ['what', 'proposal', 'award', 'contract', 'review'],
}

type Files = Partial<Record<'proposal' | 'award-letter' | 'contract', File>>

/** The setup flow for a new engagement: short steps, starting wherever the paperwork is. */
export function NewEngagementPage() {
  const api = useApi()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const { data: workspaces } = useLoad<WorkspaceDto[]>('/workspaces')
  const [stage, setStage] = useState<Stage | null>(null)
  const [kind, setKind] = useState<EngagementKind | null>(null)
  const [at, setAt] = useState(0) // index into the active steps
  const [form, setForm] = useState<EngagementInput>({
    workspaceId: params.get('workspace') ?? '',
    kind: 'grant',
    name: '',
    solicitation: '',
    funder: '',
    funderContact: '',
    fundingSources: [],
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
  const active = stage ? ACTIVE[stage] : ['what']
  const stepKey = active[Math.min(at, active.length - 1)]
  const step = STEPS.find((s) => s.key === stepKey)!

  const problems: string[] = []
  if (stepKey === 'what') {
    if (!kind) problems.push('a kind')
    if (!form.name.trim()) problems.push('a name')
    if (!form.workspaceId) problems.push('a workspace')
    if (!stage) problems.push('where you are')
  }
  if (stepKey === 'proposal' && !form.funder?.trim()) problems.push('the funding organization')
  if (stepKey === 'award' && !(Number(form.awardAmount) > 0)) problems.push('the award amount')
  if (stepKey === 'contract') {
    if (!form.periodStart || !form.periodEnd) problems.push('start and end dates')
    else if (form.periodEnd < form.periodStart) problems.push('an end date after the start')
  }

  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const c = await api.post<EngagementDetail>('/engagements', {
        ...form,
        kind: kind ?? 'grant',
        requestedAmount: form.requestedAmount || null,
        awardAmount: form.awardAmount || null,
        reportDueDay: Number(form.reportDueDay),
      })
      for (const [kind, file] of Object.entries(files) as [DocumentKind, File][]) {
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
    return (
      <Empty>
        No workspace yet. <Link to="/workspaces">Create one</Link> first.
      </Empty>
    )

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
  const stageTitle = STAGES.find((s) => s.key === stage)?.title ?? 'Where are you?'
  const leave = () => {
    if (
      at === 0 && !form.name.trim() && !kind && !stage
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
          <Link to="/workspaces">Manage workspaces</Link>
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
              {!stage && (
                <li className="ad-step ad-step-later">
                  <span className="ad-step-dot" aria-hidden="true">
                    …
                  </span>
                  <div className="ad-step-body">
                    <h3 className="ad-step-title">The rest follows your answer</h3>
                    <p className="ad-step-blurb !mb-0">
                      Say where you are and only the steps you can fill today appear here.
                    </p>
                  </div>
                </li>
              )}
            </ol>
          </Card>
          <HandCard lead={step.title}>
            <p>{step.help}</p>
          </HandCard>
        </div>

        <Card eyebrow={`Step ${at + 1} of ${active.length} · ${stageTitle}`} title={step.title}>
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
                <span>
                  Where are you in the process today?<i className="ad-req">*</i>
                </span>
                <div className="ad-kinds">
                  {STAGES.map((s) => (
                    <label key={s.key} className="ad-kind">
                      <input
                        type="radio"
                        name="stage"
                        value={s.key}
                        checked={stage === s.key}
                        onChange={() => setStage(s.key)}
                      />
                      <b>{s.title}</b>
                      <span>{s.blurb}</span>
                    </label>
                  ))}
                </div>
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
              <fieldset className="ad-field sm:col-span-2">
                <span>Source of funds</span>
                <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
                  {(workspace?.fundingSources ?? []).map((f) => (
                    <label key={f} className="inline-flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={form.fundingSources?.includes(f) ?? false}
                        onChange={() =>
                          set(
                            'fundingSources',
                            form.fundingSources?.includes(f)
                              ? form.fundingSources.filter((x) => x !== f)
                              : [...(form.fundingSources ?? []), f]
                          )
                        }
                      />
                      {f}
                    </label>
                  ))}
                </div>
                <small>
                  The funding program you proposed to. Missing one? An owner adds it under{' '}
                  {workspace ? (
                    <Link to={`/workspaces/${workspace.id}#settings`}>the workspace settings</Link>
                  ) : (
                    'the workspace settings'
                  )}
                  .
                </small>
              </fieldset>
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
              <Field label="Award amount" required hint="Often less than you asked for">
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
              <Field label="Starts" required>
                <input
                  type="date"
                  className={inputClass}
                  value={form.periodStart ?? ''}
                  onChange={(e) => set('periodStart', e.target.value)}
                />
              </Field>
              <Field label="Ends" required>
                <input
                  type="date"
                  className={inputClass}
                  value={form.periodEnd ?? ''}
                  onChange={(e) => set('periodEnd', e.target.value)}
                />
              </Field>
              {fileField(
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
              <dt>Where you are</dt>
              <dd>{stageTitle}</dd>
              <dt>Proposal</dt>
              <dd>
                {[
                  form.solicitation?.trim(),
                  form.funder?.trim() && `to ${form.funder.trim()}`,
                  form.fundingSources?.length ? form.fundingSources.join(', ') : null,
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
                {active.includes('award')
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
