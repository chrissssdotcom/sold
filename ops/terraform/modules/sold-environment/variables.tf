# Inputs of the composite environment module.
#
# Profile = data, not code: everything that differs between ephemeral/dev/stage/prod and between
# the standard/high-volume/event-scale tiers arrives through `profile_settings` and `tier_settings`,
# loaded from ops/terraform/profiles/*.tfvars. This module contains no `if profile == "prod"` branches
# beyond consuming those settings (AGENTS.md principle 9).

variable "customer" {
  description = "Customer slug (3-12 lowercase alphanumerics; no hyphens so env-ids parse unambiguously)."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9]{2,11}$", var.customer))
    error_message = "customer must be 3-12 lowercase alphanumerics starting with a letter."
  }
}

variable "environment" {
  description = "Environment name, e.g. dev, stage, prod, or eph-my-branch-1a2b for ephemeral."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,30}$", var.environment))
    error_message = "environment must be lowercase alphanumerics and hyphens, 2-31 chars."
  }
}

variable "env_id" {
  description = "Globally unique environment id: <customer>-<environment>. Stamped on every resource as sold:env-id and used by `sold env:down --verify`."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,38}[a-z0-9]$", var.env_id))
    error_message = "env_id must be 4-40 chars of lowercase alphanumerics and hyphens."
  }
  validation {
    condition     = startswith(var.env_id, "${var.customer}-")
    error_message = "env_id must start with '<customer>-'."
  }
}

variable "profile" {
  description = "Rung on the environment ladder."
  type        = string
  validation {
    condition     = contains(["ephemeral", "dev", "stage", "prod"], var.profile)
    error_message = "profile must be one of ephemeral, dev, stage, prod."
  }
}

variable "tier" {
  description = "Sizing tier (orthogonal to the profile)."
  type        = string
  default     = "standard"
  validation {
    condition     = contains(["standard", "high-volume", "event-scale"], var.tier)
    error_message = "tier must be one of standard, high-volume, event-scale."
  }
}

variable "region" {
  description = "Azure region, e.g. australiaeast. Verify SKU and Managed Redis availability for the region before apply."
  type        = string
}

variable "release" {
  description = "The release being deployed. version is <base-version>+<customer>.<instance-build>; image is pinned by digest."
  type = object({
    version       = string
    image         = string           # web image (digest-pinned)
    worker_image  = optional(string) # Dockerfile target `worker`; null = same as image
    migrate_image = optional(string) # image with a migrate entrypoint; null = same as image
  })
  validation {
    condition     = can(regex("^[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.-]+)?\\+[a-z][a-z0-9]{2,11}\\.[0-9]+$", var.release.version))
    error_message = "release.version must look like 1.4.0+demo.27 (<base-version>+<customer>.<instance-build>)."
  }
  validation {
    condition = alltrue([
      for i in compact([var.release.image, var.release.worker_image, var.release.migrate_image]) :
      can(regex("@sha256:[a-f0-9]{64}$", i))
    ])
    error_message = "every release image must be pinned by digest (repository@sha256:<64 hex>)."
  }
}

variable "owner" {
  description = "Who to warn before expiry and who owns the cost (GitHub handle or email)."
  type        = string
  validation {
    condition     = can(regex("^[A-Za-z0-9._@+-]{2,64}$", var.owner))
    error_message = "owner must be 2-64 chars of letters, digits and . _ @ + - (valid in Azure tag values)."
  }
}

variable "expires_at" {
  description = "RFC 3339 UTC timestamp after which the environment is destroyed by the expiry workflow, or the literal 'never' (dev/stage/prod)."
  type        = string
  validation {
    condition     = var.expires_at == "never" || can(formatdate("YYYY-MM-DD", var.expires_at))
    error_message = "expires_at must be an RFC 3339 timestamp (2026-10-02T12:00:00Z) or 'never'."
  }
  validation {
    condition     = var.profile != "ephemeral" || var.expires_at != "never"
    error_message = "Ephemeral environments must carry a real expires_at; they may not live forever."
  }
  validation {
    condition     = var.profile != "prod" || var.expires_at == "never"
    error_message = "Production must carry expires_at = never so the expiry workflow can never select it."
  }
}

variable "profile_settings" {
  description = "Environment-ladder data from profiles/<profile>.tfvars."
  type = object({
    resource_lock          = bool # CanNotDelete lock on the resource group
    protect_stateful       = bool # prevent_destroy on stateful resources + Key Vault purge protection
    redis_enabled          = bool
    service_bus_enabled    = bool
    private_endpoints      = bool # Redis / Service Bus private endpoints (Service Bus requires Premium)
    revision_mode          = string
    postgres_password_auth = bool
    generate_app_secrets   = bool # generate SOLD_SECRET_KEY in Key Vault (non-prod only; prod keys are provisioned out of band)
    log_retention_days     = number
    log_daily_quota_gb     = number
    budget_monthly         = number
    origin_cert_days       = number
  })
  validation {
    condition     = var.profile != "prod" || (var.profile_settings.protect_stateful && var.profile_settings.resource_lock)
    error_message = "Production requires protect_stateful = true and resource_lock = true."
  }
}

variable "tier_settings" {
  description = "Capacity data. stage/prod load profiles/tier-<tier>.tfvars; ephemeral/dev carry their own small capacity inside profiles/<profile>.tfvars (the tier does not scale them)."
  type = object({
    web_cpu                  = number
    web_memory               = string
    web_min_replicas         = number
    web_max_replicas         = number
    web_concurrency          = number
    worker_cpu               = number
    worker_memory            = string
    worker_min_replicas      = number
    worker_max_replicas      = number
    dedicated_profile        = optional(object({ name = string, type = string, minimum_count = number, maximum_count = number }))
    db_sku_name              = string
    db_storage_mb            = number
    db_ha_mode               = string
    db_read_replica_count    = number
    db_backup_retention_days = number
    db_geo_redundant_backup  = bool
    redis_sku_name           = string
    redis_ha                 = bool
    servicebus_sku           = string
    servicebus_capacity      = number
    zone_redundant           = bool
  })
}

variable "registry" {
  description = "Customer container registry holding the signed image."
  type = object({
    id           = string
    login_server = string
    grant_pull   = optional(bool, true) # grant the environment identity AcrPull (needs rights on the registry scope)
  })
}

variable "cloudflare" {
  description = "Edge settings. enabled = false skips every Cloudflare resource (e.g. a sandbox with no zone)."
  type = object({
    enabled    = bool
    account_id = optional(string)
    zone_id    = optional(string)
    hostname   = optional(string)
  })
  default = { enabled = false }
  validation {
    condition     = !var.cloudflare.enabled || (var.cloudflare.account_id != null && var.cloudflare.zone_id != null && var.cloudflare.hostname != null)
    error_message = "cloudflare.account_id, zone_id and hostname are required when cloudflare.enabled is true."
  }
}

variable "access" {
  description = "Cloudflare Access allow-list. Enable for every non-production environment."
  type = object({
    enabled               = bool
    allowed_email_domains = optional(list(string), [])
    allowed_emails        = optional(list(string), [])
  })
  default = { enabled = false }
}

variable "email" {
  description = "Sender-authentication DNS for transactional mail."
  type = object({
    enabled                  = bool
    sending_domain           = optional(string)
    spf_includes             = optional(list(string), [])
    dkim_records             = optional(map(object({ name = string, type = string, content = string })), {})
    dmarc_policy             = optional(string, "none")
    dmarc_report_address     = optional(string)
    cloudflare_email_sending = optional(bool, false)
  })
  default = { enabled = false }
}

variable "alert_emails" {
  description = "Budget and alert recipients (at least one)."
  type        = list(string)
}

variable "entra_admin_group_object_id" {
  description = "Optional Entra group granted PostgreSQL administrator (platform on-call)."
  type        = string
  default     = null
}

variable "address_space" {
  type    = string
  default = "10.42.0.0/16"
}

variable "paused" {
  description = "env:pause / env:resume: scales web and worker to zero. PostgreSQL is stopped/started by the CLI (az), not Terraform."
  type        = bool
  default     = false
}

variable "canary_percent" {
  description = "Traffic share for the new revision (Multiple revision mode only)."
  type        = number
  default     = 100
}

variable "previous_revision_suffix" {
  description = "Revision keeping the rest of the traffic during a canary (e.g. b26)."
  type        = string
  default     = null
}

variable "scale_mode" {
  description = "normal | prescale (SOLD_SCALE_MODE)."
  type        = string
  default     = "normal"
  validation {
    condition     = contains(["normal", "prescale"], var.scale_mode)
    error_message = "scale_mode must be normal or prescale."
  }
}

variable "extra_app_env" {
  description = "Additional non-secret environment variables (instance configuration)."
  type        = map(string)
  default     = {}
}

variable "budget_start_date" {
  description = "Optional RFC 3339 first-of-month start for the budget; defaults to the current month."
  type        = string
  default     = null
}

variable "drift_reader_object_id" {
  description = "Optional read-only identity for the nightly drift plan: gets Reader on the resource group and Key Vault Secrets User on the vault (a refresh reads secret values)."
  type        = string
  default     = null
}
