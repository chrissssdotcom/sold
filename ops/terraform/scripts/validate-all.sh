#!/usr/bin/env bash
# Validate every Terraform module and environment root without cloud credentials.
#   ./validate-all.sh                 # uses `terraform`
#   TF_BIN=tofu ./validate-all.sh     # OpenTofu
# For each directory: init -backend=false, validate, fmt -check; modules that ship tests/ also
# run `test` (offline, mock providers). Exits non-zero on the first failing directory group.
set -euo pipefail

TF_BIN="${TF_BIN:-terraform}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export TF_IN_AUTOMATION=1

fail=0
run_dir() {
  local dir="$1" label="$2"
  echo "==> ${label}"
  (
    cd "$dir"
    # Only environment roots and the bootstrap commit a lock file. Validation must leave the tree as it
    # found it: modules must not gain a lock file, and OpenTofu (which records its own registry) must not
    # rewrite the committed Terraform lock.
    saved=""
    if [ -f .terraform.lock.hcl ]; then saved="$(mktemp)" && cp .terraform.lock.hcl "$saved"; fi
    status=0
    "$TF_BIN" init -backend=false -input=false -no-color > /dev/null || status=$?
    if [ "$status" -eq 0 ]; then "$TF_BIN" validate -no-color || status=$?; fi
    if [ "$status" -eq 0 ] && [ -d tests ]; then "$TF_BIN" test -no-color || status=$?; fi
    if [ -n "$saved" ]; then mv "$saved" .terraform.lock.hcl; else rm -f .terraform.lock.hcl; fi
    exit "$status"
  ) || fail=1
}

for dir in "$root"/modules/*/ "$root"/bootstrap/*/ "$root"/environments/*/*/; do
  [ -f "$dir/main.tf" ] || continue
  run_dir "$dir" "${dir#"$root"/}"
done

echo "==> fmt -check"
"$TF_BIN" fmt -check -recursive -diff "$root" || fail=1

exit "$fail"
