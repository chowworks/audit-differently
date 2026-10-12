#!/usr/bin/env bash
# Deploys the current working tree to the shared dev API (Railway `dev`, service `api-dev`).
#
#   apps/api/scripts/deploy-dev.sh
#
# The API depends on the workspace package @ad/types, so the whole repository is the build root (the service's
# build and start commands in .railway/railway.ts run from there). A clean copy is uploaded rather than the
# folder itself: no node_modules, build output, .env files, local document storage, data folders, or the
# gitignored real reference documents; uncommitted changes are included, so you test exactly what you have.
set -euo pipefail
cd "$(dirname "$0")/../../.."

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
# Everything .gitignore excludes stays home (every .env, the real reference documents, local storage, data
# folders, build output), plus .git itself and this editor's session files.
rsync -a --filter=':- .gitignore' --exclude '.git/' --exclude '/.claude/' ./ "$TMP/repo/"

echo "Uploading $(du -sh "$TMP/repo" | cut -f1) to api-dev (dev); top level:"
ls -1 "$TMP/repo" | sed 's/^/  /'
if find "$TMP/repo" \( -name '.env' -o -name '.env.*' \) -not -name '.env.example' | grep -q .; then
  echo "An .env file is in the upload set. Stopping." >&2; exit 1
fi
railway up "$TMP/repo" --path-as-root -e dev -s api-dev -c
