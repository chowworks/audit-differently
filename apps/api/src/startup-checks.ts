import { readFileSync } from 'node:fs'
import { findTermsFile, termsWording } from './auth/terms-fingerprint'

/**
 * Checks the configuration before the API starts, so a deployed API can never run the way the security rules
 * forbid (CLAUDE.md "Data rules" and "Tenant isolation"; the 2026-10-11 security review):
 *
 *   - REQUIRE_TENANT_RLS=on, everywhere;
 *   - any database that is not on this machine is reached over TLS (sslmode=require or stricter), and then
 *     documents go to the private bucket, never to this disk (a laptop against the dev database included);
 *   - on Railway, or with NODE_ENV=production: a Clerk key;
 *   - in production: NODE_ENV=production and TRUST_PROXY set;
 *   - docs/terms/index.html, with its #terms section, is there: the version everyone accepts is the fingerprint of
 *     that wording, computed from it at startup;
 *   - DEMO_AUTH no longer exists; a leftover value is refused so nobody believes it still works.
 */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname
  } catch {
    return null
  }
}

const TLS = /[?&]sslmode=(require|verify-ca|verify-full)(&|$)/

/** The problems with this configuration, in plain words; none means the API may start. */
export function configProblems(
  env: NodeJS.ProcessEnv = process.env,
  termsFile: string | null = findTermsFile()
): string[] {
  const problems: string[] = []
  const railway = env.RAILWAY_ENVIRONMENT_NAME
  const production = env.NODE_ENV === 'production'
  const deployed = production || !!railway

  if (!termsFile) problems.push('docs/terms/index.html was not found: the Terms are the version')
  else if (!termsWording(readFileSync(termsFile, 'utf8')))
    problems.push('docs/terms/index.html has no <section id="terms">')
  if (env.DEMO_AUTH) problems.push('DEMO_AUTH is set, but demo personas no longer exist: remove it')
  if (env.REQUIRE_TENANT_RLS !== 'on') problems.push('REQUIRE_TENANT_RLS must be "on"')
  let remote = false
  for (const name of ['DATABASE_URL', 'SCHEMA_DATABASE_URL']) {
    const value = env[name]
    if (!value) {
      problems.push(`${name} is not set`)
      continue
    }
    const host = hostOf(value)
    if (host === null) problems.push(`${name} is not a URL`)
    else if (!LOOPBACK.has(host)) {
      remote = true
      if (!TLS.test(value))
        problems.push(`${name} reaches ${host} without TLS: add sslmode=require`)
    }
  }
  if ((remote || deployed) && !env.R2_DOCUMENTS_BUCKET)
    problems.push(
      'R2_DOCUMENTS_BUCKET is not set: documents of a shared database never go to a local disk'
    )
  if (deployed && !env.CLERK_SECRET_KEY) problems.push('CLERK_SECRET_KEY is not set')
  if (railway === 'production' && !production)
    problems.push('NODE_ENV must be "production" in the production environment')
  if (production) {
    if (!env.TRUST_PROXY) problems.push('TRUST_PROXY is not set')
    if (env.CLERK_SECRET_KEY?.startsWith('sk_test_'))
      problems.push('CLERK_SECRET_KEY is a test key')
  }
  return problems
}

/** Throws, with every problem listed, so the process exits before it listens. */
export function assertDeployedConfig(
  env: NodeJS.ProcessEnv = process.env,
  termsFile: string | null = findTermsFile()
): void {
  const problems = configProblems(env, termsFile)
  if (problems.length) throw new Error(`Refusing to start:\n  ${problems.join('\n  ')}`)
}
