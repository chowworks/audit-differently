// Shared vocabulary for the API and the web app. Statuses and kinds are strings (not database enums) so
// adding one needs no migration; the allowed values are listed here once.

// ── Monthly financial report lines ──────────────────────────────────────────
// The seven lines of the agency's monthly financial report, in the order they appear on the form.

export const REPORT_LINES = [
  'staff-salaries',
  'staff-fringe',
  'program-costs',
  'participant-wages',
  'participant-fringes',
  'wex',
  'indirect',
] as const
export type ReportLine = (typeof REPORT_LINES)[number]

export const REPORT_LINE_LABELS: Record<ReportLine, string> = {
  'staff-salaries': 'Staff Salaries',
  'staff-fringe': 'Staff Fringe Benefits',
  'program-costs': 'Program Costs',
  'participant-wages': 'Participant Wages',
  'participant-fringes': 'Participant Fringes',
  wex: 'WEX',
  indirect: 'Indirect for Parent Org.',
}

/** Lines the form marks "Work Experience for 9130" (the federal financial report). */
export const WEX_REPORT_LINES: ReadonlySet<ReportLine> = new Set([
  'participant-wages',
  'participant-fringes',
  'wex',
])

/** Lines whose proof is a timesheet and a payroll register rather than an invoice. */
export const PAYROLL_REPORT_LINES: ReadonlySet<ReportLine> = new Set([
  'staff-salaries',
  'staff-fringe',
  'participant-wages',
  'participant-fringes',
  'wex',
])

// ── Budget lines ─────────────────────────────────────────────────────────────
// An engagement's approved budget is its own list of budget lines (BudgetLine), each on one line of the funder's
// monthly report above.

/**
 * The payroll the match proves, as it lands on the budget (owner's decision, 2026-10-20, #22): each kind on the one
 * budget line of the engagement that holds it, ticked on that line.
 */
export const PAYROLL_BUDGET_KINDS = [
  'staff-pay',
  'staff-taxes',
  'participant-pay',
  'participant-taxes',
] as const
export type PayrollBudgetKind = (typeof PAYROLL_BUDGET_KINDS)[number]
export const PAYROLL_BUDGET_KIND_LABELS: Record<PayrollBudgetKind, string> = {
  'staff-pay': 'Staff pay',
  'staff-taxes': 'Staff taxes and benefits',
  'participant-pay': 'Participant pay',
  'participant-taxes': 'Participant taxes',
}

/** Which report lines take each payroll kind when nothing was ticked yet, first choice first (migration 20261020000100). */
export const PAYROLL_BUDGET_DEFAULTS: Record<PayrollBudgetKind, ReportLine[]> = {
  'staff-pay': ['staff-salaries'],
  'staff-taxes': ['staff-fringe', 'staff-salaries'],
  'participant-pay': ['wex', 'participant-wages'],
  'participant-taxes': ['participant-fringes', 'wex', 'participant-wages'],
}

/** The payroll each of an engagement's lines holds by default: each kind on its first-choice line, in the lines' order. */
export function payrollDefaults(lines: { reportLine: string }[]): PayrollBudgetKind[][] {
  const out = lines.map((): PayrollBudgetKind[] => [])
  for (const kind of PAYROLL_BUDGET_KINDS)
    for (const want of PAYROLL_BUDGET_DEFAULTS[kind]) {
      const at = lines.findIndex((l) => l.reportLine === want)
      if (at >= 0) {
        out[at]!.push(kind)
        break
      }
    }
  return out
}

/** A budget line as a choice (the import's mapping): `key` is the line's id. */
export interface BudgetOption {
  key: string
  label: string
  reportLine: ReportLine
}

/**
 * A budget line as the budget section adds or changes it: the line as the contract's approved budget names it, the line
 * of the funder's monthly form it rolls up to (fixed once it has spending), its approved amount and a short note.
 */
export interface BudgetLineInput {
  name?: string
  reportLine?: ReportLine
  amount?: number | null
  narrative?: string | null
  /** The payroll from the match this line holds; ticking a kind here moves it off the line that held it. */
  payroll?: PayrollBudgetKind[]
}

/**
 * What a budget change answers: the engagement, and the closed and submitted months it put back to draft (a closed one
 * sent back, a submitted one reopened), whose closing is approved again and which are sent again.
 */
export interface BudgetChange extends EngagementDetail {
  backToDraft: { id: string; period: string; was: 'closed' | 'submitted' }[]
}

// ── Expenses and documents ──────────────────────────────────────────────────

export const ALLOCATION_TYPES = ['direct', 'payroll', 'usage'] as const
export type AllocationType = (typeof ALLOCATION_TYPES)[number]
/** How the expense form and the access log name each allocation type. */
export const ALLOCATION_TYPE_LABELS: Record<AllocationType, string> = {
  direct: 'Direct (all of it)',
  payroll: 'Shared, by payroll hours',
  usage: 'Shared, by usage',
}

export const DOCUMENT_KINDS = [
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
  'paystub',
  'payroll-details',
  'enrollment-form',
  'eligibility-record',
  'proposal',
  'award-letter',
  'budget-narrative',
  'contract',
  'mou',
  'signed-report',
  'audit-letter',
  'other',
] as const
export type DocumentKind = (typeof DOCUMENT_KINDS)[number]

/** A document kind in plain words, as the access log says it. */
export const DOCUMENT_KIND_LABELS: Record<DocumentKind, string> = {
  invoice: 'invoice',
  receipt: 'receipt',
  'purchase-order': 'purchase order',
  'bank-statement': 'bank statement',
  'card-statement': 'card statement',
  'eft-confirmation': 'EFT confirmation',
  'cancelled-check': 'cancelled check',
  'allocation-calculation': 'allocation worksheet',
  'payroll-register': 'payroll register',
  timesheet: 'timesheet',
  paystub: 'pay stub',
  'payroll-details': 'payroll details',
  'enrollment-form': 'enrollment form',
  'eligibility-record': 'eligibility record',
  proposal: 'proposal',
  'award-letter': 'award letter',
  'budget-narrative': 'budget narrative',
  contract: 'contract',
  mou: 'MOU',
  'signed-report': 'signed report',
  'audit-letter': 'letter to the auditors',
  other: 'document',
}

/**
 * How a document may be served (CLAUDE.md, "Data rules"). 'personal' documents identify a participant: they
 * get the shortest signed URLs, always download, are never previewed, and are visible to agency roles and
 * provider admins only.
 */
export type DocumentSensitivity = 'financial' | 'personal'

export const DOCUMENT_SENSITIVITY: Record<DocumentKind, DocumentSensitivity> = {
  invoice: 'financial',
  receipt: 'financial',
  'purchase-order': 'financial',
  'bank-statement': 'financial',
  'card-statement': 'financial',
  'eft-confirmation': 'financial',
  'cancelled-check': 'financial',
  'allocation-calculation': 'financial',
  'payroll-register': 'financial',
  timesheet: 'financial',
  paystub: 'personal',
  'payroll-details': 'personal',
  'enrollment-form': 'personal',
  'eligibility-record': 'personal',
  proposal: 'financial',
  'award-letter': 'financial',
  'budget-narrative': 'financial',
  contract: 'financial',
  mou: 'financial',
  'signed-report': 'financial',
  'audit-letter': 'financial',
  other: 'financial',
}

/**
 * The kinds that are a month's ledger proof (receipts, invoices, proof of payment, allocation and payroll records).
 * Filed under a month, they are added, replaced or removed only while that month is a draft; the signed report and
 * every other kind stay open in any status.
 */
export const MONTH_PROOF_KINDS = [
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
  'paystub',
  'payroll-details',
] as const satisfies readonly DocumentKind[]

/** Why a document is attached to an expense or a work-experience payment. */
export const DOCUMENT_PURPOSES = [
  'invoice',
  'payment',
  'allocation',
  'timesheet',
  'register',
  'other',
] as const
export type DocumentPurpose = (typeof DOCUMENT_PURPOSES)[number]
/** How the funder's monitoring review names each kind of proof. */
export const DOCUMENT_PURPOSE_LABELS: Record<DocumentPurpose, string> = {
  invoice: 'Invoice',
  payment: 'Evidence of payment',
  allocation: 'Allocation worksheet',
  timesheet: 'Timesheet',
  register: 'Payroll register',
  other: 'Other',
}

/**
 * The items of a participant's eligibility file, as the agency's own WIOA eligibility checklist names them.
 * A ParticipantDocument's purpose is one of these. 'self-attestation' stands in for a missing source document
 * until the real one arrives.
 */
export const ELIGIBILITY_ITEMS = [
  'enrollment-form',
  'proof-of-age',
  'right-to-work',
  'school-status',
  'income-eligibility',
  'barrier-statement',
  'iss-plan',
  'objective-assessment',
  'self-attestation',
] as const
export type EligibilityItem = (typeof ELIGIBILITY_ITEMS)[number]

export const ELIGIBILITY_ITEM_LABELS: Record<EligibilityItem, string> = {
  'enrollment-form': 'Enrollment form',
  'proof-of-age': 'Proof of age (birth certificate or state ID)',
  'right-to-work': 'Right to work (Social Security card or passport)',
  'school-status': 'School status (transcript or report card)',
  'income-eligibility': 'Income eligibility (benefit letter or household income)',
  'barrier-statement': 'Barrier statement',
  'iss-plan': 'Individual service strategy, signed',
  'objective-assessment': 'Objective assessment summary',
  'self-attestation': 'Self-attestation (temporary)',
}

/** The items a participant with work-experience pay must have on file before the month can be submitted. */
export const REQUIRED_ELIGIBILITY_ITEMS: readonly EligibilityItem[] = [
  'enrollment-form',
  'proof-of-age',
  'right-to-work',
  'school-status',
  'income-eligibility',
]

/** One item of a participant's file, as this program's checklist names it. */
export interface EligibilityItemDef {
  key: string
  label: string
  required: boolean
}
/** The checklist an engagement starts with; its owners edit it per program. */
export const DEFAULT_ELIGIBILITY_ITEMS: EligibilityItemDef[] = ELIGIBILITY_ITEMS.map((k) => ({
  key: k,
  label: ELIGIBILITY_ITEM_LABELS[k],
  required: (REQUIRED_ELIGIBILITY_ITEMS as readonly string[]).includes(k),
}))
export const ALLOWED_UPLOAD_TYPES: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
}

// ── Reports, checks, roles ──────────────────────────────────────────────────

/**
 * A month's report: a draft while the ledger is kept, `closed` once the month-end closing is approved (the
 * company's own sign-off, before anything goes to the funder), `submitted` once it is sent to the funder.
 */
export const REPORT_STATUSES = ['draft', 'closed', 'submitted'] as const
export type ReportStatus = (typeof REPORT_STATUSES)[number]
export const REPORT_STATUS_LABELS: Record<ReportStatus, string> = {
  draft: 'draft',
  closed: 'closing approved',
  submitted: 'submitted',
}

/** Where an engagement is in its life: proposed (nothing awarded yet), awarded, active (contract signed, months running), closed. */
export const ENGAGEMENT_STATUSES = ['proposed', 'awarded', 'active', 'closed'] as const
export type EngagementStatus = (typeof ENGAGEMENT_STATUSES)[number]

/**
 * The records an engagement keeps besides its financials, which every engagement keeps (the budget narrative,
 * the contract's dates and budget lines, the months, the audit package). A step left out shows greyed out as not
 * used and counts for nothing; a contract left out drops only the signed contract file from step 4.
 */
export const ENGAGEMENT_TRACKS = ['proposal', 'award-letter', 'contract'] as const
export type EngagementTrack = (typeof ENGAGEMENT_TRACKS)[number]
export const ENGAGEMENT_TRACK_LABELS: Record<EngagementTrack, string> = {
  proposal: 'Proposal',
  'award-letter': 'Award letter',
  contract: 'Signed contract',
}

export const CHECK_CODES = [
  'missing-invoice',
  'missing-proof-of-payment',
  'missing-allocation',
  'allocation-exceeds-total',
  'missing-timesheet',
  'missing-register',
  'budget-overrun',
  'date-outside-contract',
  'date-far-from-period',
  'indirect-as-direct',
  'duplicate-item',
  'late-submission',
  'unallowable-category',
  'proof-mismatch',
  'no-budget-line',
  'payroll-counted-twice',
] as const
export type CheckCode = (typeof CHECK_CODES)[number]

export type CheckSeverity = 'blocker' | 'attention' | 'info'
export type CheckSource = 'rule' | 'ai'
export type CheckStatus = 'open' | 'resolved' | 'waived'

export const ROLES = ['owner', 'bookkeeper', 'auditor'] as const
export type Role = (typeof ROLES)[number]
export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner',
  bookkeeper: 'Bookkeeper',
  auditor: 'Auditor',
}
export const ROLE_HELP: Record<Role, string> = {
  owner: 'Runs the workspace: people, lists, every engagement. Signs the monthly report.',
  bookkeeper:
    'Records spending, attaches proof, records the month-end closing and submits the monthly report.',
  auditor: 'Reads everything, personal records included, and changes nothing.',
}
/** Roles that may change records. An auditor reads. */
export const WRITE_ROLES: Role[] = ['owner', 'bookkeeper']

/** What a workspace tracks. An Engagement row is one of these kinds. */
export const ENGAGEMENT_KINDS = ['grant', 'contract', 'other'] as const
export type EngagementKind = (typeof ENGAGEMENT_KINDS)[number]
export const ENGAGEMENT_KIND_LABELS: Record<EngagementKind, string> = {
  grant: 'Grant',
  contract: 'Contract',
  other: 'Other',
}

// ── Tags ────────────────────────────────────────────────────────────────────
// Labels a workspace's owners keep (Workspace.tagTypes) and apply to engagements, expenses, payroll items and
// participants, e.g. a source of funds, or an age group. A record holds tags as `<type key>:<value key>`.

/**
 * The records a tag type may be applied to. 'payroll' is a participant's work-experience payment. An engagement's
 * tags are picked in the setup wizard and the Details modal, and its labels fill the printed form's "Source of funds".
 */
export const TAG_TARGETS = ['engagement', 'expense', 'payroll', 'participant'] as const
export type TagTarget = (typeof TAG_TARGETS)[number]
export const TAG_TARGET_LABELS: Record<TagTarget, string> = {
  engagement: 'Engagements',
  expense: 'Expenses',
  payroll: 'Payroll items',
  participant: 'Participants',
}

export interface TagValue {
  /** Never changes, so a rename keeps every record's tag. */
  key: string
  label: string
}

export interface TagType {
  key: string
  label: string
  appliesTo: TagTarget[]
  values: TagValue[]
}

/**
 * The tag types a new workspace starts with: fictional sources of funds, an ordinary type its owners rename, edit or
 * remove like any other.
 */
export const DEFAULT_TAG_TYPES: TagType[] = [
  {
    key: 'funding-source',
    label: 'Funding source',
    appliesTo: [...TAG_TARGETS],
    values: [
      { key: 'youth-workforce-fund', label: 'Youth Workforce Fund' },
      { key: 'adult-training-fund', label: 'Adult Training Fund' },
      { key: 'apprenticeship-readiness-fund', label: 'Apprenticeship Readiness Fund' },
      { key: 'employer-partnership-fund', label: 'Employer Partnership Fund' },
      { key: 'state-general-fund', label: 'State General Fund' },
    ],
  },
]

/** A tag's value in its own words, "Under 18"; a tag whose type or value has left the list shows as stored. */
export function tagValueLabel(types: TagType[], tag: string): string {
  const at = tag.indexOf(':')
  const type = types.find((t) => t.key === tag.slice(0, at))
  return type?.values.find((v) => v.key === tag.slice(at + 1))?.label ?? tag
}

/** A tag in words, "Age group: Under 18"; one whose type or value has left the list shows as stored. */
export function tagLabel(types: TagType[], tag: string): string {
  const at = tag.indexOf(':')
  const type = types.find((t) => t.key === tag.slice(0, at))
  const value = type?.values.find((v) => v.key === tag.slice(at + 1))
  return type && value ? `${type.label}: ${value.label}` : tag
}

/** Roles that may open a 'personal' document. A bookkeeper attaches them; they do not read them back. */
export const PERSONAL_DOCUMENT_ROLES: ReadonlySet<Role> = new Set(['owner', 'auditor'])

/**
 * Roles that may open one personal document of this kind. A pay stub is the one exception: bookkeepers open pay stubs
 * too, since they keep payroll and already see the stubs in the payroll system (owner's decision, 2026-10-16).
 * Eligibility records and enrollment forms stay with owners and auditors.
 */
/** The personal payroll files every member opens (pay stubs, owner's decision 2026-10-16; payroll details, #22). */
export const PAYROLL_PERSONAL_KINDS: readonly string[] = ['paystub', 'payroll-details']

export const personalRolesFor = (kind: string): ReadonlySet<Role> =>
  PAYROLL_PERSONAL_KINDS.includes(kind)
    ? new Set<Role>(['owner', 'bookkeeper', 'auditor'])
    : PERSONAL_DOCUMENT_ROLES

/** What a contact-form message is about. The contact page's `?topic=` picks one; anything else is 'question'. */
export const CONTACT_TOPICS = [
  'demo',
  'question',
  'broken-link',
  'privacy',
  'account',
  'other',
] as const
export type ContactTopic = (typeof CONTACT_TOPICS)[number]
export const CONTACT_TOPIC_LABELS: Record<ContactTopic, string> = {
  demo: 'Book a demo',
  question: 'A general question',
  'broken-link': 'A broken link or missing page',
  privacy: 'Privacy or my data',
  account: 'My account or signing in',
  other: 'Something else',
}
/**
 * The address a contact message is about (the 404 page's `?page=`): a path only, never a query string or
 * hash, which can carry tokens. Checked the same way by the form and the API.
 */
export const CONTACT_PAGE_MAX = 300
export const CONTACT_PAGE_PATTERN = /^\/[^\s?#]*$/

// ── API shapes ──────────────────────────────────────────────────────────────

export interface Me {
  userId: string
  /** The version of the Terms now in force: the fingerprint of their wording, computed by the API. */
  termsVersion: string
  /** Whether this person has accepted that version; the app shows nothing else until they have. */
  termsAccepted: boolean
  /** True when they accepted an older version but not the current one: the prompt says the Terms were updated. */
  termsPreviouslyAccepted: boolean
  /** featuredDemo: the full demo workspace, marked "Full demo". */
  memberships: { workspaceId: string; workspaceName: string; role: Role; featuredDemo?: boolean }[]
}

export interface Health {
  status: 'ok'
  timestamp: string
  version: string
  environment: string
}

// ── API shapes: what the API returns and the web app renders ────────────────

export interface DocumentDto {
  id: string
  kind: DocumentKind
  sensitivity: DocumentSensitivity
  fileName: string
  contentType: string
  size: number
  period: string | null
  uploadedAt: string
}

export interface AttachedDocument<P extends string = string> {
  purpose: P
  document: DocumentDto
  /** On a payroll item's bank statement: the line it was paid on, marked on the page. */
  mark?: StatementMark | null
  /** On a payroll proof: the exact words highlighted for this item (migration 20261016001400); none on older links. */
  marks?: StatementMark[]
}

export interface ExpenseInput {
  itemNumber: string
  /** YYYY-MM-DD */
  date: string
  vendor: string
  memo?: string | null
  account?: string | null
  totalCost: number
  allocatedAmount: number
  allocationType: AllocationType
  allocationNote?: string | null
  /** The engagement's budget line it is spent against; its form line follows from it. */
  budgetLineId: string | null
  /** Tags from the workspace's list (`<type key>:<value key>`). */
  tags?: string[]
}

export interface ExpenseDto extends ExpenseInput {
  id: string
  /** The funder's form line, from the budget line (as it was, for an expense still without one). */
  reportLine: ReportLine
  /** The budget line's name; null while the expense has none ("needs a budget line"). */
  budgetLineName: string | null
  memo: string | null
  account: string | null
  allocationNote: string | null
  tags: string[]
  documents: AttachedDocument<DocumentPurpose>[]
  /** Written by the payroll match from payroll details: payroll, proved like a payroll line whatever its budget line. */
  fromPayroll: boolean
  /**
   * A books' payroll transaction and its kind (imported as payroll, or marked on the month): it counts on the budget
   * only until the payroll match covers that kind of payroll on the month. Null: an ordinary line.
   */
  payrollKind: PayrollBudgetKind | null
  /** Whether it counts on the budget now: false for a books' payroll transaction the match has covered. */
  counts: boolean
}

/** A payroll line: on a payroll line of the funder's form, or written by the payroll match (on Program Costs, say). */
export const isPayrollLine = (e: {
  reportLine: string
  fromPayroll?: boolean
  payrollKind?: string | null
}) =>
  PAYROLL_REPORT_LINES.has(e.reportLine as ReportLine) || e.fromPayroll === true || !!e.payrollKind

export interface CheckDto {
  id: string
  code: CheckCode
  severity: CheckSeverity
  source: CheckSource
  message: string
  status: CheckStatus
  expenseId: string | null
  participantId: string | null
  wexPaymentId: string | null
}

/** One of the engagement's budget lines in a month: approved, spent before, spent this month, and what is left. */
export interface BudgetLineRow {
  id: string
  name: string
  reportLine: ReportLine
  budget: number
  previouslyBilled: number
  billedThisPeriod: number
  cumulative: number
  remaining: number
}

export interface LineRow {
  line: ReportLine
  label: string
  budget: number
  previouslyBilled: number
  billedThisPeriod: number
  cumulative: number
  remaining: number
}

export interface ParticipantDto {
  id: string
  participantId: string
  displayName: string
  enrollmentStatus: string
  currentStatus: string
  /** Personal data, like the rest of the row: the access log names the field, never the values. */
  tags: string[]
  /** `purpose` is a key of the engagement's eligibility checklist. */
  documents: AttachedDocument<string>[]
}

export interface WexPaymentInput {
  participantId: string
  /** YYYY-MM-DD */
  payPeriodStart: string
  payPeriodEnd: string
  hours?: number | null
  grossAmount: number
  tags?: string[]
}

export interface WexPaymentDto {
  id: string
  participantId: string
  participantName: string
  participantNumber: string
  payPeriodStart: string
  payPeriodEnd: string
  hours: number | null
  grossAmount: number
  tags: string[]
  documents: AttachedDocument<DocumentPurpose>[]
}

export interface ReportSummary {
  id: string
  period: string
  status: ReportStatus
  dueDate: string
  submittedAt: string | null
  /** When the month was last reopened to correct it; a signed copy counts only if uploaded after this. */
  lastReopenedAt: string | null
  billedThisPeriod: number
  expenseCount: number
  openBlockers: number
  openAttention: number
}

export interface EngagementSummary {
  id: string
  workspaceId: string
  workspaceName: string
  /** Its workspace is the full demo: marked "Full demo". */
  workspaceFeaturedDemo?: boolean
  kind: EngagementKind
  name: string
  funder: string | null
  /** The funder's contract number, once the contract exists. */
  number: string | null
  /** What an emailed receipt's subject names to pick this engagement. */
  code: string | null
  status: EngagementStatus
  /** The records kept besides the financials (ENGAGEMENT_TRACKS); the rest are not used. */
  tracks: EngagementTrack[]
  periodStart: string | null
  periodEnd: string | null
  requestedAmount: number | null
  awardAmount: number | null
  cumulativeBilled: number
  budgetLineCount: number
  reports: ReportSummary[]
  /** The engagement's own records (proposal, award letter, narrative, contract, signed monthly reports). */
  documents: DocumentDto[]
  /** Records that do not exist for this engagement, with the reason, by document kind. */
  waivers: Partial<Record<DocumentKind, string>>
  /** Participants enrolled, and how many have every required item of the eligibility checklist on file. */
  participantCount: number
  participantsComplete: number
}

export interface EngagementDetail extends EngagementSummary {
  funderContact: string | null
  solicitation: string | null
  proposalSubmittedOn: string | null
  awardedOn: string | null
  /** The engagement's tags (`<type key>:<value key>`), of the types that apply to engagements: its sources of funds. */
  tags: string[]
  reportDueDay: number
  indirectTerms: string | null
  /** Reporting, as the funder's form names it. */
  reportTo: string | null
  submissionMethod: string | null
  preparerName: string | null
  preparerOrganization: string | null
  authorizerName: string | null
  authorizerOrganization: string | null
  /** This program's participant-file checklist (the defaults when none was set). */
  eligibilityItems: EligibilityItemDef[]
  budgetLines: {
    id: string
    /** The line as the contract's approved budget names it. */
    name: string
    reportLine: ReportLine
    amount: number
    narrative: string | null
    /** The payroll from the match it holds. */
    payroll: PayrollBudgetKind[]
    /** Whether any expense is spent against it: then it keeps its form line and is not removed. */
    hasSpending: boolean
    /** Charged to it to date, every month together. */
    spent: number
  }[]
  /** Names used for budget lines in the workspace's other engagements (and its old list), to suggest when adding one. */
  budgetNameSuggestions: string[]
  /** Every tag type of the workspace, for tagging the engagement and its participants. */
  tagTypes: TagType[]
  participants: ParticipantDto[]
  /** Owners and bookkeepers: may change the engagement, add months and participants. */
  canManage: boolean
}

/** A new or changed engagement. Everything but the kind, the name and the workspace may come later. */
export interface EngagementInput {
  workspaceId: string
  kind: EngagementKind
  name: string
  tracks?: EngagementTrack[]
  funder?: string | null
  funderContact?: string | null
  solicitation?: string | null
  requestedAmount?: number | null
  /** YYYY-MM-DD */
  proposalSubmittedOn?: string | null
  awardedOn?: string | null
  awardAmount?: number | null
  number?: string | null
  code?: string | null
  periodStart?: string | null
  periodEnd?: string | null
  /** Tags of the types that apply to engagements, from the workspace's list. */
  tags?: string[]
  reportDueDay?: number
  indirectTerms?: string | null
  waivers?: Partial<Record<DocumentKind, string>>
  reportTo?: string | null
  submissionMethod?: string | null
  preparerName?: string | null
  preparerOrganization?: string | null
  authorizerName?: string | null
  authorizerOrganization?: string | null
  eligibilityItems?: EligibilityItemDef[]
}

/** A workspace: the team's container for its engagements, people and lists. */
export interface WorkspaceDto {
  id: string
  name: string
  /** The full demo workspace: marked "Full demo". */
  featuredDemo?: boolean
  /** The caller's own role in it. */
  myRole: Role | null
  memberCount: number
  engagementCount: number
  /** The owners' tag types, "Funding source" among them like any other. */
  tagTypes: TagType[]
  /** Owners: people, lists, settings. */
  canManage: boolean
  /** The local part of the receipts address, as the owner set it; null until then. */
  receiptsAddress: string | null
  /** The full receipts address, when the local part and the environment's email domain are both set. */
  receiptsEmail: string | null
  /** The owners' setting: emailed receipts (no person present) are read with AI when nothing else reads them. Off by default. */
  readEmailedReceiptsWithAi: boolean
  /** Whether this server can use AI at all (it has a key): the AI options are hidden when it cannot. */
  aiAvailable: boolean
  /** When the owner accepted the terms creating it; null for a workspace made before terms were recorded. */
  termsAcceptedAt?: string | null
  /**
   * The owners' setting "Bookkeepers see staff payroll" (on by default). Off, a bookkeeper's month page shows the payroll
   * section with its proofs as labels, not links to the files. The screen only: the API answers the same data.
   */
  bookkeepersSeeStaffPayroll?: boolean
}

/** Body of POST /me/terms: the version being accepted, which must be the current one. */
export interface AcceptTermsRequest {
  version: string
}

/** The code of the 403 the API answers with while the caller has not accepted the current Terms. */
export const TERMS_REQUIRED_CODE = 'terms_required'

/** Deleting an engagement or workspace is permanent: the owner types this phrase and the exact name. */
export const DELETE_PHRASE = 'delete permanently'

/** How long we keep our own copy of the full export taken before a deletion (an R2 lifecycle rule expires it). */
export const RETAINED_COPY_DAYS = 30

/** What a deletion will remove, in counts, for the confirmation screen. */
export interface DeletionSummaryDto {
  months: number
  participants: number
  documents: number
  /** Workspace only: documents filed to no engagement, which need their own export first. */
  hasWorkspaceDocuments?: boolean
}

/**
 * One zip of a split export. `bytes` is the exact size when it is known before the zip is made (it is not for
 * the exports built on request); `sourceBytes` is the size of the files that go into it.
 */
export interface ExportPartDto {
  n: number
  fileName: string
  bytes?: number
  sourceBytes: number
}

/** A deletion's export: the record the delete will name, and the zips to download, each one a part. */
export interface DeletionExportDto {
  deletionId: string
  parts: ExportPartDto[]
}

/** The audit package when it is too big for one zip: the parts to ask for with ?part=n. */
export interface AuditPackagePartsDto {
  parts: ExportPartDto[]
}

export interface WorkspaceMemberDto {
  userId: string
  displayName: string
  email: string | null
  role: Role
  /** Invited by email, not signed in yet. */
  pending: boolean
}

/**
 * One field of a logged change. A value appears only where it is safe to keep (amounts, dates, statuses on
 * financial records); a personal or free-text field carries its name alone, and no value at all.
 */
export interface LoggedChange {
  field: string
  before?: string | null
  after?: string | null
}

/** One line of the workspace's access log. */
export interface ActivityEntry {
  id: string
  at: string
  /** Who did it: their email (lines written before 2026-10-13 may carry a display name). */
  actorName: string
  action: string
  resource: string
  /** What the person did, in the words of the screen they did it on. Null on lines written before it existed. */
  description: string | null
  /** The fields a change touched. Null on a read, list, download or export. */
  changes: LoggedChange[] | null
  detail: string | null
}

export interface SuggestionDto {
  id: string
  text: string
  by: string
  createdAt: string
}

export interface WorkspaceDetail extends WorkspaceDto {
  members: WorkspaceMemberDto[]
  /** What members asked to add to the lists. */
  suggestions: SuggestionDto[]
  /**
   * How many records hold each tag (`<type key>:<value key>`), by kind of record, for the owners' warning before a
   * value or type is removed (it comes off every one). Empty for anyone but an owner.
   */
  tagUses: TagUses
}

/** How many records of each kind hold each tag. */
export type TagUses = Record<string, Partial<Record<TagTarget, number>>>

/**
 * A workspace as the platform admin sees it (Admin tools): workspace level only, nothing of its engagements,
 * records or access log.
 */
export interface AdminWorkspaceDto {
  id: string
  name: string
  featuredDemo?: boolean
  createdAt: string
  memberCount: number
  members: WorkspaceMemberDto[]
  /** When its first owner accepted the Terms; null until then. */
  termsAcceptedAt: string | null
}

export interface AdminWorkspaceDetail extends AdminWorkspaceDto {
  receiptsAddress: string | null
  receiptsEmail: string | null
  tagTypes: TagType[]
  suggestions: SuggestionDto[]
}

/** Body of POST /workspaces (platform admins only): the workspace and its first owner, invited by email. */
export interface CreateWorkspaceRequest {
  name: string
  ownerEmail: string
  ownerName?: string
}

/** The one role an account carries (Clerk publicMetadata.role): the platform admin. Every other role is a membership. */
export const PLATFORM_ADMIN = 'admin'

/** A person of the sign-in instance, as the Admin tools page shows them. */
export interface AdminUserDto {
  id: string
  email: string | null
  displayName: string | null
  role: string | null
}

/** The platform admins; `complete` is false when there were too many accounts to read them all. */
export interface AdminListDto {
  admins: AdminUserDto[]
  complete: boolean
}

/** At most this many platform admins at once (owner's decision, 2026-10-14). */
export const MAX_PLATFORM_ADMINS = 20

/** One attempt to make or unmake a platform admin, as the Admin tools page lists them (PlatformRoleChange). */
export interface PlatformRoleChangeDto {
  id: string
  at: string
  actorEmail: string | null
  targetEmail: string | null
  oldRole: string | null
  newRole: string | null
  outcome: 'done' | 'failed'
  error: string | null
}

/** The month-end closing as the bookkeeper records it: who approved it for the company, on what day, and a note. */
export interface ClosingInput {
  approvedBy: string
  /** YYYY-MM-DD */
  approvedOn: string
  note?: string
}

/**
 * A submitted month reopened to correct it, kept for good: when, by whom (their email) and why, and what it undid:
 * the submission, the month-end closing approval and the signed copy that went to the funder.
 */
export interface ReportReopeningDto {
  id: string
  reopenedAt: string
  reopenedBy: string
  reason: string
  /** The submission this reopening undid. */
  submittedAt: string
  approvedByName: string | null
  approvedAt: string | null
  /** The signed copy as submitted, if one was on file. */
  signedDocument: DocumentDto | null
}

export interface ReportDetail {
  id: string
  period: string
  status: ReportStatus
  dueDate: string
  submittedAt: string | null
  preparedByName: string | null
  /** Who approved the month-end closing, and when; the same person signs as "Authorized by" on the form. */
  authorizedByName: string | null
  authorizedAt: string | null
  comments: string | null
  closingNote: string | null
  /** Why the month-end closing was last sent back; cleared when it is approved again. */
  sentBackReason: string | null
  /** When it was last sent back, and by whom (staff email): who pressed Send back, or who changed the budget. */
  sentBackAt: string | null
  sentBackBy: string | null
  /**
   * Edits asked for on the draft (Request edits, before its closing is approved): when, by whom (staff email) and the
   * comment. The status stays draft; approving the closing clears them.
   */
  editsRequestedAt: string | null
  editsRequestedBy: string | null
  editsRequestComment: string | null
  /** Every time the submitted month was reopened to correct it, newest first, with what each reopening undid. */
  reopenings: ReportReopeningDto[]
  /**
   * The signed copy that counts for the month: the newest one uploaded after its latest reopening (any, if it was
   * never reopened). Null until one is on file.
   */
  signedCopy: DocumentDto | null
  isFinal: boolean
  engagement: {
    id: string
    kind: EngagementKind
    name: string
    number: string | null
    /** The short code an emailed receipt's subject names to land in this engagement (e.g. "RYS26"). */
    code?: string | null
    funder: string | null
    periodStart: string | null
    periodEnd: string | null
    /** The engagement's tags: the printed form's "Source of funds" shows their labels. */
    tags: string[]
    reportDueDay: number
    awardAmount: number | null
    workspace: {
      id: string
      name: string
      featuredDemo?: boolean
      /** The owners' setting "Bookkeepers see staff payroll"; `can.seeStaffPayroll` says what it means for the caller. */
      bookkeepersSeeStaffPayroll?: boolean
    }
    eligibilityItems: EligibilityItemDef[]
    reportTo: string | null
    preparerName: string | null
    preparerOrganization: string | null
    authorizerName: string | null
    authorizerOrganization: string | null
  }
  lines: LineRow[]
  /** The engagement's budget lines, each with what was spent against it. */
  budgetLines: BudgetLineRow[]
  expenses: ExpenseDto[]
  wexPayments: WexPaymentDto[]
  checks: CheckDto[]
  participants: ParticipantDto[]
  /** Every tag type of the workspace, for tagging expenses and payroll items. */
  tagTypes: TagType[]
  /** The workspace's documents, for attaching. */
  documents: DocumentDto[]
  /** This month's receipts and invoices of the engagement, and the matches suggested for them (financial only). */
  matching: ReceiptMatching
  /** This month's payroll documents of the engagement (PAYROLL_DOCUMENT_KINDS), linked or not. */
  payrollDocuments: DocumentDto[]
  /**
   * `close`: may record the month-end closing as approved (a draft); `sendBack`: may record it as sent back,
   * which reopens the month (closing approved); `submit`: may submit to the funder (closing approved); `reopen`:
   * may reopen a submitted month to correct it, back to a draft that is closed and submitted again;
   * `attachSigned`: may attach the signed copy of the report (an owner or bookkeeper, in any status, while the month
   * has none on file since its latest reopening); `requestEdits`: may ask for edits with a comment (a draft: recorded,
   * the status unchanged; closing approved: sent back to a draft); `readPersonal`: may open a personal document (PERSONAL_DOCUMENT_ROLES).
   */
  can: {
    edit: boolean
    close: boolean
    sendBack: boolean
    requestEdits: boolean
    submit: boolean
    reopen: boolean
    attachSigned: boolean
    readPersonal: boolean
    /** An owner may delete this month: a draft with no expenses, payroll or files, so nothing to submit. */
    deleteMonth: boolean
    /**
     * The page links the payroll proofs to their files: false for a bookkeeper when an owner turned off "Bookkeepers see
     * staff payroll" (the proofs then show as labels). The screen only; the API answers the same data.
     */
    seeStaffPayroll?: boolean
  }
}

// ── Import transactions ─────────────────────────────────────────────────────
// A file the team exports from its accounting system (a QuickBooks report, or another CSV or Excel file) becomes
// expense lines, each in the month of its date. It is not a sync: the file is read once, never stored.

/** The fields an imported row fills, in the order the import screen asks for them. */
export const IMPORT_FIELDS = [
  'date',
  'vendor',
  'memo',
  'amount',
  'debit',
  'credit',
  'reference',
  'account',
  'category',
] as const
export type ImportField = (typeof IMPORT_FIELDS)[number]
/** In the Add expense form's words, so a line reads the same whether it was typed or imported. */
export const IMPORT_FIELD_LABELS: Record<ImportField, string> = {
  date: 'Date',
  vendor: 'Vendor',
  memo: 'Memo',
  amount: 'Total cost',
  debit: 'Money out (debit)',
  credit: 'Money in (credit)',
  reference: 'Item number',
  account: 'Account in your books (general ledger)',
  category: 'Budget line',
}

/** Which column of the file (by its header) holds each field; `flipSign` when the file shows spending as negative. */
export type ImportColumns = Partial<Record<ImportField, string>> & { flipSign?: boolean }

/** What a category in the file maps to: a budget item's key, or IMPORT_SKIP to leave those rows out. */
export const IMPORT_SKIP = 'skip'
export type ImportCategories = Record<string, string>

/** A mapping saved on the workspace by name ("QuickBooks mapping"). `matches`: it was saved for these columns. */
export interface ImportMappingDto {
  id: string
  name: string
  headers: string[]
  columns: ImportColumns
  categories: ImportCategories
  matches: boolean
}

/** The file as read: its columns, a few rows to recognise it by, and the first guess at the mapping. */
export interface ImportFileDto {
  fileName: string
  headers: string[]
  sample: string[][]
  rowCount: number
  guess: ImportColumns
  /** Where the guess came from: a saved mapping for these columns, or the column names by rules. Never AI unasked. */
  guessedBy: 'saved' | 'headers'
  /** Whether the person may ask AI to suggest the mapping: the server has a key and the file has a row of column names. */
  aiAvailable: boolean
  mappings: ImportMappingDto[]
  /** The saved mapping chosen for these columns, if any. */
  mappingId: string | null
  /** The budget items this engagement uses (it has a line for), to map categories to. */
  budgetOptions: BudgetOption[]
}

/** The mapping the person confirmed, sent with the file (as the `mapping` field) to preview and to import. */
export interface ImportRequest {
  columns: ImportColumns
  categories: ImportCategories
  /** Save this mapping on the workspace under this name (import only). */
  saveAs?: string
  /** Import from a month's page: the answer then carries that page. */
  reportId?: string
  /** The person asked AI to suggest the columns (import only): the access log line says so. */
  aiSuggested?: boolean
  /**
   * A budget item key (or IMPORT_SKIP) for single rows, by their line in the file: how a file with no budget-line
   * column is charged, row by row. A row named here takes this over its category's.
   */
  lines?: Record<string, string>
  /**
   * The person's answers on "Payroll transactions confirmation", by line in the file: true counts the row as a payroll
   * transaction (kept for payroll reconciliation), false as an expense. A row not named here keeps what the import
   * found.
   */
  payroll?: Record<string, boolean>
}

/** A row on "Payroll transactions confirmation": found as payroll (or not), and the budget line it goes to if it is. */
export type ImportPayrollRowDto = ImportRowDto & {
  account: string | null
  /** Found by its account or category; the person's answer may differ. */
  found: boolean
  /** Counted as a payroll transaction now. */
  included: boolean
  kind: PayrollBudgetKind
  /** The budget line ticked for its kind; null when none is (the row then waits). */
  budgetLineName: string | null
}

/** What AI suggested for the columns when the person asked (POST .../imports/suggest): null when it had nothing. */
export interface ImportSuggestionDto {
  columns: ImportColumns | null
}

/** One row of the file as the import reads it. `line` is its line in the file; `reason` says why it is left out. */
export interface ImportRowDto {
  line: number
  date: string | null
  vendor: string
  memo: string
  amount: number | null
  category: string
  period: string | null
  itemNumber?: string
  reportLine?: ReportLine
  reason?: string
}

export interface ImportPreviewDto {
  /**
   * Each value of the file's budget-line column (blank when a row has none), with how many rows and how much, and the
   * one budget item whose name it matches, if exactly one does (pre-filled; the person confirms or changes it).
   */
  categories: { value: string; rows: number; total: number; match: string | null }[]
  /** The months the rows go to; `isNew` ones are started as drafts on import. */
  months: { period: string; isNew: boolean; rows: number; total: number }[]
  rows: ImportRowDto[]
  notImported: ImportRowDto[]
  /** Every row that can be imported once it has a budget line, with the one it has now (null: none yet). */
  assignable: (ImportRowDto & { budgetItem: string | null })[]
  /** "Payroll transactions confirmation": the rows found as payroll, and any the person changed. */
  payroll: ImportPayrollRowDto[]
  /**
   * Rows imported before whose payroll choice is different now: importing changes those lines (payroll or an expense,
   * and the budget line that follows) instead of skipping them. `change` says how, in the screen's words.
   */
  updates: (ImportRowDto & { change: string })[]
}

export interface ImportResultDto {
  imported: number
  /** Lines imported before whose payroll choice this import changed. */
  updated: number
  total: number
  months: ImportPreviewDto['months']
  notImported: number
  /** The engagement and (from a month's page) the month as they now stand, so neither page fetches again. */
  engagement: EngagementDetail
  report: ReportDetail | null
}

// ── Match receipts ──────────────────────────────────────────────────────────
// Receipts and invoices uploaded to a month are read for their amount, date and vendor and matched to the month's
// expenses as their invoice proof, as banking software matches transactions. Personal documents are never read.

/** The document types a month's receipts are uploaded as; each is financial and stands as invoice proof. */
export const RECEIPT_KINDS = ['receipt', 'invoice'] as const satisfies readonly DocumentKind[]
export type ReceiptKind = (typeof RECEIPT_KINDS)[number]

/** How a receipt's amount, date and vendor were found: the PDF's own text, Claude, or a person. */
export const RECEIPT_READ_BY = ['text', 'ai', 'person'] as const
export type ReceiptReadBy = (typeof RECEIPT_READ_BY)[number]
export const RECEIPT_READ_BY_LABELS: Record<ReceiptReadBy, string> = {
  text: 'read from the PDF',
  ai: 'read by AI',
  person: 'typed',
}

/** A receipt or invoice of the month, with what was read from it and the expenses it is matched to. */
export interface ReceiptDto {
  document: DocumentDto
  amount: number | null
  /** YYYY-MM-DD */
  date: string | null
  vendor: string | null
  readBy: ReceiptReadBy | null
  /** Marked "not for this grant": out of the unmatched list until brought back. */
  dismissed: boolean
  matchedTo: { expenseId: string; itemNumber: string }[]
}

/** A suggested match of an unmatched receipt to an expense without invoice proof, best first. */
export interface MatchSuggestion {
  documentId: string
  expenseId: string
  /** 0 to 100: amount (up to 50), date (up to 30), vendor (up to 20). */
  score: number
  amount: 'exact' | 'within-a-cent' | null
  daysApart: number | null
  /** 0 to 1. */
  vendor: number
  /** Exact amount and dates within 3 days: what an automatic match needs, when it is the only one. */
  strong: boolean
}

export interface ReceiptMatching {
  receipts: ReceiptDto[]
  suggestions: MatchSuggestion[]
  /** Whether this server can read receipts with AI (it has a key): the upload's AI box is hidden when it cannot. */
  aiAvailable: boolean
  /** The workspace's receipts address, for the reminder to email receipts in; null until an owner sets it. */
  receiptsEmail?: string | null
}

/** A receipt's fields as the person types or corrects them. */
export interface ReceiptInput {
  amount: number | null
  /** YYYY-MM-DD */
  date: string | null
  vendor: string | null
}

/** What a bulk upload of receipts did, and the month as it now stands. */
export interface ReceiptUploadResult {
  uploaded: number
  matched: number
  report: ReportDetail
}

// ── Emailed receipts ────────────────────────────────────────────────────────

/**
 * What became of an emailed receipt: received (waiting for the worker), processing, filed (stored in a month and
 * matched where it could be), unmatched (kept for a person to file), rejected (refused, never filed) or failed (could
 * not be processed after five attempts).
 */
export const INBOUND_RECEIPT_STATUSES = [
  'received',
  'processing',
  'filed',
  'unmatched',
  'rejected',
  'failed',
  'dismissed',
] as const
export type InboundReceiptStatus = (typeof INBOUND_RECEIPT_STATUSES)[number]
export const INBOUND_RECEIPT_STATUS_LABELS: Record<InboundReceiptStatus, string> = {
  received: 'Waiting',
  processing: 'Working on it',
  filed: 'Filed',
  unmatched: 'Needs filing',
  rejected: 'Refused',
  failed: 'Failed',
  dismissed: 'Dismissed',
}

/** Why a person dismissed an emailed receipt that needs filing: a fixed list, so nothing personal is typed in. */
export const DISMISS_REASONS = ['personal', 'duplicate', 'not-a-receipt', 'other'] as const
export type DismissReason = (typeof DISMISS_REASONS)[number]
export const DISMISS_REASON_LABELS: Record<DismissReason, string> = {
  personal: 'Not applicable to this workspace',
  duplicate: 'Already on file',
  'not-a-receipt': 'Not a receipt',
  other: 'Something else',
}

/** The workspace's receipts address: its local part, 3 to 40 lowercase letters, digits and hyphens. */
export const RECEIPTS_ADDRESS_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/
/** An engagement's code for a subject line: 2 to 20 letters, digits and hyphens, kept in capitals. */
export const ENGAGEMENT_CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{1,19}$/

/** One emailed receipt in the workspace's receipts inbox. */
export interface InboundReceiptDto {
  id: string
  status: InboundReceiptStatus
  receivedAt: string
  fromAddress: string | null
  subject: string | null
  engagementId: string | null
  /** The engagement's name today; null when there is none or it was deleted. */
  engagementName: string | null
  documentCount: number
  /** Why it was refused or why it needs filing. */
  reason: string | null
  /** The last failure, or the attachments that were skipped. */
  error: string | null
  attempts: number
}

/** The receipts inbox: the address to send to (null until the owner sets it or the email provider is set up). */
export interface ReceiptsInboxDto {
  /** The full address, `<local part>@<domain>`, when both are set. */
  address: string | null
  /** Whether this environment has the email provider set up. */
  configured: boolean
  items: InboundReceiptDto[]
  /** Owners and bookkeepers: run again and file by hand. */
  canManage: boolean
}

/**
 * One emailed receipt in Admin tools → Email administration: one that reached no workspace, or one of a workspace
 * that was refused or failed. Metadata only: never an attachment, never the raw message.
 */
export interface AdminInboundReceiptDto {
  id: string
  status: InboundReceiptStatus
  receivedAt: string
  toAddress: string | null
  fromAddress: string | null
  subject: string | null
  /** The workspace it reached; null when it reached none. */
  workspaceId: string | null
  workspaceName: string | null
  attempts: number
  /** Why it was refused. */
  reason: string | null
  /** The last failure. */
  error: string | null
  /** Whether "Run again" applies: refused or failed, or still waiting with no workspace. */
  canRunAgain: boolean
}

/** GET /admin/inbound. */
export interface AdminInboundDto {
  /** Whether this server has the email provider set up (and so runs the worker). */
  configured: boolean
  items: AdminInboundReceiptDto[]
}

/** The match features counted on Admin tools → Matching statistics (MatchRunStat.feature). */
export const MATCH_FEATURES = ['payroll', 'receipts', 'emailed-receipts'] as const
export type MatchFeature = (typeof MATCH_FEATURES)[number]
export const MATCH_FEATURE_LABELS: Record<MatchFeature, string> = {
  payroll: 'Payroll match',
  receipts: 'Receipt upload',
  'emailed-receipts': 'Emailed receipts',
}
/** How a run ended: a payroll match is saved, discarded or expired; a receipt run is done or failed. */
export type MatchOutcome = 'saved' | 'discarded' | 'expired' | 'done' | 'failed'
export const MATCH_OUTCOME_LABELS: Record<MatchOutcome, string> = {
  saved: 'Saved',
  discarded: 'Discarded',
  expired: 'Expired',
  done: 'Done',
  failed: 'Failed',
}
/** The periods the page offers, in days. */
export const MATCH_STAT_DAYS = [30, 90, 365] as const

/** One finished run: counts, sizes and durations only, with its workspace's name and who started it. */
export interface MatchStatRowDto {
  id: string
  feature: MatchFeature
  workspaceName: string
  startedByEmail: string
  startedAt: string
  finishedAt: string
  outcome: MatchOutcome
  fileCount: number
  totalBytes: number
  readMs: number | null
  durationMs: number
  /** Payroll items of the month, or receipts filed. */
  items: number
  /** Payroll proofs found sure, or receipts matched automatically. */
  matched: number
  /** Payroll proofs picked but not sure (0 for receipts). */
  guessed: number
  /** Payroll proofs with nothing found, or receipts left unmatched. */
  missing: number
  /** Files that could not be read (payroll), or receipts with nothing read from them. */
  failed: number
  /** Lines read from the run's bank statements (payroll only). */
  bankLines: number
}

/** One day of the line graph (UTC): runs per feature, and the share of what was looked for that was matched. */
export interface MatchStatDayDto {
  /** YYYY-MM-DD */
  day: string
  runs: Record<MatchFeature, number>
  /** matched / (matched + guessed + missing) that day, 0 to 1; null on a day with nothing to match. */
  matchRate: number | null
}

/** GET /admin/match-stats?days=&feature= */
export interface AdminMatchStatsDto {
  days: number
  feature: MatchFeature | null
  series: MatchStatDayDto[]
  /** The newest runs of the period, newest first, at most 200. */
  rows: MatchStatRowDto[]
  /** Every run of the period, not only the rows listed. */
  totals: { runs: number; files: number; bytes: number; matched: number; lookedFor: number }
}

/** Body of POST /inbound-receipts/:id/file: where a person files an unmatched emailed receipt. */
export interface FileInboundReceiptRequest {
  engagementId: string
  /** YYYY-MM */
  period: string
}

// ── Payroll proof ───────────────────────────────────────────────────────────
// Bank statements, payroll registers and pay stubs uploaded to a month in bulk; each payroll item (a payroll expense
// line or a work-experience payment) linked to its bank statement as evidence of payment, with the line marked.

/** What a payroll document uploaded to a month is. Pay stubs are personal: never read, never previewed. */
/** What a month's payroll upload holds: the three proofs a payroll item needs, and the bank statement behind them. */
export const PAYROLL_DOCUMENT_KINDS = [
  'timesheet',
  'payroll-register',
  'paystub',
  'bank-statement',
  'payroll-details',
] as const
export type PayrollDocumentKind = (typeof PAYROLL_DOCUMENT_KINDS)[number]

/** A line marked on a bank statement page: PDF points from the page's bottom-left corner. */
export interface StatementMark {
  /** From 1. */
  page: number
  x: number
  y: number
  width: number
  height: number
  /** The line as the statement prints it, when it was found by its text. */
  text?: string
}

/** A line of a bank statement where a payroll item's amount appears. */
export interface StatementLine extends StatementMark {
  text: string
}

/** A proof a payroll item needs: its timesheet, its payroll register, and evidence of payment (a participant's pay stub,
 * a staff line's bank statement line). */
export type PayrollSlot = 'timesheet' | 'register' | 'stub' | 'bank'

/** The document kind each payroll slot is filled from. */
export const PAYROLL_SLOT_KIND: Record<PayrollSlot, PayrollDocumentKind> = {
  timesheet: 'timesheet',
  register: 'payroll-register',
  stub: 'paystub',
  bank: 'bank-statement',
}

/**
 * What can be highlighted on a payroll proof for one item (owner's decision, 2026-10-16): the person's name, the pay
 * period's dates, the pay date, the amount, the item's whole row, or a bank transaction's date.
 */
export const HIGHLIGHT_FIELDS = ['name', 'payPeriod', 'payDate', 'amount', 'row', 'date'] as const
export type HighlightField = (typeof HIGHLIGHT_FIELDS)[number]

export const HIGHLIGHT_FIELD_LABELS: Record<HighlightField, string> = {
  name: "The person's name",
  payPeriod: 'The pay period',
  payDate: 'The pay date',
  amount: 'The amount',
  row: "The item's whole row",
  date: "The transaction's date",
}

/** The defaults until a platform admin changes them: what an auditor looks for on each proof. */
export const DEFAULT_HIGHLIGHTS: Record<PayrollDocumentKind, HighlightField[]> = {
  paystub: ['name', 'payPeriod', 'amount'],
  timesheet: ['row', 'name', 'payPeriod'],
  'payroll-register': ['payPeriod', 'payDate', 'amount'],
  'bank-statement': ['date', 'amount'],
  // A spreadsheet: the person's rows of the run, filled yellow on the item's copy.
  'payroll-details': ['row'],
}

/** The highlights in force for one proof type, and who last set them (null: the defaults). */
export interface HighlightSettingDto {
  kind: PayrollDocumentKind
  fields: HighlightField[]
  changedByEmail: string | null
  changedAt: string | null
}

/**
 * The words and day windows the payroll matchers read payroll files by, for the whole system (owner's decision,
 * 2026-10-19): set by a platform admin in Admin tools → Payroll reading, read by both match screens. Each list is plain
 * words, any case; a space also matches a hyphen or a line's spacing ("year to date" reads "Year-to-Date").
 */
export interface PayrollReading {
  /** The label beside a payroll run's pay date: "Pay date", "Check date". */
  payDateLabels: string[]
  /** A word on the lines that print the pay period: "period". */
  periodLabels: string[]
  /** The labels a register states the run's bank debit under, best first: "Total direct deposits". */
  debitTotalLabels: string[]
  /** The label of a pay stub's gross pay, best first: "Gross pay", "Gross". */
  grossLabels: string[]
  /** Read when no gross label is found: "Total pay", "Earnings". */
  totalPayLabels: string[]
  /** The label of the net pay: "Net pay". */
  netLabels: string[]
  /** Words that mark a year-to-date amount, never this run's: "YTD", "Year to date". */
  ytdLabels: string[]
  /** The label before the person's name on a pay stub: "Employee name", "Paid to". */
  nameLabels: string[]
  /** Words of a bank line where money comes in, so it pays nobody (a direct deposit still counts): "Deposit", "Refund". */
  moneyInWords: string[]
  /** How many days a run's bank debit may be from its pay date. */
  debitDaysFromPayDate: number
  /** With no pay date on the register: how many days after the pay period ends its bank debit may be. */
  debitDaysAfterPeriod: number
  /** How many days a staff charge's date may be from a run's pay date to be that run's pay. */
  chargeDaysFromPayDate: number
  /** The bookkeeper's Auto-Match: how many days a staff charge may be from a date on its proof. */
  proofDaysFromCharge: number
}

export type PayrollReadingList = {
  [K in keyof PayrollReading]: PayrollReading[K] extends string[] ? K : never
}[keyof PayrollReading]
export type PayrollReadingDays = Exclude<keyof PayrollReading, PayrollReadingList>

/** The defaults until a platform admin changes them. */
export const DEFAULT_PAYROLL_READING: PayrollReading = {
  payDateLabels: ['pay date', 'check date'],
  periodLabels: ['period'],
  debitTotalLabels: [
    'total direct deposits',
    'total direct deposit',
    'total net pay',
    'net pay total',
    'total payroll debit',
    'total debit',
    'total cash required',
    'total funding',
  ],
  grossLabels: ['gross pay', 'gross wages', 'gross earnings', 'gross'],
  totalPayLabels: ['total pay', 'total earnings', 'earnings'],
  netLabels: ['net pay'],
  ytdLabels: ['ytd', 'year to date'],
  nameLabels: ['employee name', 'employee', 'paid to', 'name'],
  moneyInWords: ['deposit', 'deposits', 'credit', 'credits', 'interest', 'refund'],
  debitDaysFromPayDate: 7,
  debitDaysAfterPeriod: 16,
  chargeDaysFromPayDate: 3,
  proofDaysFromCharge: 16,
}

/** Each list on the admin's page, in order: its title and one line saying what it is for. */
export const PAYROLL_READING_LISTS: { key: PayrollReadingList; title: string; line: string }[] = [
  {
    key: 'payDateLabels',
    title: 'Pay date labels',
    line: "The words beside a payroll run's pay date.",
  },
  {
    key: 'periodLabels',
    title: 'Pay period words',
    line: 'A word on the lines that print the pay period.',
  },
  {
    key: 'debitTotalLabels',
    title: 'Bank debit totals',
    line: "The labels a payroll register states the run's bank debit under, best first.",
  },
  { key: 'grossLabels', title: 'Gross pay labels', line: "A pay stub's gross pay, best first." },
  {
    key: 'totalPayLabels',
    title: 'Total pay labels',
    line: 'Read when no gross pay label is found.',
  },
  { key: 'netLabels', title: 'Net pay labels', line: "A pay stub's net pay." },
  {
    key: 'ytdLabels',
    title: 'Year-to-date words',
    line: "An amount after these is the year's, never this run's.",
  },
  {
    key: 'nameLabels',
    title: 'Name labels',
    line: "The label before the person's name on a pay stub.",
  },
  {
    key: 'moneyInWords',
    title: 'Money-in words',
    line: 'A bank line with these pays nobody, unless it is a direct deposit.',
  },
]

/** Each day window on the admin's page: its title and one line. */
export const PAYROLL_READING_DAYS: { key: PayrollReadingDays; title: string; line: string }[] = [
  {
    key: 'debitDaysFromPayDate',
    title: 'Bank debit near the pay date',
    line: "Days a run's bank debit may be from its pay date.",
  },
  {
    key: 'debitDaysAfterPeriod',
    title: 'Bank debit after the period',
    line: 'With no pay date: days after the pay period ends.',
  },
  {
    key: 'chargeDaysFromPayDate',
    title: 'Staff charge near the pay date',
    line: "Days a staff charge's date may be from a run's pay date.",
  },
  {
    key: 'proofDaysFromCharge',
    title: "Bookkeeper's Auto-Match window",
    line: 'Days a staff charge may be from a date on its proof.',
  },
]

/**
 * One save of Admin tools → Payroll File Matching's configuration, for its history: who, when, and what changed, in
 * words ("Pay date labels: added \"disbursement date\"").
 */
export interface PayrollSettingChangeDto {
  changedAt: string
  changedByEmail: string | null
  /** Which part: the reading words and days, or one proof type's highlighting. */
  part: 'reading' | 'highlights'
  changes: string[]
}

/** The words and days in force, and who last changed them (null: the defaults). */
export interface PayrollReadingDto {
  reading: PayrollReading
  changedByEmail: string | null
  changedAt: string | null
}

/** One value AI read from a payroll file, with the line of the file's own text it was found on. */
export interface AiPersonFact {
  /** The name on our lists it is, as the list keeps it. */
  name: string
  line: StatementLine
  gross: number | null
  payDate: string | null
  start: string | null
  end: string | null
}

/**
 * What AI read from one payroll file (owner's decision, 2026-10-19): the payroll run it is of (a register's pay date,
 * period and stated totals; a timesheet's or stub's period and pay date) and the people on our lists it shows. Every
 * value was found in the file's own text; a value that wasn't is never kept.
 */
export interface AiFileFacts {
  payDate: string | null
  start: string | null
  end: string | null
  totals: number[]
  people: AiPersonFact[]
  /** Why nothing was read, in plain words, when AI found nothing it could show in the file. */
  note?: string
}

/** One payroll run of the month, as its register prints it: its pay date and its pay period, the same for everyone it paid. */
export interface PayrollRunEntry {
  /** yyyy-mm-dd, in the month. */
  payDate: string
  start: string
  end: string
}

/** What a proof shows when the file it is on prints none of the month's pay dates. */
export const PAYROLL_RUN_UNKNOWN = 'Payroll Periods unknown'

/** One file of a payroll match run: staged from the zip, or (`staged: false`) a payroll document already on file. */
export interface PayrollMatchFileDto {
  id: string
  kind: PayrollDocumentKind
  fileName: string
  pages: number
  /** No text layer: nothing in it could be read, so it is matched by hand. */
  scanned: boolean
  /** Where the background job is with it: waiting, reading, read, or failed (then `error` says why). */
  status: 'waiting' | 'reading' | 'read' | 'failed'
  error: string | null
  staged: boolean
  personal: boolean
  /** It has more payroll lines than are read (MAX_PAY_LINES): only the first are, and the screen says so. */
  overLineCap: boolean
}

/**
 * How many payroll lines (a register's rows, a bank statement's payments out) are read from one file. A file with more
 * is flagged on the match screens and in the reconciliation, never cut short in silence (owner's decision, 2026-10-19).
 */
export const MAX_PAY_LINES = 2000

/** The best line one file has for one payroll item's slot, as the server read it. */
export interface PayrollCandidate {
  fileId: string
  /** The line found, or null when the file fits by its dates alone. */
  mark: StatementLine | null
  /** The exact words highlighted for this item, as the platform's highlight settings ask. */
  marks: StatementLine[]
  /** Name and amount (or pay period and amount) on the file together: enough to save without a second look. */
  sure: boolean
  /** Higher fits better; 0 is a file of the right kind that shows nothing of this item. */
  score: number
  /** A bank line that is the debit of the pay run that paid the item, not a line of the item's own amount. */
  payRun?: boolean
  /** AI read it (marked ✨ on the screen), checked against the file's text. */
  ai?: boolean
  /** Why, in plain words. */
  why: string
}

/** What the server found for one slot of one payroll item: every file that fits, best first, and its pick. */
export interface PayrollSlotMatch {
  target: 'expense' | 'wex'
  id: string
  slot: PayrollSlot
  candidates: PayrollCandidate[]
  /** The candidate Auto-Match chose (its fileId), or null when none fits or two fit equally. */
  pick: string | null
  why: string
}

/** How far the background job is with a run's files. */
export interface PayrollMatchProgress {
  total: number
  read: number
  failed: number
}

/** A payroll match run: the files and, for every open slot of every payroll item, what fits. */
export interface PayrollMatchRunDto {
  id: string
  replace: boolean
  expiresAt: string
  files: PayrollMatchFileDto[]
  slots: PayrollSlotMatch[]
  /** The month's payroll runs as the registers print them (pay date and period), in pay date order. */
  runs: PayrollRunEntry[]
  /**
   * Reading the files with AI, when a person asks: `available` when the server can (a key, and zero data retention
   * declared); the files AI has read (by run file id), and those it read nothing from.
   */
  ai: {
    available: boolean
    /** Before zero data retention is in place: the screen tells the person first what may be kept, and for how long. */
    beta: boolean
    read: string[]
    nothing: string[]
  }
}

/** Save: the proofs chosen, each a file of the run; the server works out its line and highlights, as Show draws them. */
export interface PayrollMatchSaveInput {
  links: {
    target: 'expense' | 'wex'
    id: string
    slot: PayrollSlot
    fileId: string
  }[]
}

/** One bank statement searched for an amount. `scanned`: it has no text layer, so nothing could be searched. */
export interface StatementSearch {
  document: DocumentDto
  pages: number
  scanned: boolean
  lines: StatementLine[]
}

/** What "Find the line" answers for one payroll item: the amount looked for, and each of the month's statements. */
export interface PayrollLineSearch {
  amount: number
  statements: StatementSearch[]
  /** Statements of the month left out of the search (it reads the newest ones first). */
  notSearched?: number
}

/** Links a payroll item to a bank statement as its evidence of payment, with the line marked. */
export interface StatementLinkInput {
  documentId: string
  mark: StatementMark
}

/** What a bulk upload of payroll documents did, and the month as it now stands. */
export interface PayrollUploadResult {
  uploaded: number
  /** The new documents' ids, in the order the files were sent. */
  documentIds: string[]
  report: ReportDetail
}

/**
 * One receipts address in Admin tools → Email administration → Receipts addresses: a workspace's current address, one
 * it used before, or one a platform admin released (GitHub issue #24). A previously used address is refused when mail
 * arrives until an admin releases it; the counts are worked out from those refused emails, never stored.
 */
export interface AdminReceiptsAddressDto {
  id: string
  /** The local part, as the workspace set it. */
  address: string
  /** `<local part>@<domain>`, when this server has a receipts domain. */
  email: string | null
  workspaceId: string
  /** The workspace's name today; null when the workspace was deleted. */
  workspaceName: string | null
  firstUsedAt: string
  /** When it stopped being the workspace's address; null while it is current. */
  removedAt: string | null
  /** Emails that arrived since removal, all refused; 0 while current, and once released. */
  receivedSinceRemoval: number
  /** When the last of them arrived; null when none has. */
  lastReceivedAt: string | null
  /** When a platform admin released it, and who (their email); null until then. */
  releasedAt: string | null
  releasedByEmail: string | null
  /** Only a previously used address not yet released is released, never a workspace's current one. */
  canRelease: boolean
}

/** GET /admin/receipts-addresses. */
export interface AdminReceiptsAddressesDto {
  items: AdminReceiptsAddressDto[]
}

/**
 * POST /admin/receipts-addresses/:id/release: the emails since removal the admin saw when they decided. Refused (409)
 * when more have arrived since.
 */
export interface ReleaseReceiptsAddressBody {
  receivedSinceRemoval: number
}

// ── Workspace payroll match (GitHub issue #22) ─────────────────────────────
// One payroll zip for the whole workspace and a month, matched against the payroll items of every engagement with a
// month for that period; each proof is filed once as a workspace document and linked from each item it proves. The
// reconciliation accounts for every person-pay found in the files. Owners run it; auditors read the reconciliation.

/** The files whose lines are person-pays: a register's rows, a bank statement's transactions, a pay stub. */
export const PAY_LINE_KINDS = ['payroll-register', 'paystub', 'bank-statement'] as const
export type PayLineKind = (typeof PAY_LINE_KINDS)[number]

/** Where a person-pay landed: on an item's proof, guessed for one (waiting for a person), on none, or not grant-funded. */
export type PayLineState = 'matched' | 'guessed' | 'unassigned' | 'not-funded'

export const PAY_LINE_STATE_LABELS: Record<PayLineState, string> = {
  matched: 'Matched',
  guessed: 'Guessed: check it',
  unassigned: 'Unassigned',
  'not-funded': 'Not grant-funded',
}

/** A payroll item of one engagement's month, as the workspace match and its reconciliation list it. */
export interface WorkspacePayrollItemDto {
  target: 'expense' | 'wex'
  id: string
  kind: 'staff' | 'participant'
  engagementId: string
  engagementName: string
  reportId: string
  period: string
  monthStatus: ReportStatus
  /** The item's task in plain words: "Expense ISY-12" or "Jordan Sample's work-experience pay". */
  title: string
  sub: string
  /** yyyy-mm-dd: the pay period, or a staff line's date twice. */
  start: string
  end: string
  amount: number
  /** The proofs already on file for it. */
  proved: PayrollSlot[]
}

/** An engagement's month for the period, with its status: a closed or submitted one is reopened before Save. */
export interface WorkspacePayrollMonthDto {
  reportId: string
  engagementId: string
  engagementName: string
  status: ReportStatus
}

/** One person-pay found in a file and where it landed. */
export interface PayLineDto {
  /** The kept line's id once saved; `<fileId>:<n>` while a match is open. */
  id: string
  /** The workspace document, once saved; null in an open match. */
  documentId: string | null
  /** The open match's file; null once saved. */
  fileId: string | null
  fileName: string
  kind: PayLineKind
  /** The line as the file prints it (a name and pay), with its box; null for a scanned pay stub. */
  mark: StatementLine | null
  state: PayLineState
  /**
   * The item it is on (matched) or guessed for. Null when matched in an open match to a work-experience payment Save
   * will create from this pay stub (see `WorkspacePayrollRunDto.plan.stubs`).
   */
  item: Pick<
    WorkspacePayrollItemDto,
    'target' | 'id' | 'engagementId' | 'engagementName' | 'reportId' | 'period' | 'title'
  > | null
  notFunded: { reason: string; by: string; at: string } | null
  /** What needs an owner's eye (PAY_LINE_FLAG_LABELS); flagged only, nothing is changed by a flag. */
  flags: PayLineFlag[]
  /** The person on the staff list this register row or bank line is of, when one is found. */
  staff: { id: string; name: string } | null
}

/** A workspace payroll match: the run's files, every open slot's match across the engagements, and the person-pays. */
export interface WorkspacePayrollRunDto extends PayrollMatchRunDto {
  workspaceId: string
  period: string
  /** What this change to the month's payroll files is (`WORKSPACE_PAYROLL_MODES`). */
  mode: WorkspacePayrollMode
  /** Replace all: how many different files (by contents) the zip holds, as the screen counted them; null otherwise. */
  expectedFiles: number | null
  items: WorkspacePayrollItemDto[]
  months: WorkspacePayrollMonthDto[]
  pays: PayLineDto[]
  /** What Save will do from the staff list and the participant lists, before anything is written. */
  plan: WorkspacePayrollPlanDto
}

/** Save: the proofs chosen, and the reason when a chosen item's month is closed or submitted and must be reopened. */
export interface WorkspacePayrollSaveInput extends PayrollMatchSaveInput {
  reopenReason?: string
}

/**
 * Each workspace month has one set of payroll files, and matching always comes from that set (owner's decision,
 * 2026-10-18). A change to the set is a run of one of these, checked and then saved; after any change the whole month
 * is matched again from the full set and written as a difference.
 * - replace: the uploaded zip becomes the set; files no longer in it leave.
 * - add: one or more files join the set (a file of the same name and kind takes the place of the one in the set).
 * - remove: one file leaves the set.
 * - match: the set is unchanged and matched again (a participant added, staff tagged).
 */
export const WORKSPACE_PAYROLL_MODES = ['replace', 'add', 'remove', 'match'] as const
export type WorkspacePayrollMode = (typeof WORKSPACE_PAYROLL_MODES)[number]

/** A month's set holds at most this many files; more is refused, never dropped. */
export const MAX_WORKSPACE_PAYROLL_FILES = 1000

/** POST /workspaces/:id/payroll/:period/match: start a change of the month's set by upload. */
export interface WorkspacePayrollStartInput {
  /** Default 'add'. */
  mode?: 'replace' | 'add'
  /** Replace all only, and required there: how many different files (by contents, sha256) the zip holds. */
  expected?: number
}

/** One file of a month's set. */
export interface WorkspacePayrollFileDto {
  id: string
  kind: PayrollDocumentKind
  fileName: string
  size: number
  /** The contents' sha256: the same file uploaded again is the same file. */
  sha256: string
  uploadedAt: string
  personal: boolean
}

/** GET /workspaces/:id/payroll/:period/files: the month's set. */
export interface WorkspacePayrollFilesDto {
  workspaceId: string
  period: string
  files: WorkspacePayrollFileDto[]
  /** Owners change the set; auditors read it. */
  can: { change: boolean }
}

/** Why an owner's decision on a file was dropped: the file's contents or name changed, or the file left the set. */
export type DroppedDecisionWhy = 'changed' | 'left'

export const DROPPED_DECISION_WHY_LABELS: Record<DroppedDecisionWhy, string> = {
  changed: 'The file changed',
  left: 'The file left the payroll files',
}

/**
 * An owner's decision (a proof linked by hand or a guess confirmed, or a pay marked not grant-funded) dropped because
 * the file it was made on changed or left the month's set. Kept while the same file (name and contents) stays.
 */
export interface DroppedDecisionDto {
  /** Null in a plan (not saved yet). */
  id: string | null
  fileName: string
  kind: PayrollDocumentKind
  decision: 'linked' | 'not-funded'
  why: DroppedDecisionWhy
  /** The item a linked proof was on ("Expense ISY-12"), and its engagement; null for not grant-funded. */
  itemTitle: string | null
  engagementName: string | null
  /** Who saved the change that dropped it, and when; null in a plan. */
  by: string | null
  at: string | null
}

/** The months of the workspace that can be matched, newest first. */
export interface WorkspacePayrollPeriodDto {
  period: string
  months: number
  payLines: number
}

/** The reconciliation of one month's payroll across the workspace. */
export interface PayrollReconciliationDto {
  workspaceId: string
  period: string
  pays: PayLineDto[]
  /** The bank statement's other lines (balances, vendor and card payments): no one's pay, counted and not listed. */
  otherBankLines: number
  /** Engagement payroll items with a proof still missing, and which. */
  unproved: { item: WorkspacePayrollItemDto; missing: PayrollSlot[] }[]
  /**
   * The books against the payroll files, per engagement, run and kind of payroll: the books' payroll transactions of a
   * run (by their date) and what the match put on the month for it (the staff lines it wrote, the participants'
   * payments). Null on a side that has none.
   */
  books: BooksRunDto[]
  /** Every engagement payroll item of the month and the proofs it needs (`item.proved` says which are on file). */
  items: { item: WorkspacePayrollItemDto; needed: PayrollSlot[] }[]
  counts: Record<PayLineState, number> & { unproved: number; flagged: number }
  /**
   * People on the staff list who are on no engagement: their pay in these files proves nothing (`inFiles`), or they
   * are on the list alone. Tag them to an engagement, then match again.
   */
  staffOnNoEngagement: {
    id: string
    name: string
    inFiles: boolean
    /** Their pay on the register rows found this month (gross); null when none was found. */
    paid: number | null
    /** What payroll details charges the program for them this month: grant pay on no engagement. Null: none. */
    charged: number | null
  }[]
  /** Decisions dropped because their file changed or left the month's set, newest first. */
  dropped: DroppedDecisionDto[]
  /** Payroll items with two different files as one proof (the bookkeeper's and the match's), for the owner to check. */
  twoProofs: TwoProofsDto[]
  /** Files of the month that reached MAX_PAY_LINES: lines after it were not read. */
  filesOverLineCap: { documentId: string; fileName: string }[]
  /** Owners fix and mark; auditors read. */
  can: { change: boolean }
}

/** One run's payroll of one kind on an engagement: the books' amount and the payroll files' (the match's). */
export interface BooksRunDto {
  engagementId: string
  engagementName: string
  reportId: string
  /** The run's pay date (yyyy-mm-dd), as the books date it. */
  date: string
  kind: PayrollBudgetKind
  books: number | null
  files: number | null
}

/** Fix by hand: link a person-pay to an engagement's payroll item. */
export interface PayLineLinkInput {
  target: 'expense' | 'wex'
  id: string
}

/**
 * What a pay in the files is flagged for (GitHub issue #22): nothing is changed by a flag, an owner looks at it.
 * A pay stub: its pay or pay period could not be read, it names nobody on an engagement's participant list, it names
 * someone on more than one, the participant's engagement has no month for the period, it was paid in another month
 * (a pay belongs to the month of its pay date, owner's decision, 2026-10-19), or its pay is not what the
 * payroll register pays them (a bank statement shows one debit per pay run, never a line per person). A register row or bank line: the person is on the staff list but on no engagement, or on no list at all.
 */
export const PAY_LINE_FLAGS = [
  'stub-unreadable',
  'no-participant',
  'several-participants',
  'no-month',
  'other-month',
  'register-disagrees',
  'duplicate',
  'named-by-ai',
  'staff-untagged',
  'not-on-a-list',
  'several-people',
  'pay-unclear',
] as const
export type PayLineFlag = (typeof PAY_LINE_FLAGS)[number]
/** The flags a pay stub's line keeps from the match that read it (the rest are worked out when the page opens). */
export type StubFlag = Extract<
  PayLineFlag,
  | 'stub-unreadable'
  | 'no-participant'
  | 'several-participants'
  | 'no-month'
  | 'other-month'
  | 'register-disagrees'
  | 'duplicate'
  | 'named-by-ai'
>

export const PAY_LINE_FLAG_LABELS: Record<PayLineFlag, string> = {
  'stub-unreadable': "The pay or pay period can't be read",
  'no-participant': 'Pay stub names someone on no participant list',
  'several-participants': 'Names someone on more than one participant list',
  'no-month': "The participant's engagement has no month for it",
  'other-month': "Paid in another month: it belongs to that month's payroll",
  'register-disagrees': 'The pay stub and the payroll register disagree',
  'named-by-ai': '✨ Matched to this person by AI: check the name',
  duplicate: 'A payment for this pay period is already on the month',
  'staff-untagged': 'On the staff list, on no engagement',
  'not-on-a-list': 'Names nobody on the staff or participant lists',
  'several-people': 'Fits more than one person on the lists',
  'pay-unclear': "Can't tell which amount is this period's pay",
}

// ── Staff and engagement staffing (GitHub issue #22) ───────────────────────
// The owner's list of the company's staff (records, not accounts) and the engagements each works on. The workspace
// payroll match links each person's timesheet, register row and bank line to the staff payroll lines of every
// engagement they are on. Owners change it; owners and auditors read it; a bookkeeper sees none of it.

/** The report lines a staff member's pay is charged on: their proofs are linked to these expense lines. */
export const STAFF_REPORT_LINES = [
  'staff-salaries',
  'staff-fringe',
] as const satisfies readonly ReportLine[]

/** One person on the staff list, with the engagements they work on. */
export interface StaffMemberDto {
  id: string
  /** Unique in the workspace, whatever its case; the payroll files are matched by it. No employee number is kept. */
  name: string
  role: string | null
  engagements: { id: string; name: string }[]
  /** Named in saved payroll proof: they can't be removed from the list (their engagements can still change). */
  inSavedProof: boolean
}

/** GET /workspaces/:id/staff and every staff change's answer. */
export interface StaffListDto {
  workspaceId: string
  staff: StaffMemberDto[]
  /** The workspace's engagements, for "+ Add person" and "+ Add engagement". */
  engagements: { id: string; name: string; code: string | null; status: EngagementStatus }[]
  /** Owners change it; auditors read. */
  can: { change: boolean }
}

/** One person to add (a pasted row) or a person's new details. An empty role is none. */
export interface StaffInput {
  name: string
  role?: string | null
}

/** POST /workspaces/:id/staff: the paste import, every row at once. */
export interface StaffAddInput {
  staff: StaffInput[]
}

/**
 * One problem of a paste import or an edit, beside its field. A 400's body carries every problem at once:
 * `{ message, problems: StaffInputProblem[] }` (`row` is 1-based; 1 for an edit).
 */
export interface StaffInputProblem {
  row: number
  field: 'name' | 'role'
  message: string
}

/** Someone a payroll register names who is not on the staff list, offered for the paste import. */
export interface StaffSuggestionDto {
  name: string
  fileName: string
}

/** Where one proof was found in a file of the run: the file, and the line on it (null: the file names them, no line). */
export interface ProofSpotDto {
  fileId: string
  mark: StatementLine | null
  /** The pay run's bank debit: one line everyone paid in the run shares. */
  run?: boolean
  /** The pay date (yyyy-mm-dd) of the pay run it is of, when it is one run's: a register row, a time report, a debit. */
  payDate?: string | null
  /** Where it was found, when not by the rules: AI read it (marked ✨), or the payroll company's payroll details. */
  source?: 'ai' | 'details'
  /** With a source: the amount on that line, so a person found on several lines of one file can tell them apart. */
  amount?: number | null
}

/**
 * A payroll item with two different files as one proof (owner's decision, 2026-10-19): the one already on it (the
 * bookkeeper's) and the owner's from the payroll files. Both are kept; the owner checks which is right.
 */
export interface TwoProofsDto {
  target: 'expense' | 'wex'
  id: string
  title: string
  engagementName: string
  reportId: string
  slot: PayrollSlot
  /** "Casey Demo's pay has two different pay stubs: check which is right". */
  message: string
}

/** Someone a payroll register pays who is on no list (not the staff list, a participant list or a pay stub). */
export interface UnlistedPersonDto {
  name: string
  register: ProofSpotDto[]
  timesheet: ProofSpotDto[]
}

/** What the workspace payroll match found of one person on the staff list, before Save. */
export interface StaffFoundDto {
  staffId: string
  name: string
  engagements: { id: string; name: string }[]
  /** Their pay on the register rows found (the largest amount on each row, the gross), added up; null when none. */
  pay: number | null
  /** The run's files each proof was found in. */
  timesheet: string[]
  register: string[]
  bank: string[]
  /** Bank statements with a line of their pay's amount but not their name: a guess, checked in the reconciliation. */
  bankGuess: string[]
  /** Their pay on each run's register (gross), by the run's pay date, in pay date order; `pay` is the month's total. */
  payByRun: { payDate: string | null; amount: number }[]
  /** What payroll details charge to the grant for them, per run (#22, section 8); empty when none, or no file was given. */
  charged: { start: string | null; end: string | null; amount: number }[]
  /** Where each proof was found, line by line (one per run), for the screen's "Found, page N" and Show. */
  found: {
    timesheet: ProofSpotDto[]
    register: ProofSpotDto[]
    bank: ProofSpotDto[]
    bankGuess: ProofSpotDto[]
  }
}

/** What Save will do with one pay stub: the participant it names, and their work-experience payment from it. */
export interface StubPayDto {
  /** The run's file. */
  fileId: string
  fileName: string
  participant: {
    id: string
    name: string
    participantId: string
    engagementId: string
    engagementName: string
  } | null
  /** yyyy-mm-dd, as read from the stub; null when it could not be read. */
  payPeriodStart: string | null
  payPeriodEnd: string | null
  /** The payroll run it was paid in: the pay date it prints, else its period's end. */
  payDate: string | null
  /** Where its pay was read: by the rules, or by AI (marked ✨). */
  source: 'rules' | 'ai'
  grossAmount: number | null
  /** create: a new payment; update: the payment from this stub (or the same pay period typed by hand) changes; same: nothing to change; none: flagged. */
  action: 'create' | 'update' | 'same' | 'none'
  /** The payment it is, once there is one. */
  wexPaymentId: string | null
  /** The month it goes on. */
  reportId: string | null
  flags: StubFlag[]
  /** The payment's amount before Save (update and same); null for a new one or none. */
  previousAmount: number | null
  /** The stub's pay line, for Show; null when it was scanned. */
  payLine: StatementLine | null
  /** The pay run's bank debit Save links to the payment as its bank line; null when none was found. */
  bank: ProofSpotDto | null
  /** Their timesheet line Save attaches; null when none was found. */
  timesheet: ProofSpotDto | null
  /** Their register row Save attaches, else the run's register at its stated total (`run`); null when none. */
  register: ProofSpotDto | null
  /** The name the stub prints, when it can be read (a stub naming someone on no list shows it). */
  named: string | null
}

/** One file of the month's set after Save, and the engagements its proof links reach: none, it is matched to nothing. */
export interface PlanFileDto {
  fileId: string
  fileName: string
  kind: PayrollDocumentKind
  engagements: { id: string; name: string }[]
}

/** One file Save attaches to a payroll item, as which proof, and whose line on it led there. */
export interface PlanProofFileDto {
  fileId: string
  fileName: string
  kind: PayrollDocumentKind
  slot: PayrollSlot
  /** The tagged staff (a staff line) or the participant (their payment) whose line it is; empty for Auto-Match's pick. */
  people: string[]
}

/** The proof Save attaches to one payroll item (the links it adds or changes). */
export interface PlanProofDto {
  target: 'expense' | 'wex'
  /** The item; null for the work-experience payment a pay stub makes (`stubFileId`). */
  id: string | null
  stubFileId: string | null
  title: string
  engagementId: string
  engagementName: string
  reportId: string
  files: PlanProofFileDto[]
}

/** The staff and participant work Save will do, worked out from the lists and the files. */
export interface WorkspacePayrollPlanDto {
  staff: StaffFoundDto[]
  stubs: StubPayDto[]
  /** How many proof links Save will add or change (each person's proofs on each engagement's staff payroll lines). */
  links: number
  /** How many proof links Save will remove: the match no longer finds them, or their file leaves the set. */
  unlinks: number
  /** Every file of the set after Save, with the engagements it reaches; only those reach an engagement's records. */
  files: PlanFileDto[]
  /** The links Save adds or changes (`links`), by payroll item. */
  proof: PlanProofDto[]
  /** The set after Save: the files that join it, those that leave it (and why), and how many stay as they are. */
  change: {
    joining: { fileId: string; fileName: string; kind: PayrollDocumentKind }[]
    leaving: {
      documentId: string
      fileName: string
      kind: PayrollDocumentKind
      why: DroppedDecisionWhy
    }[]
    unchanged: number
    /** How many files the set holds after Save (at most MAX_WORKSPACE_PAYROLL_FILES). */
    total: number
  }
  /** Work-experience payments from pay stubs Save makes, changes and removes (a payment typed by hand is never removed). */
  payments: { create: number; update: number; remove: number }
  /**
   * The month's payroll on the budget (owner's decisions, 2026-10-20): the lines Save writes or changes from payroll
   * details, and the payroll lines already on a month that the match now counts, which Save keeps for reconciliation
   * only so the same pay is not counted twice.
   */
  payrollLines: {
    write: number
    keep: {
      reportId: string
      engagementName: string
      itemNumber: string
      date: string
      amount: number
      kind: PayrollBudgetKind
    }[]
  }
  /** The owner's decisions Save drops, because their file changed or leaves the set. */
  dropped: DroppedDecisionDto[]
  /** Every engagement month whose proof or payments Save changes; only these are touched. */
  months: WorkspacePayrollMonthDto[]
  /** Closed or submitted months Save will reopen, with the owner's reason, to make those changes. */
  reopen: WorkspacePayrollMonthDto[]
  /**
   * Proofs Save attaches that are already on file: the same file (by its contents) is on the item, or filed on its
   * month by the bookkeeper and linked from there instead of a copy.
   */
  alreadyOnFile: number
  /** Items Save leaves with two different files as one proof, for the owner to check. */
  twoProofs: TwoProofsDto[]
  /** People the registers pay who are on no list: on no engagement until added to the staff list and tagged. */
  unlisted: UnlistedPersonDto[]
  /** Replace all: every file of the zip has arrived (`expectedFiles`); Save is refused until then. Always true otherwise. */
  complete: boolean
}

/** Which of a person's proofs were found in the month's saved payroll files. */
export interface StaffProofFound {
  timesheet: boolean
  register: boolean
  bank: boolean
}

/** One person tagged to an engagement, on its card. */
export interface EngagementCardStaffDto {
  staffId: string
  name: string
  role: string | null
  /** Their pay found in the files (register rows, gross); null when none was found. Never split across engagements. */
  pay: number | null
  /** What payroll details charges to the grant for them this month (#22, section 8); null when it charges none. */
  charged: number | null
  proof: StaffProofFound
  /** The other engagements they are tagged to ("also on …"). */
  alsoOn: { id: string; name: string }[]
}

/** One engagement's card for the month: its staff payroll charge against the pay in the files. */
export interface EngagementPayrollCardDto {
  engagementId: string
  engagementName: string
  engagementCode: string | null
  reportId: string
  monthStatus: ReportStatus
  /** Its staff payroll lines this month (Staff Salaries and Staff Fringe Benefits, the amount charged to the program). */
  charged: number
  /** What payroll details charges to the grant this month for the staff tagged to it (a shared person on each card). */
  chargedByDetails: number
  /** The month page's budget table: each budget line's approved amount, spent before, this month and what is left. */
  lines: BudgetLineRow[]
  /** Work experience: the payments on its month, those of earlier months, and its approved WEX budget lines. */
  wex: { thisMonth: number; payments: number; before: number; approved: number }
  staffBudget: {
    /** The approved budget lines on those report lines. */
    approved: number
    /** Charged on them in the months before this one. */
    chargedBefore: number
    /** Left after this month; below zero, how much over. */
    left: number
  }
  staff: EngagementCardStaffDto[]
  /** The pay found for everyone tagged to it (each person's full pay: an upper bound). */
  payFound: number
  /** ✓ Covered by the payroll files: charged is not more than `payFound`. */
  covered: boolean
}

/** Shown above the cards for each group of engagements that share staff and are charged more than those people's pay. */
export const SHARED_STAFF_OVERCHARGED_LABEL =
  'Charged more than the pay in the files across engagements'

/** GET /workspaces/:id/payroll/:period/engagements: one card per engagement with a month for the period. */
export interface WorkspacePayrollOutputDto {
  workspaceId: string
  period: string
  engagements: EngagementPayrollCardDto[]
  /**
   * The workspace-level check (each card counts a shared person's full pay, so two cards can both look covered): for
   * each group of engagements that share tagged staff, flagged when the charges on those engagements add up to more
   * than the pay found for everyone tagged to them. Names the engagements only, never anyone's pay.
   */
  sharedStaffOvercharged: { engagements: { id: string; name: string }[] }[]
}
