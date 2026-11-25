import type { EngagementInput } from '@ad/types'
import { BodyReader } from '../core/body'

const TEXT_FIELDS = [
  'funder',
  'funderContact',
  'solicitation',
  'number',
  'code',
  'indirectTerms',
  'reportTo',
  'submissionMethod',
  'preparerName',
  'preparerOrganization',
  'authorizerName',
  'authorizerOrganization',
  'proposalSubmittedOn',
  'awardedOn',
  'periodStart',
  'periodEnd',
] as const
const NUMBER_FIELDS = ['requestedAmount', 'awardAmount', 'reportDueDay'] as const

/**
 * The body of POST /engagements (`partial` false) or PATCH /engagements/:id (`partial` true), with the type of each
 * field checked. A partial body keeps only the fields it has, so the update changes only those. The workspace is
 * read on a new engagement only: an engagement never moves to another workspace.
 */
export function parseEngagementBody(body: unknown, partial: false): EngagementInput
export function parseEngagementBody(body: unknown, partial: true): Partial<EngagementInput>
export function parseEngagementBody(body: unknown, partial: boolean): Partial<EngagementInput> {
  const r = new BodyReader(body)
  const out: Record<string, unknown> = {}
  const optional = { optional: true, nullable: true }
  if (!partial) out.workspaceId = r.string('workspaceId')
  for (const k of ['kind', 'name'] as const)
    if (!partial || r.has(k)) out[k] = r.string(k, { optional: partial })
  for (const k of TEXT_FIELDS) if (r.has(k)) out[k] = r.string(k, optional)
  for (const k of NUMBER_FIELDS) if (r.has(k)) out[k] = r.numberLike(k, optional)
  if (r.has('tracks')) out.tracks = r.strings('tracks', { optional: true })
  if (r.has('waivers')) out.waivers = r.textMap('waivers', optional)
  // Checked whole by cleanTags and cleanEligibilityItems, which take any value.
  if (r.has('tags')) out.tags = r.any('tags')
  if (r.has('eligibilityItems')) out.eligibilityItems = r.any('eligibilityItems')
  r.done()
  return out as Partial<EngagementInput>
}

/** The body of POST /engagements/:id/reports. */
export function parseReportBody(body: unknown): { period: string } {
  const r = new BodyReader(body)
  const period = r.string('period')
  r.done()
  return { period }
}

/** The body of POST /engagements/:id/participants. */
export function parseParticipantBody(body: unknown): {
  participantId: string
  displayName: string
  enrollmentStatus?: string
  tags?: unknown
} {
  const r = new BodyReader(body)
  const participantId = r.string('participantId')
  const displayName = r.string('displayName')
  const enrollmentStatus =
    r.string('enrollmentStatus', { optional: true, nullable: true }) ?? undefined
  const tags = r.any('tags')
  r.done()
  return { participantId, displayName, enrollmentStatus, tags }
}
