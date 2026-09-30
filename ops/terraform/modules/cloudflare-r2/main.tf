terraform {
  required_version = ">= 1.9.0"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.26.0"
    }
  }
}

# One R2 bucket per environment (media/uploads via the S3-compatible storage interface).
#
# R2 will not delete a non-empty bucket and provider v5 has no force-destroy option
# (cloudflare/terraform-provider-cloudflare#5743). Approach, decided in ADR-0003:
#   * non-prod:  a destroy-time provisioner empties the bucket through the S3 API first
#                (scripts/r2-empty.sh; needs the AWS CLI and R2 credentials in the runner env);
#   * prod:      the bucket is prevent_destroy and never emptied automatically.
# Alternative if the runner cannot run the script: add a 1-day expire-all lifecycle rule,
# wait, then destroy (documented in docs/runbooks/environments.md).
# prevent_destroy cannot be conditional, hence two bucket resources selected by `count`.

variable "account_id" {
  type = string
}

variable "name" {
  description = "Bucket name (3-63 chars). Must start with sold- (the empty script refuses anything else) and include the env-id."
  type        = string
  validation {
    condition     = can(regex("^sold-[a-z0-9][a-z0-9-]{1,56}[a-z0-9]$", var.name))
    error_message = "Bucket names must start with sold-, be lowercase alphanumerics and hyphens, and be at most 63 characters."
  }
}

variable "location" {
  description = "Location hint: apac, eeur, enam, oc, weur, wnam. Null = automatic."
  type        = string
  default     = null
}

variable "storage_class" {
  type    = string
  default = "Standard"
}

variable "protect" {
  description = "Production posture: prevent_destroy and no automatic emptying."
  type        = bool
  default     = false
}

variable "script_path" {
  description = "Path to scripts/r2-empty.sh."
  type        = string
  default     = "../../scripts/r2-empty.sh"
}

resource "cloudflare_r2_bucket" "protected" {
  count = var.protect ? 1 : 0

  account_id    = var.account_id
  name          = var.name
  location      = var.location
  storage_class = var.storage_class

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_r2_bucket" "unprotected" {
  count = var.protect ? 0 : 1

  account_id    = var.account_id
  name          = var.name
  location      = var.location
  storage_class = var.storage_class
}

# Destroyed BEFORE the bucket (it depends on it), so the bucket is empty when Terraform deletes it.
resource "terraform_data" "empty_on_destroy" {
  count = var.protect ? 0 : 1

  input = {
    account_id = var.account_id
    bucket     = var.name
    script     = "${path.module}/${var.script_path}"
  }

  provisioner "local-exec" {
    when    = destroy
    command = "bash \"${self.input.script}\""
    environment = {
      R2_ACCOUNT_ID = self.input.account_id
      R2_BUCKET     = self.input.bucket
      # R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY are inherited from the runner environment.
    }
  }

  depends_on = [cloudflare_r2_bucket.unprotected]
}

output "bucket_name" {
  value = var.name
}

output "s3_endpoint" {
  value = "https://${var.account_id}.r2.cloudflarestorage.com"
}
