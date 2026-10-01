#!/usr/bin/env bash
# Pre-sale readiness check. READ-ONLY: HTTP GETs and SELECTs. Prints PASS/WARN/FAIL per item; exit 1 on any FAIL.
# It automates what can be checked mechanically. The manual items (backup recency, gateway limits, edge config) are listed at the
# end because a script cannot see them: see docs/sale-readiness.md.
#
#   BASE_URL=https://shop.example DATABASE_URL=postgres://... EXPECT_ENV=prod ops/drills/sale-readiness.sh
set -uo pipefail
BASE_URL="${BASE_URL:-http://localhost:3000}"
EXPECT_ENV="${EXPECT_ENV:-prod}"
fail=0
row() { printf '%-5s %s\n' "$1" "$2"; [ "$1" = FAIL ] && fail=1; return 0; }
q() { psql "$DATABASE_URL" -Atc "$1" 2>/dev/null; }
# Follows redirects (`/` redirects to the market page) and reads the FINAL response's header.
hdr() { curl -sIL -m 10 "$BASE_URL$1" | tr -d '\r' | grep -i "^$2:" | tail -1 | cut -d: -f2- | sed 's/^ //'; }

code=$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$BASE_URL/api/health/ready")
[ "$code" = 200 ] && row PASS "readiness 200" || row FAIL "readiness returned $code"

ver=$(curl -s -m 10 "$BASE_URL/api/version")
bid=$(printf '%s' "$ver" | sed -nE 's/.*"buildId":"([^"]*)".*/\1/p')
case "$bid" in ''|dev) row FAIL "build id is '${bid:-missing}': not a release build";; *) row PASS "release build id $bid";; esac

robots=$(hdr / x-robots-tag)
if [ "$EXPECT_ENV" = prod ]; then
  [ -z "$robots" ] && row PASS "indexable (no X-Robots-Tag)" || row FAIL "X-Robots-Tag '$robots' on a prod-expected site: search engines are told to ignore it"
else
  [ -n "$robots" ] && row PASS "noindex in non-prod" || row FAIL "non-prod site is indexable"
fi

[ -n "$(hdr / strict-transport-security)" ] && row PASS "HSTS present" || row WARN "no HSTS (expected behind TLS)"
csp=$(hdr / content-security-policy)
case "$csp" in *unsafe-eval*) row FAIL "CSP allows unsafe-eval (dev server?)";; '') row FAIL "no CSP";; *) row PASS "CSP present, no unsafe-eval";; esac

if [ -n "${DATABASE_URL:-}" ]; then
  on=$(q "SELECT string_agg(key, ', ') FROM feature_flags WHERE enabled AND (key LIKE 'degrade.%' OR key LIKE 'shed.%')")
  [ -z "$on" ] && row PASS "no degradation/shedding flag is on" || row FAIL "left on: $on"
  stuck=$(q "SELECT count(*) FROM outbox_events WHERE published_at IS NULL AND created_at < now() - interval '5 minutes'")
  [ "${stuck:-x}" = 0 ] && row PASS "outbox drained" || row FAIL "outbox has $stuck events older than 5 min (is the worker running?)"
  em=$(q "SELECT count(*) FROM notifications WHERE status = 'failed' OR (status IN ('queued','sending') AND created_at < now() - interval '10 minutes')")
  [ "${em:-x}" = 0 ] && row PASS "no failed/stuck emails" || row WARN "$em failed or stuck emails"
  pay=$(q "SELECT count(*) FROM payment_events WHERE error = 'needs_attention'")
  [ "${pay:-x}" = 0 ] && row PASS "no payments needing attention" || row FAIL "$pay payment events need attention"
  pend=$(q "SELECT count(*) FROM orders WHERE status = 'pending_payment' AND placed_at < now() - interval '1 hour'")
  [ "${pend:-x}" = 0 ] && row PASS "no stale pending_payment orders" || row WARN "$pend orders pending payment > 1 h (expiry sweep running?)"
  inv=$(q "SELECT count(*) FROM inventory_levels WHERE reserved < 0 OR on_hand < 0")
  [ "${inv:-x}" = 0 ] && row PASS "no negative stock" || row FAIL "$inv inventory rows are negative"
  q "SELECT 'INFO  hot-SKU watch: ' || count(*) || ' variants with <= 5 available' FROM inventory_levels WHERE on_hand - reserved <= 5"
else
  row WARN "DATABASE_URL not set: skipped flag, outbox, email, payment and stock checks"
fi

cat <<'MANUAL'

Manual (cannot be checked from here): newest backup < 26 h and a restore drill within 90 days; gateway account limits and webhook
endpoint registered for THIS environment; edge WAF/rate-limit/waiting-room rules applied; SMTP/Postmark domain authenticated (SPF/DKIM/
DMARC); on-call rota and escalation reachable; flags UI reachable by the person who will flip shedding; load test of THIS tier passed.
MANUAL
[ $fail -eq 0 ] && echo "READY (no FAIL items)" || { echo "NOT READY"; exit 1; }
