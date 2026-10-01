#!/usr/bin/env bash
# Backup/restore drill: dump a database, restore it into a scratch database, prove the data survived, report timings.
# Safe by construction: it only ever READS the source and only CREATES/DROPS its own scratch database. It refuses
# non-local hosts so it cannot be pointed at a real environment by accident (run real drills via the platform's PITR).
#
#   SOURCE_URL=postgres://sold:sold@localhost:5432/sold ops/drills/backup-restore.sh
set -euo pipefail
SOURCE_URL="${SOURCE_URL:-${DATABASE_URL:-}}"
[ -n "$SOURCE_URL" ] || { echo "set SOURCE_URL" >&2; exit 2; }
host=$(printf '%s' "$SOURCE_URL" | sed -E 's#^[a-z]+://([^@]*@)?([^:/?]+).*#\2#')
case "$host" in localhost|127.0.0.1|::1) ;; *) echo "refusing non-local host '$host'" >&2; exit 2;; esac

scratch="sold_restore_drill_$$"
admin_url=$(printf '%s' "$SOURCE_URL" | sed -E 's#/[^/?]+(\?.*)?$#/postgres#')
scratch_url=$(printf '%s' "$SOURCE_URL" | sed -E "s#/[^/?]+(\?.*)?\$#/$scratch#")
dump="$(mktemp -t sold-drill-XXXXXX.dump)"
cleanup() { psql "$admin_url" -qc "DROP DATABASE IF EXISTS \"$scratch\"" >/dev/null 2>&1 || true; rm -f "$dump"; }
trap cleanup EXIT

now() { date +%s.%N; }
t0=$(now)
pg_dump --format=custom --no-owner --no-privileges "$SOURCE_URL" -f "$dump"
t1=$(now)
psql "$admin_url" -qc "CREATE DATABASE \"$scratch\"" >/dev/null
# Roles (sold_grafana, extension roles) are cluster-level and not in the dump: grants referencing them are skipped on purpose;
# the CLI re-applies them (reporting:enable-login, ext:migrate). That gap is part of what this drill documents.
pg_restore --no-owner --no-privileges --exit-on-error --dbname "$scratch_url" "$dump" 2>restore.err || {
  echo "restore failed:"; cat restore.err; exit 1; }
rm -f restore.err
t2=$(now)

q() { psql "$1" -Atc "$2"; }
tables="products product_variants orders payments users audit_log outbox_events notifications media_assets _sold_migrations"
fail=0
printf '%-20s %12s %12s  %s\n' table source restored match
for t in $tables; do
  a=$(q "$SOURCE_URL" "SELECT count(*) FROM $t" 2>/dev/null || echo n/a)
  b=$(q "$scratch_url" "SELECT count(*) FROM $t" 2>/dev/null || echo n/a)
  [ "$a" = "$b" ] && m=yes || { m=NO; fail=1; }
  printf '%-20s %12s %12s  %s\n' "$t" "$a" "$b" "$m"
done
# Content check beyond counts: money and the migration journal must be byte-identical.
sum_a=$(q "$SOURCE_URL" "SELECT md5(string_agg(id::text||total::text||status, ',' ORDER BY id)) FROM orders")
sum_b=$(q "$scratch_url" "SELECT md5(string_agg(id::text||total::text||status, ',' ORDER BY id)) FROM orders")
mig_a=$(q "$SOURCE_URL" "SELECT md5(string_agg(scope||name||checksum, ',' ORDER BY scope,name)) FROM _sold_migrations")
mig_b=$(q "$scratch_url" "SELECT md5(string_agg(scope||name||checksum, ',' ORDER BY scope,name)) FROM _sold_migrations")
[ "$sum_a" = "$sum_b" ] || { echo "orders checksum MISMATCH"; fail=1; }
[ "$mig_a" = "$mig_b" ] || { echo "migration journal MISMATCH"; fail=1; }
# Constraints survived (a restore that drops FKs "works" until the first bad write).
fk_a=$(q "$SOURCE_URL" "SELECT count(*) FROM pg_constraint WHERE contype='f'")
fk_b=$(q "$scratch_url" "SELECT count(*) FROM pg_constraint WHERE contype='f'")
[ "$fk_a" = "$fk_b" ] || { echo "foreign keys: $fk_a vs $fk_b MISMATCH"; fail=1; }

size=$(du -h "$dump" | cut -f1)
printf '\ndump %.1fs (%s) · restore %.1fs · foreign keys %s · orders checksum %s\n' \
  "$(echo "$t1 - $t0" | bc)" "$size" "$(echo "$t2 - $t1" | bc)" "$fk_b" "$([ "$sum_a" = "$sum_b" ] && echo identical || echo DIFFERENT)"
[ $fail -eq 0 ] && echo "DRILL PASSED" || { echo "DRILL FAILED"; exit 1; }
