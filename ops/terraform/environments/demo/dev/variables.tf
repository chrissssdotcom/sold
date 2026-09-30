variable "subscription_id" {
  description = "Customer Azure subscription for non-production."
  type        = string
}

variable "region" {
  type = string
}

variable "owner" {
  type = string
}

variable "alert_emails" {
  type = list(string)
}

variable "tier" {
  description = "Sizing tier; recorded for reference. Capacity itself comes from -var-file=profiles/tier-<tier>.tfvars (or the profile file for dev)."
  type        = string
  default     = "standard"
}

variable "registry" {
  type = object({
    id           = string
    login_server = string
    grant_pull   = optional(bool, true)
  })
}

variable "cloudflare" {
  type = object({
    enabled    = bool
    account_id = optional(string)
    zone_id    = optional(string)
    hostname   = optional(string)
  })
}

variable "access" {
  type = object({
    enabled               = bool
    allowed_email_domains = optional(list(string), [])
    allowed_emails        = optional(list(string), [])
  })
}

variable "email" {
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

variable "paused" {
  type    = bool
  default = false
}

variable "canary_percent" {
  description = "Traffic share for the new revision (Multiple revision mode); 100 = fully promoted."
  type        = number
  default     = 100
}

variable "previous_revision_suffix" {
  description = "Revision that keeps the remaining traffic during a canary, e.g. b26."
  type        = string
  default     = null
}

variable "drift_reader_object_id" {
  description = "Object ID of the read-only identity used by the nightly drift plan (Reader + Key Vault Secrets User)."
  type        = string
  default     = null
}

# Supplied by -var-file=../../../profiles/dev.tfvars
variable "profile_settings" {
  type = object({
    resource_lock          = bool
    protect_stateful       = bool
    redis_enabled          = bool
    service_bus_enabled    = bool
    private_endpoints      = bool
    revision_mode          = string
    postgres_password_auth = bool
    generate_app_secrets   = bool
    log_retention_days     = number
    log_daily_quota_gb     = number
    budget_monthly         = number
    origin_cert_days       = number
  })
}

variable "tier_settings" {
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
