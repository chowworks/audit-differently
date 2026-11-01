#!/usr/bin/env bash
# Sets the variables of the `api-dev` service in Railway's `dev` environment from your LOCAL apps/api/.env, so the
# dev API runs with dev keys only. You run it; it never reads production. It prints variable NAMES, never values.
#
#   apps/api/scripts/railway-dev-vars.sh            # show what it would set
#   apps/api/scripts/railway-dev-vars.sh --apply    # set them
#
# What it sets (the values the security rules require; .railway/railway.ts declares the same names):
#   DATABASE_URL         the restricted role `ad_app` and its password from your .env, on Railway's private host, with
#                        sslmode=require (the API connects with it, so row-level security applies; the dev database
#                        has no public address, so your .env's copy is only where the password is kept)
#   SCHEMA_DATABASE_URL  a reference to the dev Postgres service (the owner; migrations and the seed), with TLS
#   REQUIRE_TENANT_RLS   on
#   NODE_ENV             development; TRUST_PROXY 1; FRONTEND_URL your local web app (ports 5173 and 5273)
#   CLERK_SECRET_KEY     the dev instance's sk_test_ key from your .env (a live key stops the script)
#   R2_*                 the dev document bucket from your .env (required: a deployed API refuses local-disk storage)
#   ANTHROPIC_API_KEY    optional, from your .env when set (Claude reads for imports and receipts)
#   RESEND_RECEIVING_API_KEY, RESEND_WEBHOOK_SECRET, RECEIPTS_DOMAIN  optional emailed receipts: all three from your
#                        .env, or none (the API refuses to start with only some)
set -euo pipefail
cd "$(dirname "$0")/../../.."

ENVIRONMENT=dev
SERVICE=api-dev
APPLY=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

get() { # value of NAME in a dotenv file, without quotes
  python3 - "$1" "$2" <<'PY'
import sys,re
name,path=sys.argv[1],sys.argv[2]
for line in open(path):
    m=re.match(r'^\s*'+re.escape(name)+r'\s*=\s*(.*)\s*$',line)
    if m:
        print(m.group(1).strip('"\''))
        break
PY
}

# Never a live Clerk key on the dev service.
if grep -qE '^CLERK_SECRET_KEY="?sk_live' apps/api/.env; then echo "CLERK_SECRET_KEY in apps/api/.env is a live key. Stopping." >&2; exit 1; fi

set_var() { # NAME VALUE
  if [ "$APPLY" = 1 ]; then
    railway variables -s "$SERVICE" -e "$ENVIRONMENT" --set "$1=$2" --skip-deploys >/dev/null
  fi
  echo "  set $1"
}

echo "Service $SERVICE in environment $ENVIRONMENT ($([ "$APPLY" = 1 ] && echo applying || echo dry run))"
missing=()
for name in CLERK_SECRET_KEY R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_DOCUMENTS_BUCKET; do
  value="$(get "$name" apps/api/.env || true)"
  if [ -n "$value" ]; then set_var "$name" "$value"; else missing+=("$name"); fi
done

# Optional: Claude reads, set when your .env has a key.
optional=()
value="$(get ANTHROPIC_API_KEY apps/api/.env || true)"
if [ -n "$value" ]; then set_var ANTHROPIC_API_KEY "$value"; else optional+=(ANTHROPIC_API_KEY); fi

# Optional: emailed receipts, all three together or not at all (the API refuses to start with only some of them).
rkey="$(get RESEND_RECEIVING_API_KEY apps/api/.env || true)"
secret="$(get RESEND_WEBHOOK_SECRET apps/api/.env || true)"
domain="$(get RECEIPTS_DOMAIN apps/api/.env || true)"
if [ -n "$rkey" ] && [ -n "$secret" ] && [ -n "$domain" ]; then
  set_var RESEND_RECEIVING_API_KEY "$rkey"
  set_var RESEND_WEBHOOK_SECRET "$secret"
  set_var RECEIPTS_DOMAIN "$domain"
elif [ -n "$rkey$secret$domain" ]; then
  echo "  skipped the emailed-receipts settings: your .env has only some of RESEND_RECEIVING_API_KEY, RESEND_WEBHOOK_SECRET and RECEIPTS_DOMAIN, and the API needs all three or none"
else
  optional+=(RESEND_RECEIVING_API_KEY RESEND_WEBHOOK_SECRET RECEIPTS_DOMAIN)
fi

# Database: the restricted role from DATABASE_URL in your local .env, on the private host, over TLS; the owner by reference.
RLS_URL="$(get DATABASE_URL apps/api/.env || true)"
case "$RLS_URL" in *://ad_app:*) ;; *) echo "DATABASE_URL in apps/api/.env is not the restricted ad_app role (run npm run role:create, then set it)." >&2; exit 1 ;; esac
PRIVATE_URL="$(python3 - "$RLS_URL" <<'PY'
import sys
from urllib.parse import urlsplit, urlunsplit
u=urlsplit(sys.argv[1])
netloc=(u.username or '')+(':'+u.password if u.password else '')+'@postgres.railway.internal:5432'
print(urlunsplit((u.scheme,netloc,u.path,'sslmode=require',u.fragment)))
PY
)"
set_var DATABASE_URL "$PRIVATE_URL"
set_var SCHEMA_DATABASE_URL '${{Postgres.DATABASE_URL}}?sslmode=require'
set_var REQUIRE_TENANT_RLS on
set_var NODE_ENV development
set_var TRUST_PROXY 1
set_var FRONTEND_URL "http://localhost:5173,http://localhost:5273"

echo
if [ ${#missing[@]} -gt 0 ]; then echo "Not in your local .env, so left unset (the API will refuse to start without the R2 ones): ${missing[*]}"; fi
if [ ${#optional[@]} -gt 0 ]; then echo "Optional, not in your local .env, so left as they are on the service: ${optional[*]}"; fi
if [ "$APPLY" = 1 ]; then echo "Done. Deploy with: apps/api/scripts/deploy-dev.sh"; else echo "Dry run only. Re-run with --apply."; fi
