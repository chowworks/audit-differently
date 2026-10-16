# Uptime monitoring and the status page (Better Stack)

Better Stack Uptime checks the API's public health routes and shows them on the account's shared status page
(`chow-works`, also used by Learn and Interview Differently). What it checks lives in code, `ops/monitoring.ts`, and
CI applies it with `scripts/betterstack-sync.ts`. Adapted from Interview Differently's setup.

## What is checked

| Monitor                                                 | Route                             | Down when                                                                                                |
| ------------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Audit Differently · Proof upload failures (last 15 min) | `GET /api/health/upload-failures` | an upload failed in the last 15 minutes through no fault of the person (storage refused it, or its save) |
| Audit Differently · Server errors (last 15 min)         | `GET /api/health/server-errors`   | any request was answered with a 5xx in the last 15 minutes                                               |

Both count rows in the `ServiceFailure` table (`apps/api/src/core/service-failure-log.ts`, migration
`20261016000100`): an upload failure is written by `StagedFile.commit`, a server error by the global
`ServerErrorFilter`. A row is when, which kind and the route pattern (`POST /api/documents`), never a workspace, a
person, a file name or an error message; the reason is in the API's log. Rows older than 30 days are deleted.

Each is a "status code 2xx" monitor (the routes answer 503 when there was a failure, or when the count cannot be
read), every 5 minutes, alerting the team by email, in the monitor group "Audit Differently", with a row of the same
name in the "Audit Differently" section of the status page. The routes say only `status`, `failures` and
`windowMinutes`. Each result is reused for a minute. `GET /api/health` (the API is up) is not monitored: both checks
fail when the API or its database does not answer.

The address checked is the repository variable `API_URL`, the API CI deploys and smoke-tests, so the monitors follow
it from dev to production (the sync moves them to the new URL in place).

To add a check, see "Health checks and monitoring" in `CLAUDE.md`.

## How the sync works

The `betterstack` job in `.github/workflows/ci.yml` runs on pushes to main that deploy, after the smoke test passes.

- **The monitor group** is matched by name and created if missing.
- **Monitors** are matched by URL, or by name when only the URL changed. Missing ones are created; the name, URL,
  check type, email alerts, frequency and group are put back if they differ (other settings, such as SMS or an
  escalation policy, are left alone).
- **The status page** is matched by subdomain and never renamed; it is created only if missing.
- **Our section** is matched by title; **rows** by the monitor they show.
- **Nothing is deleted.** A monitor on our API or in our group, or a row in our section, that is not in the list is
  printed as "not in ops/monitoring.ts". Other products' sections and rows are not ours and are not touched.

Without `BETTERSTACK_API_TOKEN` or `API_URL` it prints that it skipped and exits 0.

## Setting it up (owner, once)

1. In Better Stack, use a team-scoped Uptime API token (API tokens → Team-based tokens → Uptime API tokens). The
   one Interview Differently uses works if it is for the same team.
2. Add it to this repository as the Actions secret `BETTERSTACK_API_TOKEN` (Settings → Secrets and variables →
   Actions). Never in the repository, `.railway/railway.ts` or Railway: only CI uses it.
3. Run a dry run (below), then push to main or re-run the latest main CI run.

## A dry run on your machine

Lists what the sync would create or update without changing anything (it still reads the account):

```bash
read -rs BETTERSTACK_API_TOKEN && export BETTERSTACK_API_TOKEN   # paste the token; it is not echoed or kept
API_URL=https://<the API's public address> npm run betterstack:sync -- --dry-run
```

The planning logic is tested with the API stubbed: `npm run test:scripts`.
