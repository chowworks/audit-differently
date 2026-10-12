import { Fragment, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  BUDGET_CATEGORY_LABELS,
  ENGAGEMENT_KIND_LABELS,
  REPORT_LINE_LABELS,
  type AuditPackagePartsDto,
  type DocumentDto,
  type DocumentKind,
  type EngagementDetail,
  type ReportSummary,
  type WorkspaceDto,
} from '@ad/types'
import { useApi, useLoad } from '@/hooks/useApi'
import { money, nextPeriod, periodLabel, shortDate } from '@/lib/format'
import {
  daysUntil,
  nextDue,
  workflow,
  type RecordItem,
  type Step,
  type StepKey,
} from '@/lib/workflow'
import { Button, Card, Chip, Empty, ErrorNote, Modal, Notice, StatusChip } from '@/components/ui'
import { DeleteModal } from '@/components/DeleteModal'
import { AttachModal } from '@/components/AttachModal'
import { AddParticipantModal } from '@/components/AddParticipantModal'
import { DocumentMenuModal } from '@/components/DocumentMenuModal'
import { EditEngagementModal } from '@/components/EditEngagementModal'
import { HandCard } from '@/components/HandCard'
import { ParticipantsModal } from '@/components/ParticipantsModal'
import { StepSummary, type SummaryRow } from '@/components/StepSummary'
import { RecordModal } from '@/components/RecordModal'

type Upload = { kind: DocumentKind; period: string | null; title: string }
type Focus = 'proposal' | 'award-letter' | 'contract' | 'waivers'
/** The kinds that have a step of their own; everything else at engagement level is "other records". */
const STEP_KINDS: DocumentKind[] = ['proposal', 'award-letter', 'budget-narrative', 'contract']
const OTHER_KINDS: DocumentKind[] = [
  'other',
  'mou',
  'invoice',
  'receipt',
  'purchase-order',
  'bank-statement',
  'card-statement',
  'eft-confirmation',
  'cancelled-check',
  'allocation-calculation',
  'payroll-register',
  'timesheet',
]

/** One engagement, step by step: the eight steps, the records each needs, this month, and the audit package. */
export function EngagementPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const api = useApi()
  const { data: c, error, reload } = useLoad<EngagementDetail>(id ? `/engagements/${id}` : null)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null)
  const [upload, setUpload] = useState<Upload | null>(null)
  const [record, setRecord] = useState<{ kind: DocumentKind; title: string } | null>(null)
  const [editing, setEditing] = useState<Focus | 'all' | null>(null)
  const [addingOther, setAddingOther] = useState(false)
  // Set when the audit package is too big for one zip: the parts to download one by one.
  const [packageParts, setPackageParts] = useState<AuditPackagePartsDto['parts'] | null>(null)
  const [addingParticipant, setAddingParticipant] = useState(false)
  const [participantsOpen, setParticipantsOpen] = useState<{ fileFor?: string } | null>(null)
  const [monthsOpen, setMonthsOpen] = useState<'ledger' | 'submission' | null>(null)
  const [menu, setMenu] = useState<{
    doc: DocumentDto
    kind: DocumentKind
    period: string | null
  } | null>(null)

  if (error) return <ErrorNote message={error} />
  if (!c) return <Empty>Loading…</Empty>

  const today = new Date()
  const items = c.eligibilityItems
  const w = workflow(c, c.participants, today, items)
  const due = nextDue(c, today)
  const last = c.reports[c.reports.length - 1]
  const next = last ? nextPeriod(last.period) : (c.periodStart ?? '').slice(0, 7)
  const canAddMonth =
    c.canManage && !!c.periodStart && !!c.periodEnd && next <= c.periodEnd.slice(0, 7)
  const run = async (fn: () => Promise<void>, ok?: string) => {
    setBusy('x')
    setNotice(null)
    try {
      await fn()
      await reload()
      if (ok) setNotice({ tone: 'ok', text: ok })
    } catch (e) {
      setNotice({ tone: 'danger', text: (e as Error).message })
    } finally {
      setBusy(null)
    }
  }
  const addMonth = () =>
    run(async () => {
      await api.post<ReportSummary>(`/engagements/${c.id}/reports`, { period: next })
    })
  const openMenu = (doc: DocumentDto, kind: DocumentKind, period: string | null = null) =>
    setMenu({ doc, kind, period })
  const downloadPackage = () =>
    run(async () => {
      const listing = await api.download<AuditPackagePartsDto>(
        `/engagements/${c.id}/audit-package`,
        `${c.name} - audit package.zip`
      )
      if (listing) setPackageParts(listing.parts)
      else
        setNotice({
          tone: 'ok',
          text: 'Audit package downloaded. The export is in the access log.',
        })
    })
  const downloadPackagePart = (n: number, fileName: string) =>
    run(async () => {
      await api.download(`/engagements/${c.id}/audit-package?part=${n}`, fileName)
      setNotice({ tone: 'ok', text: `Part ${n} downloaded. The export is in the access log.` })
    })
  const budgetTotal = c.budgetLines.reduce((t, b) => t + b.amount, 0)
  const remaining = (c.awardAmount ?? 0) - c.cumulativeBilled
  const billedPct = c.awardAmount ? Math.min(100, (c.cumulativeBilled / c.awardAmount) * 100) : 0
  const editFor = (key: StepKey): Focus =>
    key === 'proposal' ? 'proposal' : key === 'award-letter' ? 'award-letter' : 'contract'
  const facts = [
    c.funder ? `Funded by ${c.funder}` : 'Funder not named yet',
    c.fundingSources.length ? c.fundingSources.join(', ') : null,
    c.periodStart && c.periodEnd
      ? `${shortDate(c.periodStart)} to ${shortDate(c.periodEnd)}`
      : null,
  ].filter(Boolean)
  const others = c.documents.filter(
    (d) => !d.period && !STEP_KINDS.includes(d.kind) && d.sensitivity !== 'personal'
  )
  const readinessTone = w.readiness.pct >= 90 ? 'ok' : w.readiness.pct >= 60 ? 'warn' : 'danger'

  // The stepper, and the two side cards that stay in view while it scrolls.
  const stepRows = w.steps.map((s) => (
    <Fragment key={s.key}>
      <StepRow
        step={s}
        canManage={c.canManage}
        onRecord={(kind, title) => setRecord({ kind, title })}
        onFact={() => setEditing(editFor(s.key))}
        onOpen={(d, kind) => openMenu(d, kind)}
      >
        {s.key === 'contract' && (
          <div id="budget" className="mt-3">
            <p className="ad-group-title">Approved budget · {money(budgetTotal)}</p>
            {c.budgetLines.length === 0 && (
              <p className="text-sm text-soft">No budget lines yet.</p>
            )}
            {c.budgetLines.length > 0 && (
              <table className="ad-table">
                <tbody>
                  {c.budgetLines
                    .filter((b) => b.amount > 0)
                    .map((b) => (
                      <tr key={b.category}>
                        <td>
                          <span className="font-semibold">
                            {BUDGET_CATEGORY_LABELS[b.category]}
                          </span>
                          <span className="ad-table-sub">
                            {b.narrative} · reports as {REPORT_LINE_LABELS[b.reportLine]}
                          </span>
                        </td>
                        <td className="ad-num">{money(b.amount)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            )}
          </div>
        )}
        {s.key === 'participants' && (
          <StepSummary
            rows={
              c.participants.length === 0
                ? []
                : summaryRows(s.records, (r) =>
                    setParticipantsOpen({ fileFor: r.key.split(':')[1] })
                  )
            }
            unit="participant"
            empty="No participants yet. Add each person the program serves the day they enroll."
            action={{ label: 'Participants', onClick: () => setParticipantsOpen({}) }}
            extra={
              c.canManage && (
                <Button size="sm" onClick={() => setAddingParticipant(true)}>
                  + Add participant
                </Button>
              )
            }
          />
        )}
        {(s.key === 'ledger' || s.key === 'submission') && (
          <StepSummary
            rows={summaryRows(s.records, (r) =>
              r.href?.startsWith('/reports/')
                ? navigate(r.href)
                : setMonthsOpen(s.key as 'ledger' | 'submission')
            )}
            unit="month"
            empty={
              c.periodStart
                ? 'No month has ended yet.'
                : 'Set the contract period (step 4) and the months appear here.'
            }
            action={{
              label: 'All months',
              onClick: () => setMonthsOpen(s.key as 'ledger' | 'submission'),
            }}
            extra={
              s.key === 'ledger' &&
              canAddMonth && (
                <Button size="sm" onClick={addMonth} disabled={!!busy}>
                  + Start {periodLabel(next)}
                </Button>
              )
            }
          />
        )}
        {s.key === 'audit' && (
          <div id="audit" className="mt-3 grid gap-4">
            <div>
              <div className="mb-1 flex justify-between text-sm">
                <span className="text-soft">Audit ready</span>
                <b>
                  {w.readiness.pct}% · {w.readiness.have} of {w.readiness.need} records
                </b>
              </div>
              <div className="ad-progress">
                <i style={{ width: `${w.readiness.pct}%` }} />
              </div>
            </div>
            <div>
              <p className="ad-group-title">What the auditor will ask for</p>
              <ul className="ad-checklist">
                {w.steps
                  .filter((s2) => s2.key !== 'audit')
                  .map((s2) => {
                    const have = s2.records.filter((r) => r.done).length
                    const all = s2.records.length > 0 && have === s2.records.length
                    return (
                      <li key={s2.key}>
                        <span className={`ad-check-dot ${all ? 'on' : ''}`} aria-hidden="true">
                          {all ? '✓' : s2.n}
                        </span>
                        <span>
                          <a href={`#${s2.key}`} className="text-ink no-underline hover:underline">
                            {s2.title}
                          </a>
                        </span>
                        <span className="whitespace-nowrap text-xs text-soft">
                          {have} of {s2.records.length}
                        </span>
                      </li>
                    )
                  })}
              </ul>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button kind="primary" size="sm" onClick={downloadPackage} disabled={!!busy}>
                Download the audit package
              </Button>
              <span className="text-xs text-soft">
                One zip, laid out like the funder's own package: records by step, each month with
                its ledger and proof, a participant list, eligibility files for owners and auditors,
                a README and an index. Every download is logged.
              </span>
            </div>
            {packageParts && (
              <div className="grid gap-2">
                <p className="text-sm">
                  This package is too big for one zip, so it comes in {packageParts.length} parts.
                  Download each one; each opens on its own.
                </p>
                {packageParts.map((p) => (
                  <div key={p.n} className="flex flex-wrap items-center gap-3">
                    <span className="text-sm">
                      Part {p.n} of {packageParts.length}
                    </span>
                    <Button
                      size="sm"
                      onClick={() => downloadPackagePart(p.n, p.fileName)}
                      disabled={!!busy}
                    >
                      Download
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </StepRow>
      {s.key === 'submission' && (
        <OtherRecordsRow
          docs={others}
          canManage={c.canManage}
          busy={!!busy}
          onAdd={() => setAddingOther(true)}
          onOpen={(d) => openMenu(d, d.kind)}
        />
      )}
    </Fragment>
  ))
  const hand = (
    <HandCard
      lead={`Your next step: ${w.current.n} · ${w.current.title}`}
      more={{ label: 'What the auditor asks for', href: '#audit' }}
    >
      <p>{w.current.help}</p>
    </HandCard>
  )
  const thisMonth = (
    <ThisMonth
      c={c}
      onStart={canAddMonth ? addMonth : undefined}
      onUpload={c.canManage ? setUpload : undefined}
    />
  )

  return (
    <>
      <nav className="ad-crumbs" aria-label="Breadcrumb">
        <Link to="/workspaces">Manage workspaces</Link> /{' '}
        <Link to={`/workspaces/${c.workspaceId}`}>{c.workspaceName}</Link> / {c.name}
      </nav>

      <section className="ad-card mb-4">
        <div className="ad-card-body !pt-5">
          <div className="grid gap-6 md:grid-cols-[1fr_auto]">
            <div>
              <p className="ad-eyebrow flex flex-wrap items-center gap-2">
                <Chip tone="muted">{ENGAGEMENT_KIND_LABELS[c.kind]}</Chip>
                {c.workspaceName}
                {c.number && (
                  <>
                    {' '}
                    · <span className="ad-mono normal-case tracking-normal">{c.number}</span>
                  </>
                )}
              </p>
              <h1 className="ad-h1">{c.name}</h1>
              <p className="ad-sub">{facts.join(' · ')}</p>
              <p className="mt-3 flex flex-wrap items-center gap-2 text-sm">
                <Chip tone={c.status === 'proposed' ? 'warn' : remaining < 0 ? 'danger' : 'ok'}>
                  {c.status}
                </Chip>
                {due && (
                  <span className="text-soft">
                    Next report: {periodLabel(due.period)}, due {shortDate(due.dueDate)}
                  </span>
                )}
                {c.canManage && (
                  <Button kind="ghost" size="sm" onClick={() => setEditing('all')}>
                    Edit details
                  </Button>
                )}
              </p>
            </div>
            <div className="ad-rule-v ad-figure md:min-w-[260px]">
              {c.awardAmount != null ? (
                <>
                  <p className="ad-eyebrow !mb-0 md:text-right">Award</p>
                  <p className="ad-tile-value md:text-right">{money(c.awardAmount)}</p>
                  <div className="ad-progress">
                    <i style={{ width: `${billedPct}%` }} />
                  </div>
                  <dl className="ad-figure-rows">
                    <dt>Billed</dt>
                    <dd>{money(c.cumulativeBilled)}</dd>
                    <dt>Remaining</dt>
                    <dd className={remaining < 0 ? 'text-danger' : ''}>{money(remaining)}</dd>
                  </dl>
                </>
              ) : (
                <>
                  <p className="ad-eyebrow !mb-0 md:text-right">Requested</p>
                  <p className="ad-tile-value md:text-right">
                    {c.requestedAmount != null ? money(c.requestedAmount) : '—'}
                  </p>
                  <dl className="ad-figure-rows">
                    <dt>Award</dt>
                    <dd>not received yet</dd>
                  </dl>
                </>
              )}
            </div>
          </div>
        </div>
      </section>

      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}

      <section className="ad-card mb-4">
        <div className="ad-card-body flex flex-wrap items-center gap-x-6 gap-y-3 !py-4">
          <div>
            <p className="ad-eyebrow !mb-0">Your workflow</p>
            <p className="text-lg font-extrabold text-navy">
              {w.doneCount}{' '}
              <span className="text-sm font-semibold text-soft">
                of {w.steps.length} steps complete
              </span>
            </p>
          </div>
          <div className="min-w-[200px] flex-1">
            <div className="ad-progress">
              <i style={{ width: `${(w.doneCount / w.steps.length) * 100}%` }} />
            </div>
          </div>
          <Chip tone={readinessTone}>{w.readiness.pct}% audit ready</Chip>
          {w.nextUp && (
            <span className="text-sm">
              <span className="ad-eyebrow mr-2 inline">Next up</span>
              <Link to={w.nextUp.href} className="font-semibold">
                {w.nextUp.label}
              </Link>
            </span>
          )}
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card
            eyebrow="From award to audit"
            title="Step by step"
            aside={<span>Keep each piece of the process in one place. Come back any time.</span>}
          >
            <ol className="ad-steps">{stepRows}</ol>
          </Card>
        </div>
        <div className="grid content-start gap-4 lg:sticky lg:top-4 lg:col-span-1 lg:self-start">
          {hand}
          {thisMonth}
        </div>
      </div>

      <DangerZone
        engagementId={c.id}
        workspaceId={c.workspaceId}
        name={c.name}
        onDeleted={() => navigate('/')}
      />

      {menu && (
        <DocumentMenuModal
          doc={menu.doc}
          canManage={c.canManage}
          replaceWith={{
            workspaceId: c.workspaceId,
            engagementId: c.id,
            kind: menu.kind,
            period: menu.period,
          }}
          onClose={() => setMenu(null)}
          onChanged={async () => {
            setMenu(null)
            await reload()
          }}
        />
      )}
      {record && (
        <RecordModal
          title={record.title}
          kind={record.kind}
          workspaceId={c.workspaceId}
          engagementId={c.id}
          waivers={c.waivers}
          onClose={() => setRecord(null)}
          onDone={async () => {
            setRecord(null)
            await reload()
          }}
        />
      )}
      {upload && (
        <AttachModal
          title={upload.title}
          workspaceId={c.workspaceId}
          engagementId={c.id}
          period={upload.period}
          defaultKind={upload.kind}
          kinds={[upload.kind]}
          uploadOnly
          onClose={() => setUpload(null)}
          onPick={async () => {
            setUpload(null)
            await reload()
          }}
        />
      )}
      {addingOther && (
        <AttachModal
          title="Add a document to this engagement"
          workspaceId={c.workspaceId}
          engagementId={c.id}
          period={null}
          defaultKind="other"
          kinds={OTHER_KINDS}
          uploadOnly
          onClose={() => setAddingOther(false)}
          onPick={async () => {
            setAddingOther(false)
            await reload()
          }}
        />
      )}
      {addingParticipant && (
        <AddParticipantModal
          engagementId={c.id}
          onClose={() => setAddingParticipant(false)}
          onAdded={async () => {
            setAddingParticipant(false)
            await reload()
          }}
        />
      )}
      {editing && (
        <EditEngagementModal
          engagement={c}
          focus={editing === 'all' ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null)
            await reload()
          }}
        />
      )}
      {participantsOpen && (
        <ParticipantsModal
          c={c}
          items={items}
          initialFileFor={participantsOpen.fileFor}
          onClose={() => setParticipantsOpen(null)}
          onAdd={() => setAddingParticipant(true)}
          onChanged={reload}
        />
      )}
      {monthsOpen && (
        <Modal
          title={w.steps.find((s) => s.key === monthsOpen)!.title}
          onClose={() => setMonthsOpen(null)}
          wide
        >
          <MonthsTable
            c={c}
            records={w.steps.find((s) => s.key === monthsOpen)!.records}
            kind={monthsOpen}
            onUpload={c.canManage ? setUpload : undefined}
            onOpen={(d, period) => openMenu(d, 'signed-report', period)}
            footer={
              monthsOpen === 'ledger' && canAddMonth ? (
                <Button size="sm" onClick={addMonth} disabled={!!busy}>
                  + Start {periodLabel(next)}
                </Button>
              ) : null
            }
          />
        </Modal>
      )}
    </>
  )
}

/** Owners only: delete this engagement for good (the role comes from the workspace list; nothing for anyone else). */
function DangerZone({
  engagementId,
  workspaceId,
  name,
  onDeleted,
}: {
  engagementId: string
  workspaceId: string
  name: string
  onDeleted: () => void
}) {
  const { data } = useLoad<WorkspaceDto[]>('/workspaces')
  const [open, setOpen] = useState(false)
  if (data?.find((w) => w.id === workspaceId)?.myRole !== 'owner') return null
  return (
    <div className="mt-8">
      <Card eyebrow="Danger zone" title="Delete this engagement">
        <p className="mb-3 text-sm text-soft">
          Deleting is permanent. You download a full export first, and every month, participant and
          document goes with it.
        </p>
        <Button kind="danger" onClick={() => setOpen(true)}>
          Delete this engagement…
        </Button>
      </Card>
      {open && (
        <DeleteModal
          target={{ kind: 'engagement', id: engagementId, name }}
          onClose={() => setOpen(false)}
          onDeleted={onDeleted}
        />
      )}
    </div>
  )
}

/** Between the signed reports and the audit package: anything that belongs to the engagement and to no step. */
function OtherRecordsRow({
  docs,
  canManage,
  busy,
  onAdd,
  onOpen,
}: {
  docs: DocumentDto[]
  canManage: boolean
  busy: boolean
  onAdd: () => void
  onOpen: (d: DocumentDto) => void
}) {
  return (
    <li id="other" className="ad-step ad-step-optional">
      <span className="ad-step-dot" aria-hidden="true">
        +
      </span>
      <div className="ad-step-body">
        <div className="ad-step-head">
          <span className="ad-step-n">Optional</span>
          <Chip tone="muted">{docs.length === 0 ? 'nothing yet' : `${docs.length} on file`}</Chip>
        </div>
        <h3 className="ad-step-title">Other records</h3>
        <p className="ad-step-blurb">
          A memorandum, a funder's notice, a note you want the auditor to see: anything that belongs
          to this engagement and to no single step. It goes in the audit package under Other
          records.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {docs.length > 0 && (
            <div className="ad-records !mt-0">
              {docs.map((d) => (
                <Chip key={d.id} tone="ok" title={`${d.fileName}: open, replace or remove`}>
                  <button type="button" onClick={() => onOpen(d)}>
                    ✓ {d.fileName}
                  </button>
                </Chip>
              ))}
            </div>
          )}
          {canManage && (
            <Button size="sm" onClick={onAdd} disabled={busy}>
              + Add a document
            </Button>
          )}
        </div>
      </div>
    </li>
  )
}

/** The rows a recurring step sums up: its records, with what blocks marked and where each gets fixed. */
function summaryRows(records: RecordItem[], go: (r: RecordItem) => void): SummaryRow[] {
  return records.map((r) => ({
    key: r.key,
    label: r.label,
    note: r.note,
    done: r.done,
    bad: !!r.note?.includes('blocking'),
    onClick: () => go(r),
  }))
}

function StepRow({
  step,
  canManage,
  onRecord,
  onFact,
  onOpen,
  children,
}: {
  step: Step
  canManage: boolean
  onRecord: (kind: DocumentKind, title: string) => void
  onFact: () => void
  onOpen: (d: DocumentDto, kind: DocumentKind) => void
  children?: React.ReactNode
}) {
  // These steps draw their own records below the blurb.
  const custom = step.key === 'ledger' || step.key === 'submission' || step.key === 'participants'
  const stateChip =
    step.state === 'done' ? (
      <Chip tone="ok">complete</Chip>
    ) : step.state === 'current' ? (
      <Chip tone="accent" fill>
        you are here
      </Chip>
    ) : step.state === 'later' ? (
      <Chip tone="muted">later</Chip>
    ) : (
      <Chip tone="warn">to do</Chip>
    )
  return (
    <li id={step.key} className={`ad-step ad-step-${step.state}`}>
      <span className="ad-step-dot" aria-hidden="true">
        {step.state === 'done' ? '✓' : step.n}
      </span>
      <div className="ad-step-body">
        <div className="ad-step-head">
          <span className="ad-step-n">Step {step.n}</span>
          {stateChip}
        </div>
        <h3 className="ad-step-title">{step.title}</h3>
        <p className="ad-step-blurb">{step.blurb}</p>
        {!custom && (
          <div className="ad-records">
            {step.records.map((r) => (
              <RecordChip
                key={r.key}
                r={r}
                canManage={canManage}
                onRecord={onRecord}
                onFact={onFact}
                onOpen={onOpen}
              />
            ))}
          </div>
        )}
        {children}
      </div>
    </li>
  )
}

function RecordChip({
  r,
  canManage,
  onRecord,
  onFact,
  onOpen,
}: {
  r: RecordItem
  canManage: boolean
  onRecord: (kind: DocumentKind, title: string) => void
  onFact: () => void
  onOpen: (d: DocumentDto, kind: DocumentKind) => void
}) {
  if (r.waived)
    return (
      <Chip tone="muted" title={r.note}>
        {canManage && r.kind ? (
          <button type="button" onClick={() => onRecord(r.kind!, r.label)}>
            — {r.label}
          </button>
        ) : (
          <>— {r.label}</>
        )}
        {r.note && <span className="font-medium normal-case tracking-normal"> · {r.note}</span>}
      </Chip>
    )
  if (r.done)
    return (
      <Chip
        tone="ok"
        title={r.document ? `${r.document.fileName}: open, replace or remove` : undefined}
      >
        {r.document ? (
          <button type="button" onClick={() => onOpen(r.document!, r.kind ?? r.document!.kind)}>
            ✓ {r.label}
          </button>
        ) : (
          <>✓ {r.label}</>
        )}
        {r.note && <span className="font-medium normal-case tracking-normal"> · {r.note}</span>}
      </Chip>
    )
  if (r.kind && canManage)
    return (
      <button
        type="button"
        className="ad-chip ad-chip-missing"
        onClick={() => onRecord(r.kind!, r.label)}
      >
        + {r.label}
      </button>
    )
  if (r.field && canManage)
    return (
      <button type="button" className="ad-chip ad-chip-missing" onClick={onFact}>
        + {r.label}
      </button>
    )
  // A record on this page: a plain anchor scrolls to its step; a Link would not.
  const hash = r.href?.includes('#') ? `#${r.href.split('#')[1]}` : null
  return (
    <Chip tone="warn">
      {hash ? <a href={hash}>{r.label}</a> : r.href ? <Link to={r.href}>{r.label}</Link> : r.label}
      {r.note && <span className="font-medium normal-case tracking-normal"> · {r.note}</span>}
    </Chip>
  )
}

/** The months of a recurring step: one row each, with where it stands and what to do. */
function MonthsTable({
  c,
  records,
  kind,
  onUpload,
  onOpen,
  footer,
}: {
  c: EngagementDetail
  records: RecordItem[]
  kind: 'ledger' | 'submission'
  onUpload?: (u: Upload) => void
  onOpen: (d: DocumentDto, period: string) => void
  footer: React.ReactNode
}) {
  const owed = new Set(records.map((r) => r.key.split(':')[1]))
  const ahead = c.reports.filter((r) => !owed.has(r.period))
  return (
    <div className="mt-2">
      {records.length === 0 && ahead.length === 0 && (
        <p className="text-sm text-soft">
          {c.periodStart
            ? 'No month has ended yet.'
            : 'Set the contract period (step 4) and the months appear here.'}
        </p>
      )}
      {(records.length > 0 || ahead.length > 0) && (
        <table className="ad-table">
          <tbody>
            {records.map((r) => {
              const period = r.key.split(':')[1]
              const report = c.reports.find((x) => x.period === period)
              return (
                <tr key={r.key}>
                  <td className="w-8">
                    <span className={`ad-check-dot ${r.done ? 'on' : 'bad'}`} aria-hidden="true">
                      {r.done ? '✓' : '!'}
                    </span>
                  </td>
                  <td className="font-semibold">
                    {report ? (
                      <Link
                        to={`/reports/${report.id}`}
                        className="text-navy no-underline hover:underline"
                      >
                        {r.label}
                      </Link>
                    ) : (
                      r.label
                    )}
                  </td>
                  <td>{report && <StatusChip status={report.status} />}</td>
                  <td className={r.done ? 'text-soft' : 'font-semibold text-danger'}>{r.note}</td>
                  <td className="ad-num">
                    {kind === 'submission' && report && !r.document && onUpload && (
                      <button
                        type="button"
                        className="ad-chip ad-chip-missing"
                        onClick={() =>
                          onUpload({
                            kind: 'signed-report',
                            period,
                            title: `Signed report for ${r.label}`,
                          })
                        }
                      >
                        + signed copy
                      </button>
                    )}
                    {kind === 'submission' && r.document && (
                      <Chip tone="ok" title={`${r.document.fileName}: open, replace or remove`}>
                        <button type="button" onClick={() => onOpen(r.document!, period)}>
                          ✓ signed copy
                        </button>
                      </Chip>
                    )}
                  </td>
                </tr>
              )
            })}
            {ahead.map((r) => (
              <tr key={r.id}>
                <td className="w-8">
                  <span className="ad-check-dot" aria-hidden="true" />
                </td>
                <td className="font-semibold">
                  <Link to={`/reports/${r.id}`} className="text-navy no-underline hover:underline">
                    {periodLabel(r.period)}
                  </Link>
                </td>
                <td>
                  <StatusChip status={r.status} />
                </td>
                <td className="text-soft">in progress · due {shortDate(r.dueDate)}</td>
                <td></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {footer && <div className="mt-3">{footer}</div>}
    </div>
  )
}

/** The month that needs you now, as a checklist. */
function ThisMonth({
  c,
  onStart,
  onUpload,
}: {
  c: EngagementDetail
  onStart?: () => void
  onUpload?: (u: Upload) => void
}) {
  const today = new Date()
  const due = nextDue(c, today)
  if (!due) return null
  const r = due.report
  const signed = c.documents.find((d) => d.kind === 'signed-report' && d.period === due.period)
  const days = daysUntil(due.dueDate, today)
  const items: { label: string; done: boolean; bad?: boolean; note?: string }[] = [
    { label: 'Month started', done: !!r },
    {
      label: 'Expenses recorded',
      done: !!r && r.expenseCount > 0,
      note: r ? `${r.expenseCount} so far` : undefined,
    },
    {
      label: 'Proof complete, nothing blocking',
      done: !!r && r.expenseCount > 0 && r.openBlockers === 0,
      bad: !!r && r.openBlockers > 0,
      note: r && r.openBlockers > 0 ? `${r.openBlockers} blocking` : undefined,
    },
    { label: 'Signed report on file', done: !!signed },
    { label: `Submitted to ${c.funder ?? 'the funder'}`, done: !!r && r.status !== 'draft' },
    {
      label: "Funder's decision recorded",
      done: !!r && (r.status === 'approved' || r.status === 'paid' || r.status === 'denied'),
    },
  ]
  const ready = items.filter((i) => i.done).length
  return (
    <Card
      title={`${periodLabel(due.period)} financials`}
      aside={
        <Chip tone={days < 0 ? 'danger' : days <= 7 ? 'warn' : 'muted'} fill={days < 0}>
          due {shortDate(due.dueDate)}
        </Chip>
      }
    >
      <div className="mb-1 flex justify-between text-sm">
        <span className="text-soft">Report checklist</span>
        <b>
          {ready} of {items.length} ready
        </b>
      </div>
      <div className="ad-progress mb-3">
        <i style={{ width: `${(ready / items.length) * 100}%` }} />
      </div>
      <ul className="ad-checklist">
        {items.map((i) => (
          <li key={i.label}>
            <span
              className={`ad-check-dot ${i.done ? 'on' : i.bad ? 'bad' : ''}`}
              aria-hidden="true"
            >
              {i.done ? '✓' : i.bad ? '!' : ''}
            </span>
            <span>
              {i.label}
              {i.note && <span className="ad-table-sub">{i.note}</span>}
            </span>
          </li>
        ))}
      </ul>
      <div className="mt-4 flex flex-wrap gap-2">
        {r ? (
          <Link to={`/reports/${r.id}`} className="ad-btn ad-btn-sm">
            Open {periodLabel(due.period)}
          </Link>
        ) : onStart ? (
          <Button kind="primary" size="sm" onClick={onStart}>
            Start {periodLabel(due.period)}
          </Button>
        ) : null}
        {r && !signed && onUpload && (
          <Button
            size="sm"
            onClick={() =>
              onUpload({
                kind: 'signed-report',
                period: due.period,
                title: `Signed report for ${periodLabel(due.period)}`,
              })
            }
          >
            Attach signed copy
          </Button>
        )}
      </div>
      <p className="mt-3 text-xs text-soft">
        Reports are due on the {c.reportDueDay}th unless another date was agreed by email.
      </p>
    </Card>
  )
}
