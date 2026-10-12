#!/usr/bin/env bash
# Sets the variables of the `api-dev` service in Railway's `dev` environment from your LOCAL apps/api/.env, so the
# dev API runs with dev keys only. You run it; it never reads production. It prints variable NAMES, never values.
#
#   apps/api/scripts/railway-dev-vars.sh            # show what it would set
#   apps/api/scripts/railway-dev-vars.sh --apply    # set them
#
# What it sets (the values the security rules require; .railway/railway.ts declares the same names):
#   DATABASE_URL         the restricted role `ad_app` from your .env, moved onto Railway's private host, with
#                        sslmode=require (the API connects with it, so row-level security applies)
#   SCHEMA_DATABASE_URL  a reference to the dev Postgres service (the owner; migrations and the seed), with TLS
#   REQUIRE_TENANT_RLS   on
#   NODE_ENV             development; TRUST_PROXY 1; FRONTEND_URL your local web app
#   CLERK_SECRET_KEY     the dev instance's sk_test_ key from your .env (a live key stops the script)
#   R2_*                 the dev document bucket from your .env (required: a deployed API refuses local-disk storage)
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

# Refuse a database that is not the dev one: the owner URL in your local .env must be the dev Postgres's public
# address according to Railway itself (its TCP proxy domain and port; nothing about the host is written down here).
host_of() { python3 -c "import sys; from urllib.parse import urlsplit; print(urlsplit(sys.argv[1]).netloc.split('@')[-1])" "$1"; }
DEV_HOST="$(railway variables -s Postgres -e "$ENVIRONMENT" --json 2>/dev/null | python3 -c "
import sys, json
v = json.load(sys.stdin)
u = v.get('DATABASE_PUBLIC_URL', '')
print(u.split('@')[-1].split('/')[0] if u else (v['RAILWAY_TCP_PROXY_DOMAIN'] + ':' + v['RAILWAY_TCP_PROXY_PORT'] if v.get('RAILWAY_TCP_PROXY_DOMAIN') else ''))
")"
LOCAL_URL="$(get SCHEMA_DATABASE_URL apps/api/.env || true)"
if [ -z "$DEV_HOST" ] || [ -z "$LOCAL_URL" ] || [ "$DEV_HOST" != "$(host_of "$LOCAL_URL")" ]; then
  echo "SCHEMA_DATABASE_URL in apps/api/.env (host $(host_of "${LOCAL_URL:-//}")) is not the dev database ($ENVIRONMENT's Postgres at ${DEV_HOST:-no proxy found}). Stopping." >&2; exit 1
fi

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
set_var FRONTEND_URL "http://localhost:5173"

echo
if [ ${#missing[@]} -gt 0 ]; then echo "Not in your local .env, so left unset (the API will refuse to start without the R2 ones): ${missing[*]}"; fi
if [ "$APPLY" = 1 ]; then echo "Done. Deploy with: apps/api/scripts/deploy-dev.sh"; else echo "Dry run only. Re-run with --apply."; fi
