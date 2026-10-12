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

// ── Budget narrative categories ─────────────────────────────────────────────
// The categories of the agency's budget narrative form, and the report line each rolls into. The agency
// should confirm this crosswalk (product brief, section 12).

export const BUDGET_CATEGORIES = [
  'personnel',
  'fringe',
  'travel',
  'equipment',
  'supplies',
  'contractual',
  'participant-training',
  'other',
  'indirect',
  'wex',
] as const
export type BudgetCategory = (typeof BUDGET_CATEGORIES)[number]

export const BUDGET_CATEGORY_LABELS: Record<BudgetCategory, string> = {
  personnel: 'Personnel',
  fringe: 'Fringe Benefits',
  travel: 'Travel',
  equipment: 'Equipment',
  supplies: 'Supplies',
  contractual: 'Contractual / Subawards',
  'participant-training': 'Participant / Training Costs',
  other: 'Other Costs',
  indirect: 'Indirect Costs',
  wex: 'Work Experience (WEX)',
}

export const BUDGET_CATEGORY_TO_LINE: Record<BudgetCategory, ReportLine> = {
  personnel: 'staff-salaries',
  fringe: 'staff-fringe',
  travel: 'program-costs',
  equipment: 'program-costs',
  supplies: 'program-costs',
  contractual: 'program-costs',
  'participant-training': 'program-costs',
  other: 'program-costs',
  indirect: 'indirect',
  wex: 'wex',
}

// ── Expenses and documents ──────────────────────────────────────────────────

export const ALLOCATION_TYPES = ['direct', 'payroll', 'usage'] as const
export type AllocationType = (typeof ALLOCATION_TYPES)[number]

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

export const REPORT_STATUSES = [
  'draft',
  'submitted',
  'under-review',
  'approved',
  'denied',
  'paid',
] as const
export type ReportStatus = (typeof REPORT_STATUSES)[number]

/** Where an engagement is in its life: proposed (nothing awarded yet), awarded, active (contract signed, months running), closed. */
export const ENGAGEMENT_STATUSES = ['proposed', 'awarded', 'active', 'closed'] as const
export type EngagementStatus = (typeof ENGAGEMENT_STATUSES)[number]

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
  'participant-file-incomplete',
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
    "Records spending, attaches proof, submits the monthly report and records the funder's decision.",
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

/** Fictional "source of funds" boxes a new workspace starts with. Its owners edit the list. */
export const DEFAULT_FUNDING_SOURCES = [
  'Youth Workforce Fund',
  'Adult Training Fund',
  'Apprenticeship Readiness Fund',
  'Employer Partnership Fund',
  'State General Fund',
]

/** Roles that may open a 'personal' document. A bookkeeper attaches them; they do not read them back. */
export const PERSONAL_DOCUMENT_ROLES: ReadonlySet<Role> = new Set(['owner', 'auditor'])

// ── API shapes ──────────────────────────────────────────────────────────────

export interface Me {
  userId: string
  /** The version of the Terms now in force: the fingerprint of their wording, computed by the API. */
  termsVersion: string
  /** Whether this person has accepted that version; the app shows nothing else until they have. */
  termsAccepted: boolean
  /** True when they accepted an older version but not the current one: the prompt says the Terms were updated. */
  termsPreviouslyAccepted: boolean
  memberships: { workspaceId: string; workspaceName: string; role: Role }[]
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
  reportLine: ReportLine
}

export interface ExpenseDto extends ExpenseInput {
  id: string
  memo: string | null
  account: string | null
  allocationNote: string | null
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
  documents: AttachedDocument<DocumentPurpose>[]
}

export interface ReportSummary {
  id: string
  period: string
  status: ReportStatus
  dueDate: string
  submittedAt: string | null
  billedThisPeriod: number
  expenseCount: number
  openBlockers: number
  openAttention: number
}

export interface EngagementSummary {
  id: string
  workspaceId: string
  workspaceName: string
  kind: EngagementKind
  name: string
  funder: string | null
  /** The funder's contract number, once the contract exists. */
  number: string | null
  status: EngagementStatus
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
  fundingSources: string[]
  /** The workspace's "source of funds" list, for the printed form's boxes. */
  fundingOptions: string[]
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
    category: BudgetCategory
    reportLine: ReportLine
    amount: number
    narrative: string | null
  }[]
  participants: ParticipantDto[]
  /** Owners and bookkeepers: may change the engagement, add months and participants. */
  canManage: boolean
}

/** A new or changed engagement. Everything but the kind, the name and the workspace may come later. */
export interface EngagementInput {
  workspaceId: string
  kind: EngagementKind
  name: string
  funder?: string | null
  funderContact?: string | null
  solicitation?: string | null
  requestedAmount?: number | null
  /** YYYY-MM-DD */
  proposalSubmittedOn?: string | null
  awardedOn?: string | null
  awardAmount?: number | null
  number?: string | null
  periodStart?: string | null
  periodEnd?: string | null
  fundingSources?: string[]
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
  /** The caller's own role in it. */
  myRole: Role | null
  memberCount: number
  engagementCount: number
  fundingSources: string[]
  /** Owners: people, lists, settings. */
  canManage: boolean
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

/** One line of the workspace's access log. */
export interface ActivityEntry {
  id: string
  at: string
  actorName: string
  action: string
  resource: string
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
}

/** The funder's review section of the monthly report form, as it came back. */
export interface ReportReview {
  receivedOn?: string
  newServicesEntered?: boolean
  newEnrollmentsEntered?: boolean
  servicesInProgress?: boolean
  caseNotesChecked?: boolean
  fileReviewCompleted?: boolean
  siteVisitConducted?: boolean
  invoiceNumber?: string
}

export interface ReportDetail {
  id: string
  period: string
  status: ReportStatus
  dueDate: string
  submittedAt: string | null
  preparedByName: string | null
  authorizedByName: string | null
  authorizedAt: string | null
  comments: string | null
  review: ReportReview | null
  reviewedAt: string | null
  deniedReason: string | null
  isFinal: boolean
  engagement: {
    id: string
    kind: EngagementKind
    name: string
    number: string | null
    funder: string | null
    periodStart: string | null
    periodEnd: string | null
    fundingSources: string[]
    fundingOptions: string[]
    reportDueDay: number
    awardAmount: number | null
    workspace: { id: string; name: string }
    eligibilityItems: EligibilityItemDef[]
    reportTo: string | null
    preparerName: string | null
    preparerOrganization: string | null
    authorizerName: string | null
    authorizerOrganization: string | null
  }
  lines: LineRow[]
  expenses: ExpenseDto[]
  wexPayments: WexPaymentDto[]
  checks: CheckDto[]
  participants: ParticipantDto[]
  /** The workspace's documents, for attaching. */
  documents: DocumentDto[]
  /** `review`: may record the funder's decision on a submitted month. */
  can: { edit: boolean; submit: boolean; review: boolean; reopen: boolean }
}
