/**
 * Applies ops/monitoring.ts to Better Stack Uptime: one monitor per check, all in one monitor group, and a row per
 * check in this product's section of the shared status page. Run by CI on pushes to main; see docs/monitoring.md.
 * Adapted from Interview Differently's scripts/betterstack-sync.ts.
 *
 *   node scripts/betterstack-sync.ts [--dry-run]
 *
 * Needs BETTERSTACK_API_TOKEN (a team-scoped Uptime API token) and API_URL (the API's public address); without either
 * it says so and exits 0. --dry-run lists what it would change and changes nothing (it still reads the account).
 * Idempotent: it creates what is missing and updates what changed. It never deletes: a monitor on our API or in our
 * group, or a row in our section, that is not in the list is reported for the owner to remove by hand. Other
 * products' sections and rows on the shared page are not ours and are left alone without comment.
 *
 * Uses only what Better Stack's Uptime API docs show (JSON:API bodies, Bearer token):
 *   https://betterstack.com/docs/uptime/api/
 *   https://betterstack.com/docs/uptime/api/pagination/
 *   https://betterstack.com/docs/uptime/api/list-all-existing-monitors/
 *   https://betterstack.com/docs/uptime/api/create-a-new-monitor/
 *   https://betterstack.com/docs/uptime/api/update-an-existing-monitor/
 *   https://betterstack.com/docs/uptime/api/list-all-existing-monitor-groups/
 *   https://betterstack.com/docs/uptime/api/create-a-new-monitor-group/
 *   https://betterstack.com/docs/uptime/api/list-all-existing-status-pages/
 *   https://betterstack.com/docs/uptime/api/create-a-new-status-page/
 *   https://betterstack.com/docs/uptime/api/list-existing-sections-of-a-status-page/
 *   https://betterstack.com/docs/uptime/api/create-a-new-status-page-section/
 *   https://betterstack.com/docs/uptime/api/list-existing-resources-of-a-status-page/
 *   https://betterstack.com/docs/uptime/api/create-a-new-status-page-resource/
 *   https://betterstack.com/docs/uptime/api/update-an-existing-status-page-resource/
 */
import { pathToFileURL } from 'node:url'
import { monitoring, type Monitoring } from '../ops/monitoring.ts'

const API = 'https://incidents.betterstack.com/api/v2'

export interface Remote<A> {
  id: string
  attributes: A
}
export interface MonitorAttrs {
  url: string
  pronounceable_name: string
  monitor_type: string
  email: boolean
  check_frequency: number
  monitor_group_id?: number | string | null
}
export interface MonitorGroupAttrs {
  name: string
}
export interface StatusPageAttrs {
  company_name: string
  subdomain: string
}
export interface SectionAttrs {
  name: string
}
export interface ResourceAttrs {
  status_page_section_id: number | string
  resource_id: number | string
  resource_type: string
  public_name: string
  /** The help-icon text; read back only if Better Stack returns it (then a change is updated). */
  explanation?: string | null
}

/** One write. `key` names the thing in ops/monitoring.ts; `id` is the existing record's, for an update. */
export interface Change {
  action: 'create' | 'update'
  label: string
  key: string
  id?: string
  path: string
  body: Record<string, unknown>
}

export interface Plan {
  changes: Change[]
  /** Ids of records that already match, by key. */
  unchanged: Map<string, string>
  /** Things that look like ours but are not in the list: reported, never deleted. */
  extras: string[]
}

export interface DesiredMonitor {
  url: string
  name: string
  explanation: string
}

export function desiredMonitors(config: Monitoring): DesiredMonitor[] {
  return config.checks.map((c) => ({
    url: config.apiBase + c.path,
    name: `${config.platform} · ${c.name}`,
    explanation: c.explanation,
  }))
}

const emptyPlan = (): Plan => ({ changes: [], unchanged: new Map(), extras: [] })

/** The fields given only when they differ from the remote record. */
function diff(want: Record<string, unknown>, have: object): Record<string, unknown> {
  const h = have as Record<string, unknown>
  return Object.fromEntries(Object.entries(want).filter(([k, v]) => String(h[k]) !== String(v)))
}

const explain = (changed: Record<string, unknown>, have: object) =>
  Object.keys(changed)
    .map(
      (k) =>
        `${k}: ${JSON.stringify((have as Record<string, unknown>)[k])} -> ${JSON.stringify(changed[k])}`
    )
    .join(', ')

/** Ids are strings in responses; the docs give them as integers in requests. */
const asInt = (id: string) => (/^\d+$/.test(id) ? Number(id) : id)

/** Our monitor group, matched by name. Keyed by name. */
export function planMonitorGroup(config: Monitoring, remote: Remote<MonitorGroupAttrs>[]): Plan {
  const plan = emptyPlan()
  const name = config.monitorGroup
  const group = remote.find((g) => g.attributes.name === name)
  if (group) plan.unchanged.set(name, group.id)
  else
    plan.changes.push({
      action: 'create',
      label: `monitor group "${name}"`,
      key: name,
      path: '/monitor-groups',
      body: { name },
    })
  return plan
}

/**
 * Monitors, matched by URL, else by name (so a rename or a moved URL updates in place), all in our monitor group.
 * Keyed by URL.
 */
export function planMonitors(
  config: Monitoring,
  groupId: string,
  remote: Remote<MonitorAttrs>[]
): Plan {
  const plan = emptyPlan()
  const desired = desiredMonitors(config)
  const used = new Set<string>()
  const match = new Map<string, Remote<MonitorAttrs>>()
  const claim = (d: DesiredMonitor, by: (r: Remote<MonitorAttrs>) => boolean) => {
    if (match.has(d.url)) return
    const m = remote.find((r) => !used.has(r.id) && by(r))
    if (m) {
      used.add(m.id)
      match.set(d.url, m)
    }
  }
  for (const d of desired) claim(d, (r) => r.attributes.url === d.url)
  for (const d of desired) claim(d, (r) => r.attributes.pronounceable_name === d.name)
  for (const d of desired) {
    const want = {
      url: d.url,
      pronounceable_name: d.name,
      monitor_type: 'status',
      email: true,
      check_frequency: config.checkFrequency,
      monitor_group_id: asInt(groupId),
    }
    const m = match.get(d.url)
    if (!m) {
      plan.changes.push({
        action: 'create',
        label: `monitor "${d.name}" ${d.url}`,
        key: d.url,
        path: '/monitors',
        body: want,
      })
      continue
    }
    const changed = diff(want, m.attributes)
    if (Object.keys(changed).length === 0) plan.unchanged.set(d.url, m.id)
    else
      plan.changes.push({
        action: 'update',
        label: `monitor "${m.attributes.pronounceable_name}" (${explain(changed, m.attributes)})`,
        key: d.url,
        id: m.id,
        path: `/monitors/${m.id}`,
        body: changed,
      })
  }
  for (const r of remote)
    if (
      !used.has(r.id) &&
      (r.attributes.url?.startsWith(config.apiBase + '/') ||
        String(r.attributes.monitor_group_id) === groupId)
    )
      plan.extras.push(
        `monitor "${r.attributes.pronounceable_name}" ${r.attributes.url} (id ${r.id})`
      )
  return plan
}

/**
 * The status page, matched by subdomain. Keyed by subdomain. It is shared by every product, so the sync creates it when
 * it is missing but never renames it.
 */
export function planStatusPage(config: Monitoring, remote: Remote<StatusPageAttrs>[]): Plan {
  const plan = emptyPlan()
  const { name, subdomain } = config.statusPage
  const page = remote.find((p) => p.attributes.subdomain === subdomain)
  if (page) plan.unchanged.set(subdomain, page.id)
  else
    plan.changes.push({
      action: 'create',
      label: `status page "${name}" (${subdomain})`,
      key: subdomain,
      path: '/status-pages',
      body: { company_name: name, subdomain },
    })
  return plan
}

/** Our one section on the shared page, matched by title (the platform's name). Keyed by title. */
export function planSection(config: Monitoring, pageId: string, remote: Remote<SectionAttrs>[]) {
  const plan = emptyPlan()
  const title = config.platform
  const s = remote.find((r) => r.attributes.name === title)
  if (s) plan.unchanged.set(title, s.id)
  else
    plan.changes.push({
      action: 'create',
      label: `section "${title}"`,
      key: title,
      path: `/status-pages/${pageId}/sections`,
      body: { name: title },
    })
  return plan
}

/** One row per check in our section, matched by its monitor. Keyed by monitor URL. */
export function planResources(
  config: Monitoring,
  pageId: string,
  monitorIds: Map<string, string>,
  sectionId: string,
  remote: Remote<ResourceAttrs>[]
): Plan {
  const plan = emptyPlan()
  const used = new Set<string>()
  for (const d of desiredMonitors(config)) {
    const monitorId = monitorIds.get(d.url)!
    const r = remote.find(
      (x) =>
        x.attributes.resource_type === 'Monitor' && String(x.attributes.resource_id) === monitorId
    )
    if (!r) {
      plan.changes.push({
        action: 'create',
        label: `status page row "${d.name}" in "${config.platform}"`,
        key: d.url,
        path: `/status-pages/${pageId}/resources`,
        body: {
          resource_type: 'Monitor',
          resource_id: asInt(monitorId),
          public_name: d.name,
          status_page_section_id: asInt(sectionId),
          widget_type: 'history',
          explanation: d.explanation,
        },
      })
      continue
    }
    used.add(r.id)
    const changed = diff(
      {
        public_name: d.name,
        status_page_section_id: asInt(sectionId),
        ...(r.attributes.explanation === undefined ? {} : { explanation: d.explanation }),
      },
      r.attributes
    )
    if (Object.keys(changed).length === 0) plan.unchanged.set(d.url, r.id)
    else
      plan.changes.push({
        action: 'update',
        label: `status page row "${r.attributes.public_name}" (${explain(changed, r.attributes)})`,
        key: d.url,
        id: r.id,
        path: `/status-pages/${pageId}/resources/${r.id}`,
        body: changed,
      })
  }
  for (const r of remote)
    if (!used.has(r.id) && String(r.attributes.status_page_section_id) === sectionId)
      plan.extras.push(
        `status page row "${r.attributes.public_name}" (${r.attributes.resource_type}, id ${r.id})`
      )
  return plan
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export class BetterStack {
  private readonly token: string
  private readonly fetchImpl: FetchLike

  constructor(token: string, fetchImpl: FetchLike = fetch) {
    this.token = token
    this.fetchImpl = fetchImpl
  }

  private async request(method: string, path: string, body?: unknown): Promise<any> {
    const res = await this.fetchImpl(API + path, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!res.ok)
      throw new Error(`Better Stack ${method} ${path}: ${res.status} ${await res.text()}`)
    return res.json()
  }

  /** Every page of a list. Follows `pagination.next`'s query on our own base, so the token goes nowhere else. */
  async list<A>(path: string): Promise<Remote<A>[]> {
    const all: Remote<A>[] = []
    let next: string | null = `${path}?per_page=250`
    while (next) {
      const page: any = await this.request('GET', next)
      all.push(...page.data)
      const url: string | null = page.pagination?.next ?? null
      next = url ? path + new URL(url).search : null
    }
    return all
  }

  async write(change: Change): Promise<string> {
    const res = await this.request(
      change.action === 'create' ? 'POST' : 'PATCH',
      change.path,
      change.body
    )
    return String(res.data?.id ?? change.id)
  }
}

export interface SyncResult {
  creates: number
  updates: number
  extras: string[]
}

/** Logs and (unless dry) makes each change; returns every key's id. A dry run stands in `<new …>` for new ids. */
async function apply(
  api: BetterStack,
  plan: Plan,
  dryRun: boolean,
  log: (line: string) => void,
  result: SyncResult
) {
  const ids = new Map(plan.unchanged)
  for (const c of plan.changes) {
    log(`${c.action === 'create' ? '+ create' : '~ update'} ${c.label}`)
    if (c.action === 'create') result.creates++
    else result.updates++
    ids.set(c.key, dryRun ? (c.id ?? `<new ${c.key}>`) : await api.write(c))
  }
  result.extras.push(...plan.extras)
  return ids
}

export async function sync(opts: {
  token: string
  dryRun: boolean
  config: Monitoring
  fetchImpl?: FetchLike
  log?: (line: string) => void
}): Promise<SyncResult> {
  const { token, dryRun, config, log = console.log } = opts
  const api = new BetterStack(token, opts.fetchImpl)
  const result: SyncResult = { creates: 0, updates: 0, extras: [] }
  const isNew = (id: string) => id.startsWith('<new ')

  const groupIds = await apply(
    api,
    planMonitorGroup(config, await api.list('/monitor-groups')),
    dryRun,
    log,
    result
  )
  const groupId = groupIds.get(config.monitorGroup)!
  const monitorIds = await apply(
    api,
    planMonitors(config, groupId, await api.list('/monitors')),
    dryRun,
    log,
    result
  )
  const pageIds = await apply(
    api,
    planStatusPage(config, await api.list('/status-pages')),
    dryRun,
    log,
    result
  )
  const pageId = pageIds.get(config.statusPage.subdomain)!
  const sections = isNew(pageId)
    ? []
    : await api.list<SectionAttrs>(`/status-pages/${pageId}/sections`)
  const sectionIds = await apply(api, planSection(config, pageId, sections), dryRun, log, result)
  const sectionId = sectionIds.get(config.platform)!
  const resources = isNew(pageId)
    ? []
    : await api.list<ResourceAttrs>(`/status-pages/${pageId}/resources`)
  await apply(
    api,
    planResources(config, pageId, monitorIds, sectionId, resources),
    dryRun,
    log,
    result
  )

  for (const e of result.extras)
    log(`! not in ops/monitoring.ts (left in place; remove it by hand if unwanted): ${e}`)
  log(
    `${dryRun ? 'Dry run, nothing changed: would make' : 'Better Stack sync done:'} ${result.creates} create(s), ` +
      `${result.updates} update(s), ${result.extras.length} not in the list.`
  )
  return result
}

async function main() {
  const token = process.env.BETTERSTACK_API_TOKEN
  const apiBase = process.env.API_URL?.replace(/\/+$/, '')
  if (!token || !apiBase) {
    console.log(`Better Stack sync skipped: no ${token ? 'API_URL' : 'BETTERSTACK_API_TOKEN'}`)
    return
  }
  await sync({
    token,
    dryRun: process.argv.includes('--dry-run'),
    config: { ...monitoring, apiBase },
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((err: Error) => {
    console.error(err.message)
    process.exit(1)
  })
