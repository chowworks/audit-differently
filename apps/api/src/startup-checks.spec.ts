import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertDeployedConfig, configProblems } from './startup-checks'

const local = {
  DATABASE_URL: 'postgresql://ad_app:x@127.0.0.1:5434/postgres?sslmode=disable',
  SCHEMA_DATABASE_URL: 'postgresql://postgres:x@localhost:5434/postgres',
  REQUIRE_TENANT_RLS: 'on',
}
const remote = {
  DATABASE_URL: 'postgresql://ad_app:x@maglev.proxy.rlwy.net:12345/railway?sslmode=require',
  SCHEMA_DATABASE_URL:
    'postgresql://postgres:x@postgres.railway.internal:5432/railway?sslmode=require',
  REQUIRE_TENANT_RLS: 'on',
  CLERK_SECRET_KEY: 'sk_test_x',
  R2_DOCUMENTS_BUCKET: 'documents-dev',
}

describe('startup checks', () => {
  it('lets a loopback database through without TLS', () => {
    expect(configProblems(local)).toEqual([])
  })

  it('refuses a database off this machine without TLS or the bucket, in every environment', () => {
    const problems = configProblems({
      ...local,
      DATABASE_URL: 'postgresql://ad_app:x@maglev.proxy.rlwy.net:12345/railway',
    })
    expect(problems).toEqual([
      'DATABASE_URL reaches maglev.proxy.rlwy.net without TLS: add sslmode=require',
      'R2_DOCUMENTS_BUCKET is not set: documents of a shared database never go to a local disk',
    ])
  })

  it('refuses row-level security off, anywhere', () => {
    expect(configProblems({ ...local, REQUIRE_TENANT_RLS: '' })).toEqual([
      'REQUIRE_TENANT_RLS must be "on"',
    ])
  })

  it('accepts a dev environment on Railway with TLS, RLS on and a test Clerk key', () => {
    expect(configProblems({ ...remote, RAILWAY_ENVIRONMENT_NAME: 'dev' })).toEqual([])
  })

  it('refuses a Railway environment without RLS, a Clerk key or the bucket', () => {
    expect(
      configProblems({
        ...remote,
        RAILWAY_ENVIRONMENT_NAME: 'dev',
        REQUIRE_TENANT_RLS: '',
        CLERK_SECRET_KEY: '',
        R2_DOCUMENTS_BUCKET: '',
      })
    ).toEqual([
      'REQUIRE_TENANT_RLS must be "on"',
      'R2_DOCUMENTS_BUCKET is not set: documents of a shared database never go to a local disk',
      'CLERK_SECRET_KEY is not set',
    ])
  })

  it('holds production to everything', () => {
    expect(
      configProblems({ ...remote, RAILWAY_ENVIRONMENT_NAME: 'production', NODE_ENV: 'development' })
    ).toEqual(['NODE_ENV must be "production" in the production environment'])
    expect(configProblems({ ...remote, NODE_ENV: 'production' })).toEqual([
      'TRUST_PROXY is not set',
      'CLERK_SECRET_KEY is a test key',
    ])
    expect(
      configProblems({
        ...remote,
        NODE_ENV: 'production',
        TRUST_PROXY: '1',
        CLERK_SECRET_KEY: 'sk_live_x',
      })
    ).toEqual([])
  })

  it('refuses a leftover DEMO_AUTH anywhere', () => {
    expect(configProblems({ ...local, DEMO_AUTH: 'on' })).toEqual([
      'DEMO_AUTH is set, but demo personas no longer exist: remove it',
    ])
    expect(() => assertDeployedConfig({ ...local, DEMO_AUTH: 'on' })).toThrow('Refusing to start')
  })

  it('refuses to start without the Terms page, or without its #terms section', () => {
    expect(configProblems(local, null)).toEqual([
      'docs/terms/index.html was not found: the Terms are the version',
    ])
    const dir = mkdtempSync(join(tmpdir(), 'terms-'))
    const bare = join(dir, 'index.html')
    writeFileSync(bare, '<main><section id="contact">x</section></main>')
    expect(configProblems(local, bare)).toEqual([
      'docs/terms/index.html has no <section id="terms">',
    ])
    expect(() => assertDeployedConfig(local, null)).toThrow(/Refusing to start/)
  })
})
