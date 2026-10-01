#!/usr/bin/env bash
# N-1 on N: prove the PREVIOUS release's code runs on the CURRENT schema (the guarantee expand/contract gives a rolling deploy and a rollback).
#   1. scratch database, migrated with THIS checkout (schema N), demo-seeded, owner created
#   2. the previous release checked out in a git worktree, installed and built exactly as CI would
#   3. that build started on :3100 against the scratch database, and ITS OWN e2e suite run against it
# LOCAL ONLY. Takes a few minutes (a full production build). Needs Postgres, Redis, a pnpm store, and Chromium for the e2e.
#   PREV_REF=f6712a2 ops/drills/n-minus-1.sh      (default: the tag base-v<previous> if present, else PREV_REF is required)
set -euo pipefail
PREV_REF="${PREV_REF:?set PREV_REF to the previous release tag or commit}"
here="$(cd "$(dirname "$0")" && pwd)"; root="$here/../.."
: "${SOLD_EXTENSION_DB_SECRET:?needed: production mode enforces per-extension database roles}"
admin=postgres://sold:sold@localhost:5432/postgres
db=sold_nminus1_$$
# A unique build id per run: the shared page cache is keyed by build id, so a reused id would serve pages cached from an earlier run's database.
bid=nminus1-$$
url=postgres://sold:sold@localhost:5432/$db
wt="$(mktemp -d -t sold-nminus1-XXXXXX)"
pidfile="$(mktemp -t sold-nminus1-pid-XXXXXX)"
cleanup() {
  [ -s "$pidfile" ] && kill "$(cat "$pidfile")" 2>/dev/null || true
  psql "$admin" -qc "DROP DATABASE IF EXISTS $db" >/dev/null 2>&1 || true
  git -C "$root" worktree remove --force "$wt" >/dev/null 2>&1 || true; git -C "$root" worktree prune
  redis-cli --scan --pattern "sold:cache:$bid:*" 2>/dev/null | xargs -r redis-cli del >/dev/null 2>&1 || true
  rm -f "$pidfile"
}
trap cleanup EXIT

echo "== schema N: migrating a scratch database with this checkout"
psql "$admin" -qc "CREATE DATABASE $db"
(
  # BOTH urls: some commands prefer DATABASE_MIGRATION_URL, and the caller's environment points it at the real dev database.
  export DATABASE_URL=$url DATABASE_MIGRATION_URL=$url
  cd "$root"
  NODE_ENV=production pnpm db:migrate >/dev/null
  pnpm db:seed >/dev/null
  pnpm --filter @sold/web seed:demo >/dev/null
  SOLD_OWNER_PASSWORD="${SOLD_E2E_OWNER_PASSWORD:?}" pnpm sold user:create-owner --email "${SOLD_E2E_OWNER_EMAIL:?}" >/dev/null
)
echo "   schema head: $(psql "$url" -Atc "select max(name) from _sold_migrations where scope='base'")"

echo "== release N-1 ($PREV_REF): worktree, install, build"
git -C "$root" worktree add -q --detach "$wt" "$PREV_REF"
(cd "$wt" && pnpm install --frozen-lockfile --prefer-offline >/dev/null \
  && DATABASE_URL=$url DATABASE_MIGRATION_URL=$url SOLD_BUILD_ID=$bid pnpm --filter @sold/web build >/dev/null)
cp -r "$wt/apps/web/.next/static" "$wt/apps/web/.next/standalone/apps/web/.next/static"

echo "== running N-1 on the N schema (port 3100)"
# HOSTNAME=localhost: releases before the Host-header CSRF fix (fc6e9f3) cannot accept same-origin writes when the server binds 0.0.0.0.
( cd "$wt/apps/web/.next/standalone" && exec env DATABASE_URL=$url DATABASE_MIGRATION_URL=$url SOLD_BUILD_ID=$bid \
    SOLD_ENVIRONMENT=local PORT=3100 HOSTNAME=localhost NODE_ENV=production SOLD_ROLE=web node apps/web/server.js ) >"$wt/server.log" 2>&1 &
echo $! >"$pidfile"
for _ in $(seq 1 40); do curl -sf -o /dev/null localhost:3100/api/health/ready && break; sleep 1; done
curl -sf localhost:3100/api/health/ready >/dev/null || { echo "N-1 did not become ready on schema N"; tail -5 "$wt/server.log"; exit 1; }
echo "   N-1 reports ready (including its extension migration check)"

echo "== N-1's own e2e suite against it"
(cd "$wt/apps/web" && SOLD_E2E_URL=http://localhost:3100 npx vitest run --project e2e)
echo "N-1 ON N: PASSED"
