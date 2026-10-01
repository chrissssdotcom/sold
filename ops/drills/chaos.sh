#!/usr/bin/env bash
# Chaos drill: stop a dependency in the middle of a browse load and bring it back. LOCAL ONLY (it controls services on this host).
#   BASE_URL=http://localhost:3000 ops/drills/chaos.sh redis|postgres
# redis:    expect no 5xx; latency may rise; automatic recovery (docs/runbooks/operations.md#redis-down)
# postgres: expect cached pages to keep serving, dynamic routes to fail fast with a clean 5xx, liveness to stay 200, readiness to go 503
#           and recover by itself, with no web restart.
set -euo pipefail
BASE_URL="${BASE_URL:-http://localhost:3000}"
case "$BASE_URL" in http://localhost*|http://127.0.0.1*) ;; *) echo "refusing non-local BASE_URL" >&2; exit 2;; esac
what="${1:-redis}"
here="$(cd "$(dirname "$0")" && pwd)"
out="$(mktemp -t chaos-redis-XXXXXX.json)"
stop_dep() { case "$what" in redis) redis-cli shutdown nosave >/dev/null 2>&1 || true;; postgres) pg_ctlcluster 16 main stop -m fast;; *) echo "unknown: $what" >&2; exit 2;; esac; }
start_dep() { case "$what" in redis) (cd /tmp && redis-server --daemonize yes --save "" --port 6379 >/dev/null);; postgres) pg_ctlcluster 16 main start;; esac; }
healthy() { case "$what" in redis) redis-cli ping >/dev/null 2>&1;; postgres) pg_isready -q;; esac; }
trap 'healthy || start_dep' EXIT
node "$here/../loadtests/node/load.mjs" browse --base "$BASE_URL" --workers 10 --seconds 40 --label "chaos: $what down 10s-25s" --out "$out" >/dev/null &
load=$!
sleep 10
echo "t=10s: stopping $what"; stop_dep
live_during=$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$BASE_URL/api/health/live"); ready_during=$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$BASE_URL/api/health/ready")
echo "  during outage: liveness $live_during, readiness $ready_during"
sleep 14
echo "t=25s: starting $what"; start_dep
wait $load
sleep 3
ready=$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$BASE_URL/api/health/ready")
python3 - "$out" "$ready" "$what" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))['result']
print(f"{'window':>8} {'rps':>7} {'p95 ms':>8} {'error rate':>11}  statuses")
for w in r['windows']:
    print(f"{w['t']:>6}s {w['rps']:>7} {w['p95']:>8} {w['errorRate']:>11}  {w['statuses']}")
print(f"overall: {r['requests']} requests, error rate {r['errorRate']}, statuses {r['statuses']}; readiness after recovery: {sys.argv[2]}")
# redis must cause no errors at all; postgres is expected to cause some (dynamic routes), but recovery must be complete.
sys.exit(0 if (sys.argv[3] == 'postgres' or r['errorRate'] == 0) and sys.argv[2] == '200' else 1)
PY
