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
  // cleanTags checks that each tag is one of the workspace's; here only that it is a list of text (null clears).
  if (r.has('tags')) out.tags = r.strings('tags', optional)
  if (r.has('eligibilityItems')) out.eligibilityItems = checklist(r)
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
  const tags = r.strings('tags', { optional: true, nullable: true })
  r.done()
  return { participantId, displayName, enrollmentStatus, tags }
}

/**
 * The eligibility checklist: a list of objects whose `label` and `key` are text and `required` is true or false.
 * cleanEligibilityItems turns any value into text or a boolean, so a label of 123 or a `required` of "false" would
 * be saved as a different checklist. Each item is checked on its own, so one try names every problem. A property
 * left out keeps its default there (the key from the label, not required); the values (a label's length, the number
 * of items) are still checked there.
 */
function checklist(r: BodyReader): unknown {
  const items = r.any('eligibilityItems')
  if (!Array.isArray(items)) {
    r.problem('eligibilityItems', 'eligibilityItems must be a list')
    return items
  }
  items.forEach((item: unknown, i) => {
    const at = `eligibilityItems[${i}]`
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      r.problem(at, `${at} must be an object`)
      return
    }
    const entry = item as Record<string, unknown>
    for (const k of ['label', 'key'] as const)
      if (entry[k] !== undefined && typeof entry[k] !== 'string')
        r.problem(`${at}.${k}`, `${at}.${k} must be text`)
    if (entry.required !== undefined && typeof entry.required !== 'boolean')
      r.problem(`${at}.required`, `${at}.required must be true or false`)
  })
  return items
}
