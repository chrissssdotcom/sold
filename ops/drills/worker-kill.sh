#!/usr/bin/env bash
# Chaos drill: SIGKILL the worker while it is processing the outbox, restart it, and prove that nothing was lost and no email doubled.
# LOCAL ONLY: starts/kills its own worker process and places test orders through the web app at BASE_URL.
# Needs: the web app running, DATABASE_URL (+ the usual env, as for `pnpm dev`), SOLD_E2E_OWNER_EMAIL/PASSWORD, a built worker (apps/web/.generated/worker.cjs).
#   ops/drills/worker-kill.sh
set -euo pipefail
BASE_URL="${BASE_URL:-http://localhost:3000}"
case "$BASE_URL" in http://localhost*|http://127.0.0.1*) ;; *) echo "refusing non-local BASE_URL" >&2; exit 2;; esac
: "${DATABASE_URL:?}"; : "${SOLD_E2E_OWNER_EMAIL:?}"; : "${SOLD_E2E_OWNER_PASSWORD:?}"
here="$(cd "$(dirname "$0")" && pwd)"
root="$here/../.."
orders=${ORDERS:-300}
q() { psql "$DATABASE_URL" -Atc "$1"; }
# `exec` so the recorded pid is the worker itself, not a wrapper shell (a wrapper would take the SIGKILL and leave the worker running).
start_worker() { ( cd "$root/apps/web" && exec env SOLD_ROLE=worker PORT=3001 node .generated/worker.cjs ) >"$wlog" 2>&1 & echo $! >"$wpid"; }
unpublished() { q "select count(*) from outbox_events where published_at is null"; }
wlog="$(mktemp -t worker-drill-XXXXXX.log)"; wpid="$(mktemp -t worker-drill-XXXXXX.pid)"
trap '[ -s "$wpid" ] && kill "$(cat "$wpid")" 2>/dev/null; rm -f "$wpid"' EXIT

# 1. Baseline: let a worker drain any older backlog first, so this run's numbers are only this run's orders.
start_worker
for _ in $(seq 1 180); do [ "$(unpublished)" = 0 ] && break; sleep 1; done
kill "$(cat "$wpid")"; wait "$(cat "$wpid")" 2>/dev/null || true
[ "$(unpublished)" = 0 ] || { echo "could not drain the baseline backlog"; exit 1; }
since=$(q "select now()")

# 2. With no worker running, place real orders: every one writes an outbox event.
node "$here/../loadtests/node/load.mjs" checkout-storm --base "$BASE_URL" --buyers "$orders" --stock "$orders" --label "worker-kill drill" >/dev/null
backlog=$(unpublished)
echo "orders placed: $orders; unpublished outbox events: $backlog"

# 3. Start a worker and SIGKILL it as soon as it has started publishing, so the kill lands mid-processing.
start_worker
for _ in $(seq 1 400); do [ "$(unpublished)" -lt "$backlog" ] && break; sleep 0.05; done
kill -9 "$(cat "$wpid")"; wait "$(cat "$wpid")" 2>/dev/null || true
mid=$(unpublished)
echo "SIGKILL mid-run: $mid of $backlog still unpublished"
[ "$mid" -gt 0 ] && [ "$mid" -lt "$backlog" ] || echo "NOTE: the kill did not land mid-processing; raise ORDERS for a meaningful run"

# 4. Restart: leased/unpublished work must be picked up again.
t0=$(date +%s)
start_worker
for _ in $(seq 1 180); do left=$(unpublished); [ "$left" = 0 ] && break; sleep 1; done
drain=$(( $(date +%s) - t0 ))
for _ in $(seq 1 120); do
  pending=$(q "select count(*) from notifications where created_at > '$since' and status in ('queued','sending')")
  [ "$pending" = 0 ] && break; sleep 1
done
total=$(q "select count(*) from notifications where created_at > '$since' and template = 'order-confirmation' and to_email like 'storm-%@example.test'")
sent=$(q "select count(*) from notifications where created_at > '$since' and template = 'order-confirmation' and to_email like 'storm-%@example.test' and status = 'sent'")
dupes=$(q "select count(*) from (select to_email from notifications where created_at > '$since' and template = 'order-confirmation' and to_email like 'storm-%@example.test' group by to_email having count(*) > 1) d")
echo "outbox drained in ${drain}s after restart (unpublished left: $left)"
echo "order confirmations for this run: $total queued, $sent sent, $dupes recipients with more than one"
if [ "$left" = 0 ] && [ "$total" = "$orders" ] && [ "$sent" = "$orders" ] && [ "$dupes" = 0 ]; then echo "DRILL PASSED"; else echo "DRILL FAILED"; tail -5 "$wlog"; exit 1; fi
