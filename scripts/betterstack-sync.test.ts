/** Tests for scripts/betterstack-sync.ts with Better Stack's API stubbed. Run: npm run test:scripts */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Monitoring } from '../ops/monitoring.ts'
import {
  planMonitorGroup,
  planMonitors,
  planResources,
  planSection,
  planStatusPage,
  sync,
  type MonitorAttrs,
  type Remote,
} from './betterstack-sync.ts'

const config: Monitoring = {
  platform: 'Example',
  monitorGroup: 'Example group',
  apiBase: 'https://api.example.test',
  checkFrequency: 300,
  statusPage: { name: 'Example status', subdomain: 'example-status' },
  checks: [
    { name: 'Database', path: '/api/health/database', explanation: 'Records can be saved.' },
    { name: 'Storage', path: '/api/health/storage', explanation: 'Files can be opened.' },
  ],
}
const DB = 'https://api.example.test/api/health/database'
const STORAGE = 'https://api.example.test/api/health/storage'

const monitor = (
  id: string,
  url: string,
  name: string,
  extra: Partial<MonitorAttrs> = {}
): Remote<MonitorAttrs> => ({
  id,
  attributes: {
    url,
    pronounceable_name: name,
    monitor_type: 'status',
    email: true,
    check_frequency: 300,
    monitor_group_id: 40,
    ...extra,
  },
})

test('monitor group: created when missing, matched by name', () => {
  assert.deepEqual(planMonitorGroup(config, [{ id: '1', attributes: { name: 'Other' } }]).changes, [
    {
      action: 'create',
      label: 'monitor group "Example group"',
      key: 'Example group',
      path: '/monitor-groups',
      body: { name: 'Example group' },
    },
  ])
  const found = planMonitorGroup(config, [{ id: '40', attributes: { name: 'Example group' } }])
  assert.equal(found.changes.length, 0)
  assert.equal(found.unchanged.get('Example group'), '40')
})

test('monitors: creates what is missing, named with the platform, in our group, 2xx, email alerts', () => {
  const plan = planMonitors(config, '40', [])
  assert.equal(plan.changes.length, 2)
  assert.deepEqual(plan.changes[0], {
    action: 'create',
    label: `monitor "Example · Database" ${DB}`,
    key: DB,
    path: '/monitors',
    body: {
      url: DB,
      pronounceable_name: 'Example · Database',
      monitor_type: 'status',
      email: true,
      check_frequency: 300,
      monitor_group_id: 40,
    },
  })
})

test('monitors: unchanged when they match; a rename, a moved URL or a setting changed by hand is updated in place', () => {
  const plan = planMonitors(config, '40', [
    monitor('1', DB, 'Old name', { email: false }),
    monitor('2', 'https://api-dev.example.test/api/health/storage', 'Example · Storage'),
  ])
  assert.deepEqual(
    plan.changes.map((c) => [c.action, c.id, c.body]),
    [
      ['update', '1', { pronounceable_name: 'Example · Database', email: true }],
      ['update', '2', { url: STORAGE }],
    ]
  )
  assert.deepEqual(plan.extras, [])
  const same = planMonitors(config, '40', [
    monitor('1', DB, 'Example · Database'),
    monitor('2', STORAGE, 'Example · Storage'),
  ])
  assert.equal(same.changes.length, 0)
  assert.deepEqual([...same.unchanged.values()], ['1', '2'])
})

test('monitors: ones on our API or in our group not in the list are reported, others ignored, nothing deleted', () => {
  const plan = planMonitors(config, '40', [
    monitor('9', 'https://api.example.test/api/health/removed', 'Removed', { monitor_group_id: 1 }),
    monitor('10', 'https://elsewhere.test/', 'Someone else', { monitor_group_id: 41 }),
    monitor('11', 'https://other.test/', 'In our group'),
    monitor('12', 'https://api.example.test.evil/x', 'Lookalike host', { monitor_group_id: 41 }),
  ])
  assert.deepEqual(plan.extras, [
    'monitor "Removed" https://api.example.test/api/health/removed (id 9)',
    'monitor "In our group" https://other.test/ (id 11)',
  ])
  assert.ok(plan.changes.every((c) => c.action === 'create'))
})

test('status page: matched by subdomain; created when missing, never renamed (it is shared)', () => {
  assert.deepEqual(planStatusPage(config, []).changes[0].body, {
    company_name: 'Example status',
    subdomain: 'example-status',
  })
  const shared = planStatusPage(config, [
    { id: '7', attributes: { company_name: 'Someone else’s title', subdomain: 'example-status' } },
  ])
  assert.equal(shared.changes.length, 0)
  assert.equal(shared.unchanged.get('example-status'), '7')
})

test('section: ours is created when missing; other products’ sections are not ours and not reported', () => {
  const plan = planSection(config, '7', [{ id: '20', attributes: { name: 'Learn Differently' } }])
  assert.deepEqual(
    plan.changes.map((c) => [c.action, c.path, c.body]),
    [['create', '/status-pages/7/sections', { name: 'Example' }]]
  )
  assert.deepEqual(plan.extras, [])
  const found = planSection(config, '7', [
    { id: '20', attributes: { name: 'Learn Differently' } },
    { id: '10', attributes: { name: 'Example' } },
  ])
  assert.equal(found.changes.length, 0)
  assert.equal(found.unchanged.get('Example'), '10')
})

test('rows: one per monitor in our section; a renamed one is updated; strays in our section reported, others ignored', () => {
  const monitorIds = new Map([
    [DB, '1'],
    [STORAGE, '2'],
  ])
  const row = (id: string, resource_id: number, public_name: string, section: number) => ({
    id,
    attributes: {
      resource_type: 'Monitor',
      resource_id,
      public_name,
      status_page_section_id: section,
    },
  })
  const plan = planResources(config, '7', monitorIds, '10', [
    row('100', 1, 'Old name', 10),
    row('101', 99, 'Gone', 10),
    row('102', 98, 'Learn Differently · API', 20),
  ])
  assert.deepEqual(
    plan.changes.map((c) => [c.action, c.path, c.body]),
    [
      ['update', '/status-pages/7/resources/100', { public_name: 'Example · Database' }],
      [
        'create',
        '/status-pages/7/resources',
        {
          resource_type: 'Monitor',
          resource_id: 2,
          public_name: 'Example · Storage',
          status_page_section_id: 10,
          widget_type: 'history',
          explanation: 'Files can be opened.',
        },
      ],
    ]
  )
  assert.deepEqual(plan.extras, ['status page row "Gone" (Monitor, id 101)'])
})

/** A stubbed Better Stack: answers lists from `state`, records writes, hands out ids. */
function stub(state: Record<string, unknown[]>) {
  const calls: { method: string; url: string; body?: unknown }[] = []
  let nextId = 500
  const fetchImpl = async (url: string, init: RequestInit) => {
    const method = init.method ?? 'GET'
    assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer fake-token')
    calls.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : undefined })
    const path = new URL(url).pathname.replace('/api/v2', '')
    const json =
      method === 'GET'
        ? { data: state[path] ?? [], pagination: { next: null } }
        : { data: { id: String(nextId++), attributes: {} } }
    return new Response(JSON.stringify(json), { status: method === 'POST' ? 201 : 200 })
  }
  return { calls, fetchImpl }
}

test('sync --dry-run plans everything and writes nothing', async () => {
  const { calls, fetchImpl } = stub({
    '/status-pages': [
      { id: '7', attributes: { company_name: 'Example status', subdomain: 'example-status' } },
    ],
  })
  const lines: string[] = []
  const result = await sync({
    token: 'fake-token',
    dryRun: true,
    config,
    fetchImpl,
    log: (l) => lines.push(l),
  })
  assert.ok(calls.every((c) => c.method === 'GET'))
  assert.deepEqual(result, { creates: 1 + 2 + 1 + 2, updates: 0, extras: [] })
  assert.deepEqual(lines, [
    '+ create monitor group "Example group"',
    `+ create monitor "Example · Database" ${DB}`,
    `+ create monitor "Example · Storage" ${STORAGE}`,
    '+ create section "Example"',
    '+ create status page row "Example · Database" in "Example"',
    '+ create status page row "Example · Storage" in "Example"',
    'Dry run, nothing changed: would make 6 create(s), 0 update(s), 0 not in the list.',
  ])
})

test('sync applies creates in order, wiring new ids into later steps', async () => {
  const { calls, fetchImpl } = stub({
    '/status-pages': [
      { id: '7', attributes: { company_name: 'Example status', subdomain: 'example-status' } },
    ],
  })
  await sync({ token: 'fake-token', dryRun: false, config, fetchImpl, log: () => {} })
  const writes = calls.filter((c) => c.method !== 'GET')
  // Group 500, monitors 501-502, section 503, then a row per monitor.
  assert.deepEqual(
    writes.map((w) => new URL(w.url).pathname),
    [
      '/api/v2/monitor-groups',
      '/api/v2/monitors',
      '/api/v2/monitors',
      '/api/v2/status-pages/7/sections',
      '/api/v2/status-pages/7/resources',
      '/api/v2/status-pages/7/resources',
    ]
  )
  assert.equal((writes[1].body as { monitor_group_id: number }).monitor_group_id, 500)
  assert.deepEqual(writes[5].body, {
    resource_type: 'Monitor',
    resource_id: 502,
    public_name: 'Example · Storage',
    status_page_section_id: 503,
    widget_type: 'history',
    explanation: 'Files can be opened.',
  })
})

test('sync is a no-op when the account already matches', async () => {
  const { calls, fetchImpl } = stub({
    '/monitor-groups': [{ id: '40', attributes: { name: 'Example group' } }],
    '/monitors': [
      monitor('1', DB, 'Example · Database'),
      monitor('2', STORAGE, 'Example · Storage'),
    ],
    '/status-pages': [
      { id: '7', attributes: { company_name: 'Example status', subdomain: 'example-status' } },
    ],
    '/status-pages/7/sections': [{ id: '10', attributes: { name: 'Example' } }],
    '/status-pages/7/resources': [
      ['1', 'Example · Database'],
      ['2', 'Example · Storage'],
    ].map(([resource_id, public_name], i) => ({
      id: String(100 + i),
      attributes: {
        resource_type: 'Monitor',
        resource_id,
        public_name,
        status_page_section_id: 10,
      },
    })),
  })
  const result = await sync({
    token: 'fake-token',
    dryRun: false,
    config,
    fetchImpl,
    log: () => {},
  })
  assert.deepEqual(result, { creates: 0, updates: 0, extras: [] })
  assert.ok(calls.every((c) => c.method === 'GET'))
})

test('lists follow pagination on the Better Stack host only', async () => {
  const seen: string[] = []
  const fetchImpl = async (url: string) => {
    seen.push(url)
    const second = url.includes('?page=2')
    return new Response(
      JSON.stringify({
        data: [],
        pagination: {
          next: second ? null : 'https://somewhere.else/api/v2/anything?page=2&per_page=250',
        },
      })
    )
  }
  await sync({ token: 'fake-token', dryRun: true, config, fetchImpl, log: () => {} })
  assert.equal(
    seen[1],
    'https://incidents.betterstack.com/api/v2/monitor-groups?page=2&per_page=250'
  )
})

test('an API error stops the sync with its status', async () => {
  const fetchImpl = async () => new Response('{"errors":"nope"}', { status: 401 })
  await assert.rejects(
    sync({ token: 'fake-token', dryRun: true, config, fetchImpl, log: () => {} }),
    /Better Stack GET \/monitor-groups\?per_page=250: 401/
  )
})
