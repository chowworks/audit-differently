import type { DocumentDto, DocumentKind, EngagementSummary, ReportSummary } from '@ad/types'
import {
  DEFAULT_ELIGIBILITY_ITEMS,
  ENGAGEMENT_TRACKS,
  type EligibilityItemDef,
  type EngagementTrack,
  type ParticipantDto,
} from '@ad/types'
import { periodLabel, shortDate } from './format'

/**
 * The eight steps a team walks for each engagement, from the proposal to the final audit, read off the
 * records on file. Pure: give it an engagement (and its participants when you have them) and it says which
 * step you are on, what is still missing, and how ready for the audit the engagement is.
 */
export type StepKey =
  | 'proposal'
  | 'award-letter'
  | 'budget-narrative'
  | 'contract'
  | 'participants'
  | 'ledger'
  | 'submission'
  | 'audit'

/** `skipped`: a record the engagement does not keep (`tracks`); greyed out and counted nowhere. */
export type StepState = 'done' | 'current' | 'todo' | 'later' | 'skipped'

export interface RecordItem {
  key: string
  label: string
  /** What to do about it, in plain words: the overview's "records to check" and "next up" read this. */
  task: string
  done: boolean
  /** Where to go to add or fix it. */
  href?: string
  /** A document kind to upload when the record is a file. */
  kind?: DocumentKind
  document?: DocumentDto
  note?: string
  /** A fact to fill in on the engagement itself (not a file). */
  field?: boolean
  /** The record does not exist for this engagement; the reason is the record. */
  waived?: boolean
  /** When one record stands for several (every participant's file on the overview), what it counts as. */
  count?: { have: number; need: number }
}

export interface Step {
  key: StepKey
  n: number
  title: string
  blurb: string
  /** What to keep, in plain words, for the "Need a hand?" card. */
  help: string
  state: StepState
  records: RecordItem[]
}

export interface Workflow {
  steps: Step[]
  doneCount: number
  /** The steps this engagement uses: all eight, less the ones before where it starts. */
  total: number
  current: Step
  readiness: { have: number; need: number; pct: number }
  nextUp: { label: string; href: string } | null
}

const STEP_TEXT: Record<StepKey, { title: string; blurb: string; help: string }> = {
  proposal: {
    title: 'Proposal',
    blurb: 'Your proposal and the budget you asked for, as you sent them to the funder.',
    help: 'Keep the proposal exactly as you sent it. The auditor compares what you asked for with what was awarded and what you spent.',
  },
  'award-letter': {
    title: 'Award letter',
    blurb: 'The letter that confirms your scope and funding. It is often less than you asked for.',
    help: 'The award letter sets the amount every later number is checked against. If it came by email, save the email as a PDF too.',
  },
  'budget-narrative': {
    title: 'Budget narrative',
    blurb: "The funder's narrative form: one line per approved budget category, in your words.",
    help: "Fill the funder's form, then save the completed copy here. Each line should match a category on the approved budget.",
  },
  contract: {
    title: 'Contract and approved budget',
    blurb:
      'The signed agreement, its dates, and the budget lines it approves. Every month reports against these.',
    help: 'Check the budget lines against the contract before the first month. If a line is wrong now, every monthly report inherits it.',
  },
  participants: {
    title: 'Participants and eligibility',
    blurb:
      'Each person the program serves, with the eligibility data required for the audit. Satisfy it the day they enroll.',
    help: 'Add each participant the day they enroll and attach each eligibility item as it arrives. The review reads this file beside the payroll proof of step 6. Personal records: download only, every read logged.',
  },
  ledger: {
    title: 'Monthly ledger and proof',
    blurb:
      'Each month: record what you spent against the approved lines and attach the proof as you go.',
    help: 'For each expense the auditor wants the invoice, the proof it was paid, and the allocation worksheet when a cost is shared. Attach them the day you record the expense and the month is ready for its month-end closing.',
  },
  submission: {
    title: 'Signed report, submitted by the due day',
    blurb:
      "Get the month-end closing approved, then sign the funder's form, keep the signed copy with the month, and submit it by the due day.",
    help: "The month-end closing is your company's own approval of the month, usually your CEO's, often given offline: record who approved it and when. Then the report goes to the funder. Reports are due on the 12th unless another date was agreed by email. Keep that email with the month if the date moved.",
  },
  audit: {
    title: 'Final audit package',
    blurb:
      'At program end the auditor asks for everything above. It is already here: add the letter and download the package.',
    help: 'Nothing new to produce: the audit package is the records you kept along the way. Use the months before program end to close any gap on this page.',
  },
}

/** What to do about a missing file, in plain words. */
const FILE_TASK: Partial<Record<DocumentKind, string>> = {
  proposal: 'Upload the proposal as you sent it',
  'award-letter': 'Upload the award letter, or mark that none was issued',
  'budget-narrative':
    'Upload the completed budget narrative, or mark that this funder does not use one',
  contract: 'Upload the signed contract',
  'audit-letter': 'Write the letter to the auditors and upload it',
}

const monthOf = (iso: string) => iso.slice(0, 7)
const nextMonth = (p: string) => {
  const [y, m] = p.split('-').map(Number)
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
}
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** Months of the contract that have ended before `today`, in order. None until the period is set. */
export function expectedPeriods(c: EngagementSummary, today: Date): string[] {
  if (!c.periodStart || !c.periodEnd) return []
  const start = monthOf(c.periodStart)
  const last = monthOf(c.periodEnd)
  const current = today.toISOString().slice(0, 7)
  const out: string[] = []
  for (let p = start; p <= last && p < current; p = nextMonth(p)) out.push(p)
  return out
}

const submitted = (r: ReportSummary) => r.status === 'submitted'
const closed = (r: ReportSummary) => r.status !== 'draft'

/** The required items of the checklist a participant still lacks. */
export function missingItems(p: ParticipantDto, items: EligibilityItemDef[]): EligibilityItemDef[] {
  const have = new Set(p.documents.map((d) => d.purpose))
  return items.filter((i) => i.required && !have.has(i.key))
}

export function eligibilityComplete(
  p: ParticipantDto,
  items: EligibilityItemDef[] = DEFAULT_ELIGIBILITY_ITEMS
): boolean {
  return missingItems(p, items).length === 0
}

/**
 * The month's signed copy that counts: the newest one uploaded after its latest reopening (any, if it was never
 * reopened). An older one is the copy that was submitted before the month was reopened, kept as history.
 */
export function signedCopyOf(
  documents: DocumentDto[],
  period: string,
  lastReopenedAt?: string | null
): DocumentDto | undefined {
  let found: DocumentDto | undefined
  for (const d of documents)
    if (
      d.kind === 'signed-report' &&
      d.period === period &&
      (!lastReopenedAt || d.uploadedAt > lastReopenedAt) &&
      (!found || d.uploadedAt > found.uploadedAt)
    )
      found = d
  return found
}

export function workflow(
  c: EngagementSummary,
  participants: ParticipantDto[] | null,
  today = new Date(),
  items: EligibilityItemDef[] = DEFAULT_ELIGIBILITY_ITEMS
): Workflow {
  const here = `/engagements/${c.id}`
  const doc = (kind: DocumentKind, period: string | null = null) =>
    c.documents.find((d) => d.kind === kind && (d.period ?? null) === period)
  const file = (key: StepKey, kind: DocumentKind, label: string): RecordItem => {
    const d = doc(kind)
    const reason = c.waivers?.[kind]
    const task = FILE_TASK[kind] ?? `Upload the ${label.toLowerCase()}`
    if (!d && reason)
      return {
        key: `${key}:${kind}`,
        label,
        task,
        done: true,
        waived: true,
        kind,
        note: `not issued: ${reason}`,
        href: `${here}#${key}`,
      }
    return {
      key: `${key}:${kind}`,
      label,
      task,
      done: !!d,
      kind,
      document: d,
      href: `${here}#${key}`,
    }
  }
  const fact = (
    key: StepKey,
    name: string,
    label: string,
    task: string,
    done: boolean,
    note?: string
  ): RecordItem => ({
    key: `${key}:${name}`,
    label,
    task,
    done,
    field: true,
    note,
    href: `${here}#${key}`,
  })
  const kept = (t: EngagementTrack) => (c.tracks ?? ENGAGEMENT_TRACKS).includes(t)
  const periods = expectedPeriods(c, today)
  const started = periods.length > 0
  const ended = !!c.periodEnd && monthOf(c.periodEnd) < today.toISOString().slice(0, 7)
  const byPeriod = new Map(c.reports.map((r) => [r.period, r]))

  const ledgerRecords: RecordItem[] = periods.map((p) => {
    const r = byPeriod.get(p)
    const month = periodLabel(p)
    if (!r)
      return {
        key: `ledger:${p}`,
        label: month,
        task: `Start ${month} and record its expenses`,
        done: false,
        note: 'month not started',
        href: `${here}#ledger`,
      }
    const done = r.expenseCount > 0 && r.openBlockers === 0
    return {
      key: `ledger:${p}`,
      label: month,
      done,
      href: `/reports/${r.id}`,
      task:
        r.expenseCount === 0
          ? `Record the ${month} expenses and attach the proof`
          : r.openBlockers > 0
            ? `Clear ${plural(r.openBlockers, 'blocking check')} on ${month}`
            : r.openAttention > 0
              ? `Look at ${plural(r.openAttention, 'check')} on ${month}`
              : `${month} is complete`,
      note:
        r.expenseCount === 0
          ? 'no expenses yet'
          : r.openBlockers > 0
            ? `${r.openBlockers} blocking`
            : r.openAttention > 0
              ? `${r.openAttention} to look at`
              : `${r.expenseCount} expenses, proof complete`,
    }
  })

  const submissionRecords: RecordItem[] = periods.map((p) => {
    const r = byPeriod.get(p)
    const month = periodLabel(p)
    const signed = signedCopyOf(c.documents, p, r?.lastReopenedAt)
    const isSubmitted = !!r && submitted(r)
    const late = !!r && !!r.submittedAt && r.submittedAt > r.dueDate
    const done = isSubmitted && !!signed
    return {
      key: `submission:${p}`,
      label: month,
      done,
      href: r ? `/reports/${r.id}` : `${here}#ledger`,
      kind: 'signed-report',
      document: signed,
      task: !r
        ? `Start ${month} before its report is due`
        : !closed(r)
          ? `Get the ${month} month-end closing approved`
          : !signed
            ? `Save the signed copy of the ${month} report`
            : !isSubmitted
              ? `Submit the ${month} report by ${shortDate(r.dueDate)}`
              : `${month} is submitted`,
      note: !r
        ? 'month not started'
        : !closed(r)
          ? 'month-end closing not approved'
          : !signed
            ? isSubmitted
              ? 'submitted, signed copy not on file'
              : 'closing approved, signed copy not on file'
            : !isSubmitted
              ? 'signed, not submitted'
              : late
                ? 'submitted late'
                : 'submitted',
    }
  })

  // Step 5: one record per participant when they are known (the engagement page); the overview works
  // from the summary's counts and keeps one record that counts for all of them.
  const participantsHref = `${here}#participants`
  const firstParticipant: RecordItem = {
    key: 'participants:first',
    label: 'First participant enrolled',
    task: 'Add the first participant and open their eligibility file',
    done: false,
    note: 'none yet',
    href: participantsHref,
  }
  const participantRecords: RecordItem[] = participants
    ? participants.length === 0
      ? [firstParticipant]
      : participants.map((p) => {
          const missing = missingItems(p, items)
          const named = missing.slice(0, 2).map((i) => i.label.toLowerCase())
          return {
            key: `participants:${p.id}`,
            label: p.displayName,
            done: missing.length === 0,
            note: missing.length === 0 ? undefined : `${plural(missing.length, 'item')} missing`,
            href: participantsHref,
            task:
              missing.length === 0
                ? `${p.displayName}'s eligibility file is complete`
                : `Complete ${p.displayName}'s eligibility file: ${named.join(', ')}${missing.length > 2 ? ` and ${missing.length - 2} more` : ''}`,
          }
        })
    : c.participantCount === 0
      ? [firstParticipant]
      : [
          {
            key: 'participants:files',
            label: 'Eligibility file per participant',
            done: c.participantsComplete === c.participantCount,
            note: `${c.participantsComplete} of ${c.participantCount} complete`,
            href: participantsHref,
            count: { have: c.participantsComplete, need: c.participantCount },
            task:
              c.participantsComplete === c.participantCount
                ? 'Every eligibility file is complete'
                : `Complete the eligibility ${c.participantCount - c.participantsComplete === 1 ? 'file' : 'files'} of ${plural(c.participantCount - c.participantsComplete, 'participant')}`,
          },
        ]
  const enrolled = participants ? participants.length > 0 : c.participantCount > 0

  const auditRecords: RecordItem[] = [
    file('audit', 'audit-letter', 'Letter to the auditors'),
    {
      key: 'audit:index',
      label: 'Records index for the auditor',
      task: 'Download the audit package when the program ends',
      done: false,
      note: 'builds itself from the steps above',
      href: `${here}#audit`,
    },
  ]

  const defs: { key: StepKey; records: RecordItem[]; state: StepState }[] = [
    {
      key: 'proposal',
      records: [
        file('proposal', 'proposal', 'Proposal as submitted'),
        fact(
          'proposal',
          'requested',
          'Amount requested',
          'Enter the amount you asked for',
          c.requestedAmount != null
        ),
      ],
      state: 'todo',
    },
    {
      key: 'award-letter',
      records: [
        file('award-letter', 'award-letter', 'Award letter'),
        fact(
          'award-letter',
          'amount',
          'Award amount and funder',
          'Enter the award amount and who awarded it',
          c.awardAmount != null && !!c.funder
        ),
      ],
      state: 'todo',
    },
    {
      key: 'budget-narrative',
      records: [file('budget-narrative', 'budget-narrative', 'Completed budget narrative')],
      state: 'todo',
    },
    {
      key: 'contract',
      records: [
        ...(kept('contract') ? [file('contract', 'contract', 'Signed contract')] : []),
        fact(
          'contract',
          'period',
          'Contract number and period',
          'Enter the contract number and its start and end dates',
          !!c.number && !!c.periodStart && !!c.periodEnd
        ),
        fact(
          'contract',
          'budget',
          'Approved budget lines',
          'Enter the approved budget lines',
          c.budgetLineCount > 0,
          c.budgetLineCount > 0 ? `${c.budgetLineCount} lines` : undefined
        ),
      ],
      state: 'todo',
    },
    {
      key: 'participants',
      records: participantRecords,
      state: started || enrolled ? 'todo' : 'later',
    },
    { key: 'ledger', records: ledgerRecords, state: started ? 'todo' : 'later' },
    { key: 'submission', records: submissionRecords, state: started ? 'todo' : 'later' },
    { key: 'audit', records: auditRecords, state: ended ? 'todo' : 'later' },
  ]

  // Done when every record is in; the first step not done is where you are.
  let currentSet = false
  const steps: Step[] = defs.map((d, i) => {
    if ((d.key === 'proposal' || d.key === 'award-letter') && !kept(d.key))
      return { key: d.key, n: i + 1, ...STEP_TEXT[d.key], state: 'skipped', records: d.records }
    const allDone = d.records.length > 0 && d.records.every((r) => r.done)
    let state: StepState = d.state
    if (allDone) state = 'done'
    else if (d.state !== 'later' && !currentSet) {
      state = 'current'
      currentSet = true
    }
    // The recurring steps stay "current" while the engagement runs, even when every month so far is clean.
    if (
      (d.key === 'participants' || d.key === 'ledger' || d.key === 'submission') &&
      started &&
      !ended &&
      allDone
    )
      state = currentSet ? 'done' : 'current'
    return { key: d.key, n: i + 1, ...STEP_TEXT[d.key], state, records: d.records }
  })
  const current = steps.find((s) => s.state === 'current') ?? steps[steps.length - 1]
  const doneCount = steps.filter((s) => s.state === 'done').length
  const total = steps.filter((s) => s.state !== 'skipped').length

  // Readiness: records that exist today over records the audit will ask for today (the index itself excluded).
  const counted = steps
    .filter((s) => s.state !== 'skipped')
    .flatMap((s) => s.records)
    .filter((r) => r.key !== 'audit:index')
  const have = counted.reduce((t, r) => t + (r.count ? r.count.have : r.done ? 1 : 0), 0)
  const need = counted.reduce((t, r) => t + (r.count ? r.count.need : 1), 0)
  const pct = need === 0 ? 0 : Math.round((have / need) * 100)

  const next = current.records.find((r) => !r.done)
  const nextUp = next ? { label: next.task, href: next.href ?? here } : null

  return { steps, doneCount, total, current, readiness: { have, need, pct }, nextUp }
}

/** The next report that is still owed: its month, due date and, if it exists, the report. */
export function nextDue(
  c: EngagementSummary,
  today = new Date()
): { period: string; dueDate: string; report: ReportSummary | null } | null {
  if (!c.periodStart || !c.periodEnd) return null
  const periods = expectedPeriods(c, today)
  for (const p of periods) {
    const r = c.reports.find((x) => x.period === p)
    if (!r || !submitted(r)) {
      const due = r ? r.dueDate : dueDateFor(p, 12)
      return { period: p, dueDate: due, report: r ?? null }
    }
  }
  // Nothing owed from the past: the month running now, due next month.
  const current = today.toISOString().slice(0, 7)
  if (current <= monthOf(c.periodEnd) && current >= monthOf(c.periodStart)) {
    const r = c.reports.find((x) => x.period === current)
    return { period: current, dueDate: r ? r.dueDate : dueDateFor(current, 12), report: r ?? null }
  }
  return null
}

function dueDateFor(period: string, day: number): string {
  const [y, m] = nextMonth(period).split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, day)).toISOString()
}

export const daysUntil = (iso: string, today = new Date()) =>
  Math.ceil((new Date(iso).getTime() - today.getTime()) / 86400000)
