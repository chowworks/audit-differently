import type { CreateWorkspaceRequest, Role } from '@ad/types'
import { BodyReader } from '../core/body'

/**
 * The bodies of the workspace routes and the platform admin's (GitHub issue #107), with the type of each field checked
 * before the service reads it. The service still checks the values (an email's form, a role of the list, a name's
 * length). A field the service asks for in plain words when it is missing ("An email address is needed") is optional
 * here, so it keeps that message.
 */

const optional = { optional: true, nullable: true }

/** POST /workspaces (platform admins): the workspace's name, and its first owner by email. */
export function parseCreateWorkspaceBody(body: unknown): CreateWorkspaceRequest {
  const r = new BodyReader(body)
  const name = r.string('name', optional) ?? ''
  const ownerEmail = r.string('ownerEmail', optional) ?? ''
  const ownerName = r.string('ownerName', optional) ?? undefined
  r.done()
  return { name, ownerEmail, ownerName }
}

/** PATCH /workspaces/:id and /admin/workspaces/:id: the new name. */
export function parseRenameBody(body: unknown): string {
  const r = new BodyReader(body)
  const name = r.string('name', optional) ?? ''
  r.done()
  return name
}

/**
 * PATCH /workspaces/:id/lists and /admin/workspaces/:id/lists: each card saves its own list, so only the fields sent
 * are kept. The tag types are checked whole by cleanTagTypes, which takes any value.
 */
export function parseListsBody(body: unknown): {
  tagTypes?: unknown
  receiptsAddress?: string | null
  readEmailedReceiptsWithAi?: boolean
} {
  const r = new BodyReader(body)
  const out: {
    tagTypes?: unknown
    receiptsAddress?: string | null
    readEmailedReceiptsWithAi?: boolean
  } = {}
  if (r.has('tagTypes')) out.tagTypes = r.any('tagTypes')
  if (r.has('receiptsAddress')) out.receiptsAddress = r.string('receiptsAddress', optional)
  if (r.has('readEmailedReceiptsWithAi'))
    out.readEmailedReceiptsWithAi = r.boolean('readEmailedReceiptsWithAi') as boolean
  r.done()
  return out
}

/** POST /workspaces/:id/suggestions: what to add to the lists. */
export function parseSuggestionBody(body: unknown): string {
  const r = new BodyReader(body)
  const text = r.string('text', optional) ?? ''
  r.done()
  return text
}

/** POST /workspaces/:id/members and /admin/workspaces/:id/members: who, by email, and their role. */
export function parseMemberBody(body: unknown): {
  email: string
  displayName?: string
  role: Role
} {
  const r = new BodyReader(body)
  const email = r.string('email', optional) ?? ''
  const displayName = r.string('displayName', optional) ?? undefined
  const role = r.string('role') as Role
  r.done()
  return { email, displayName, role }
}

/** PATCH /workspaces/:id/members/:userId and /admin/…: the member's new role. */
export function parseRoleBody(body: unknown): Role {
  const r = new BodyReader(body)
  const role = r.string('role') as Role
  r.done()
  return role
}
