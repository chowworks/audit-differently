import { bucket, defineRailway, github, postgres, preserve, project, service } from 'railway/iac'

/**
 * Audit Differently on Railway, declared in code the way Learn Differently is. `railway config plan` shows what
 * would change; CI applies this file on a push to main (.github/workflows/ci.yml). Nothing here holds a secret:
 * the values marked preserve() are set by hand in Railway and left alone (apps/api/scripts/railway-dev-vars.sh
 * sets dev's from a local .env).
 *
 * What this file fixes, from CLAUDE.md "Data rules" and the 2026-10-11 security review:
 *   - the API connects as the restricted role (DATABASE_URL) over TLS; the owner URL is for migrations only, and
 *     also over TLS; src/startup-checks.ts refuses to start otherwise;
 *   - REQUIRE_TENANT_RLS=on in every environment; NODE_ENV=production in production, set here, not by hand;
 *   - production Postgres has no public TCP proxy: it is reachable on Railway's private network only. The dev
 *     Postgres has one, because laptops develop against it, and it holds fictional seed data only;
 *   - production's Postgres volume is backed up daily and point-in-time recovery archives to the Postgres-PITR
 *     bucket (both switched on in that volume's settings; the bucket is declared for production only, dev holds
 *     a fictional seed that `db:seed` recreates);
 *   - documents live in a private Cloudflare R2 bucket (R2_*), one per environment, never on the service's disk;
 *   - there is no demo sign-in: every environment signs people in through Clerk, dev with a dev instance.
 */
const REGION = 'us-east4-eqdc4a'

export default defineRailway((ctx) => {
  const Postgres = postgres('Postgres', { region: REGION })
  // Railway's Postgres provisions its own volume; declaring one here on a fresh project would make a second,
  // unattached one. After the first apply, `railway config pull` brings the real volume into this file.
  // The API depends on the workspace package @ad/types, so the repository root is the build root (nixpacks.toml
  // there installs every workspace); the commands below build the types, the Prisma client and the API.
  const build = {
    buildCommand:
      'npm run build -w @ad/types && npx prisma generate --schema apps/api/prisma/schema.prisma && npm run build -w @ad/api',
    buildEnvironment: 'V3',
    builder: 'NIXPACKS',
  } as const
  const migrate = 'npx prisma migrate deploy --schema apps/api/prisma/schema.prisma'

  // The variables every API environment carries; the ones that differ are set below.
  const shared = {
    TRUST_PROXY: '1',
    // Refuse to start unless DATABASE_URL is the restricted role, so row-level security is never silently off.
    REQUIRE_TENANT_RLS: 'on',
    // The restricted role on the private host, with sslmode=require (never a public proxy address in a service).
    DATABASE_URL: preserve(),
    // The owner, for Prisma's CLI in the start command, over TLS as well.
    SCHEMA_DATABASE_URL: '${{Postgres.DATABASE_URL}}?sslmode=require',
    FRONTEND_URL: preserve(),
    CLERK_SECRET_KEY: preserve(),
    R2_ACCOUNT_ID: preserve(),
    R2_ACCESS_KEY_ID: preserve(),
    R2_SECRET_ACCESS_KEY: preserve(),
    R2_DOCUMENTS_BUCKET: preserve(),
  }

  // `dev`: the shared development environment. Laptops point apps/api/.env at its database through the TCP proxy
  // (fictional seed only), and `api-dev` runs beside it, deployed by hand from any branch with
  // apps/api/scripts/deploy-dev.sh. No GitHub source, so nothing deploys it automatically, and none of
  // production's secrets live here. Create the environment first with `railway environment new dev`; IaC can't.
  if (ctx.isEnvironment('dev')) {
    Postgres.networking = { privateNetworkEndpoint: 'postgres', tcpProxies: { '5432': {} } }
    const apiDev = service('api-dev', {
      build,
      // The seed is fictional and idempotent; it keeps the dev data in its starting shape on every deploy.
      start: `${migrate} && npm run db:seed -w @ad/api && node apps/api/dist/main.js`,
      deploy: { restartPolicyMaxRetries: 3 },
      replicas: { [REGION]: 1 },
      env: { NODE_ENV: 'development', ...shared },
    })
    return project('audit-differently', {
      resources: [Postgres, apiDev],
    })
  }

  // Production: private network only, no seed, NODE_ENV fixed here, and the bucket point-in-time recovery
  // archives to (switch PITR and the daily backup on in the Postgres volume's settings, once).
  Postgres.networking = { privateNetworkEndpoint: 'postgres' }
  const PostgresPITR = bucket('Postgres-PITR', { region: 'iad' })
  const api = service('audit-differently', {
    source: github('chowworks/audit-differently', { checkSuites: true }),
    build: {
      ...build,
      watchPatterns: ['apps/api/**', 'packages/types/**', 'docs/terms/**', 'package*.json'],
    },
    start: `${migrate} && node apps/api/dist/main.js`,
    deploy: { restartPolicyMaxRetries: 3 },
    replicas: { [REGION]: 1 },
    env: { NODE_ENV: 'production', ...shared },
  })
  return project('audit-differently', { resources: [Postgres, PostgresPITR, api] })
})
