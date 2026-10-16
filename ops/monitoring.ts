/**
 * What Better Stack Uptime monitors for Audit Differently, and its section on the shared public status page. CI applies
 * this file with scripts/betterstack-sync.ts on every push to main that deploys; see docs/monitoring.md. Adapted from
 * Interview Differently's ops/monitoring.ts.
 *
 * A check is matched to its Better Stack monitor by URL, or by name when only the URL changed, so renaming a check or
 * moving its URL updates the monitor in place. Nothing is ever deleted: a check removed from this list is reported, and
 * the owner removes it in Better Stack.
 *
 * Monitors are named `${platform} · ${check name}` (alert emails and incidents use that name, so they say which
 * product) and all go in the monitor group `monitorGroup`. On the shared status page this product has one section,
 * titled `platform`, with a row per check of the same name. Every check is a "status code 2xx" check (the health
 * routes answer 503 when failing), every `checkFrequency` seconds, alerting the team by email.
 *
 * The address checked is the API that CI deploys (the repository variable API_URL, the one the smoke test checks), so
 * the monitors follow it from dev to production.
 */

export interface Check {
  /** The monitor's and the status page row's name. */
  name: string
  /** Path on the API. */
  path: string
  /** What it checks, in plain words: shown in the help icon on its status page row. */
  explanation: string
}

export interface Monitoring {
  /** The product's name: its section on the shared status page, its monitor group, and the start of every name. */
  platform: string
  /** The Better Stack monitor group all our monitors go in, matched by name. */
  monitorGroup: string
  /** The API's public address, without a trailing slash. Set from API_URL when the sync runs. */
  apiBase: string
  /** Seconds between checks. */
  checkFrequency: number
  statusPage: {
    /** The status page's title in Better Stack (`company_name`), only used if it ever has to be created. */
    name: string
    /** Its address, `<subdomain>.betteruptime.com`: the key the sync matches the page by. */
    subdomain: string
  }
  checks: Check[]
}

export const monitoring: Omit<Monitoring, 'apiBase'> = {
  platform: 'Audit Differently',
  monitorGroup: 'Audit Differently',
  checkFrequency: 300,
  statusPage: {
    // the account's one status page, shared by every product (Learn, Interview, Audit Differently, …): used as it is,
    // never renamed
    name: 'Chow Works status',
    subdomain: 'chow-works',
  },
  checks: [
    {
      name: 'Proof upload failures (last 15 min)',
      path: '/api/health/upload-failures',
      explanation:
        'Down if attaching proof failed for anyone in the last 15 minutes through no fault of theirs.',
    },
    {
      name: 'Server errors (last 15 min)',
      path: '/api/health/server-errors',
      explanation:
        'Down if any request to the app failed with a server error in the last 15 minutes.',
    },
  ],
}
