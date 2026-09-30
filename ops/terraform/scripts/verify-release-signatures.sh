#!/usr/bin/env bash
# Refuse to deploy an image that was not built and signed by this repository's release workflow on main.
#   verify-release-signatures.sh <dev|stage|prod>
# Reads environments/<env>/release.json, verifies the Sigstore keyless signature of every image digest it
# names (web, and worker/migrate when present) against the workflow identity, and fails on the first
# missing or foreign signature. Needs: cosign, jq, and a registry login (`az acr login`).
# Environment: ACR_NAME (registry name), GITHUB_REPOSITORY (set by GitHub Actions).
set -euo pipefail

env_name="${1:?usage: verify-release-signatures.sh <dev|stage|prod>}"
case "$env_name" in dev | stage | prod) ;; *)
  echo "unsupported environment: $env_name" >&2
  exit 2
  ;;
esac

: "${ACR_NAME:?ACR_NAME is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"

release_file="environments/${env_name}/release.json"
[ -f "$release_file" ] || {
  echo "$release_file not found" >&2
  exit 1
}

registry="${ACR_NAME}.azurecr.io"
identity="https://github.com/${GITHUB_REPOSITORY}/.github/workflows/release.yml@refs/heads/main"
issuer="https://token.actions.githubusercontent.com"

verify() {
  local image="$1"
  echo "verifying ${image}"
  cosign verify \
    --certificate-identity "$identity" \
    --certificate-oidc-issuer "$issuer" \
    "$image" > /dev/null
}

web="$(jq -r '.imageDigest' "$release_file")"
worker="$(jq -r '.workerImageDigest // empty' "$release_file")"
migrate="$(jq -r '.migrateImageDigest // empty' "$release_file")"

verify "${registry}/sold/web@${web}"
[ -z "$worker" ] || verify "${registry}/sold/worker@${worker}"
[ -z "$migrate" ] || verify "${registry}/sold/migrate@${migrate}"
echo "all signatures verified for ${env_name}"
