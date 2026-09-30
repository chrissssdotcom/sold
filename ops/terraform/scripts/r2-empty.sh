#!/usr/bin/env bash
# Empty a Cloudflare R2 bucket through its S3-compatible API so Terraform can delete it.
# R2 refuses to delete a bucket that still holds objects and the cloudflare provider (v5) has no
# force-destroy option. Called by a destroy-time provisioner in modules/cloudflare-r2 (non-prod only).
#
# Inputs (environment, never arguments, so nothing secret reaches process listings or state):
#   R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
# Requires the AWS CLI. Credentials are an R2 API token with Object Read & Write on the bucket.
set -euo pipefail

: "${R2_ACCOUNT_ID:?R2_ACCOUNT_ID is required}"
: "${R2_BUCKET:?R2_BUCKET is required}"
: "${R2_ACCESS_KEY_ID:?R2_ACCESS_KEY_ID is required (R2 API token, object read/write)}"
: "${R2_SECRET_ACCESS_KEY:?R2_SECRET_ACCESS_KEY is required}"

# Refuse anything that does not look like a sold environment bucket: a typo here deletes data.
case "$R2_BUCKET" in
  sold-*) ;;
  *)
    echo "refusing to empty '$R2_BUCKET': name does not start with sold-" >&2
    exit 2
    ;;
esac

export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION="auto"
export AWS_EC2_METADATA_DISABLED="true"
# R2 does not accept the default integrity checksums of recent AWS CLI versions.
export AWS_REQUEST_CHECKSUM_CALCULATION="when_required"
export AWS_RESPONSE_CHECKSUM_VALIDATION="when_required"

endpoint="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"

echo "emptying r2 bucket ${R2_BUCKET}" >&2
aws s3 rm "s3://${R2_BUCKET}" --recursive --only-show-errors --endpoint-url "$endpoint"

# Incomplete multipart uploads also block deletion.
aws s3api list-multipart-uploads --bucket "$R2_BUCKET" --endpoint-url "$endpoint" \
  --query 'Uploads[].[Key,UploadId]' --output text 2>/dev/null |
  while read -r key upload_id; do
    [ -z "${key:-}" ] || [ "$key" = "None" ] && continue
    aws s3api abort-multipart-upload --bucket "$R2_BUCKET" --key "$key" --upload-id "$upload_id" \
      --endpoint-url "$endpoint" >/dev/null
  done

echo "r2 bucket ${R2_BUCKET} emptied" >&2
