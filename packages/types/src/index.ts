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
export const personalRolesFor = (kind: string): ReadonlySet<Role> =>
  kind === 'paystub' ? new Set<Role>(['owner', 'bookkeeper', 'auditor']) : PERSONAL_DOCUMENT_ROLES

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
}

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
    workspace: { id: string; name: string; featuredDemo?: boolean }
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
}

export interface ImportResultDto {
  imported: number
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
  personal: 'Personal, not for this grant',
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
}

/** The highlights in force for one proof type, and who last set them (null: the defaults). */
export interface HighlightSettingDto {
  kind: PayrollDocumentKind
  fields: HighlightField[]
  changedByEmail: string | null
  changedAt: string | null
}

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
}

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
