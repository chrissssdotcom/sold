terraform {
  required_version = ">= 1.9.0"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 5.7"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.9"
    }
  }
}

variable "name" {
  description = "Server name. Globally unique across Azure (the composite adds a subscription-derived suffix)."
  type        = string
}

variable "location" {
  type = string
}

variable "resource_group_name" {
  type = string
}

variable "tenant_id" {
  type = string
}

variable "postgres_version" {
  type    = string
  default = "17"
  validation {
    condition     = contains(["16", "17", "18"], var.postgres_version)
    error_message = "ADR-0001 requires PostgreSQL 16+; supported here: 16, 17, 18."
  }
}

variable "sku_name" {
  description = "Tier + name, e.g. B_Standard_B1ms, GP_Standard_D4ds_v5, MO_Standard_E8ds_v5. Verify SKU availability per region before apply (ADR-0002)."
  type        = string
  validation {
    condition     = can(regex("^(B|GP|MO)_Standard_", var.sku_name))
    error_message = "sku_name must look like B_Standard_..., GP_Standard_... or MO_Standard_...."
  }
}

variable "storage_mb" {
  type    = number
  default = 32768
}

variable "ha_mode" {
  description = "Disabled, SameZone or ZoneRedundant. Not available on Burstable."
  type        = string
  default     = "Disabled"
  validation {
    condition     = contains(["Disabled", "SameZone", "ZoneRedundant"], var.ha_mode)
    error_message = "ha_mode must be Disabled, SameZone or ZoneRedundant."
  }
  validation {
    condition     = var.ha_mode == "Disabled" || !startswith(var.sku_name, "B_")
    error_message = "High availability is not offered on the Burstable tier; use a GP_ or MO_ SKU (ADR-0002, UNVERIFIED for HA on Burstable - enforced defensively)."
  }
}

variable "read_replica_count" {
  description = "Read replicas in the same region. Not supported on Burstable (ADR-0002)."
  type        = number
  default     = 0
  validation {
    condition     = var.read_replica_count >= 0 && var.read_replica_count <= 5
    error_message = "Azure allows at most 5 read replicas per primary."
  }
  validation {
    condition     = var.read_replica_count == 0 || !startswith(var.sku_name, "B_")
    error_message = "Read replicas are not supported on the Burstable tier."
  }
}

variable "backup_retention_days" {
  description = "PITR window. 7-35 days."
  type        = number
  default     = 7
  validation {
    condition     = var.backup_retention_days >= 7 && var.backup_retention_days <= 35
    error_message = "backup_retention_days must be between 7 and 35."
  }
}

variable "geo_redundant_backup" {
  type    = bool
  default = false
}

variable "delegated_subnet_id" {
  type = string
}

variable "private_dns_zone_id" {
  type = string
}

variable "protect" {
  description = "When true the server lives in a resource with lifecycle.prevent_destroy = true. See ADR-0003 (prevent_destroy cannot be conditional, so there are two resource blocks gated by count)."
  type        = bool
  default     = false
}

variable "password_auth_enabled" {
  description = "Entra-only by default. Enable only when the application cannot use Entra tokens yet."
  type        = bool
  default     = false
}

variable "administrator_login" {
  type    = string
  default = "soldadmin"
}

variable "entra_administrators" {
  description = "Entra principals granted the PostgreSQL administrator role, keyed by a stable label."
  type = map(object({
    object_id      = string
    principal_name = string
    principal_type = string # User | Group | ServicePrincipal
  }))
  default = {}
}

variable "database_name" {
  type    = string
  default = "sold"
}

variable "allowed_extensions" {
  type    = list(string)
  default = ["PG_TRGM", "BTREE_GIN", "CITEXT", "PGCRYPTO", "PG_STAT_STATEMENTS"]
}

variable "maintenance_window" {
  description = "UTC. Default Sunday 16:00 UTC."
  type = object({
    day_of_week  = number
    start_hour   = number
    start_minute = number
  })
  default = { day_of_week = 0, start_hour = 16, start_minute = 0 }
}

variable "diagnostics_enabled" {
  description = "Send logs and metrics to Log Analytics. Static (not derived from the workspace id) so `count` is known at plan time."
  type        = bool
  default     = false
}

variable "log_analytics_workspace_id" {
  type    = string
  default = null
}

variable "tags" {
  type = map(string)
  validation {
    condition = alltrue([
      for t in ["sold:customer", "sold:environment", "sold:profile", "sold:owner", "sold:expires-at", "sold:release", "sold:env-id"] :
      contains(keys(var.tags), t) && try(length(var.tags[t]) > 0, false)
    ])
    error_message = "tags must include non-empty sold:customer, sold:environment, sold:profile, sold:owner, sold:expires-at, sold:release and sold:env-id."
  }
}

locals {
  is_burstable = startswith(var.sku_name, "B_")
  # Built-in PgBouncer is not available on Burstable (ADR-0002). Burstable environments connect directly.
  pgbouncer_enabled = !local.is_burstable
  use_password      = var.password_auth_enabled
}

resource "random_password" "admin" {
  count   = local.use_password ? 1 : 0
  length  = 40
  special = false # avoids URL-escaping problems in connection strings
}

# ---------------------------------------------------------------------------
# Primary server. prevent_destroy must be a literal, so protected and
# unprotected variants are separate resources selected by `count`.
# Keep the two blocks byte-for-byte identical apart from `lifecycle`.
# ---------------------------------------------------------------------------
resource "azurerm_postgresql_flexible_server" "protected" {
  count = var.protect ? 1 : 0

  name                          = var.name
  resource_group_name           = var.resource_group_name
  location                      = var.location
  version                       = var.postgres_version
  sku_name                      = var.sku_name
  storage_mb                    = var.storage_mb
  auto_grow_enabled             = true
  backup_retention_days         = var.backup_retention_days
  geo_redundant_backup_enabled  = var.geo_redundant_backup
  delegated_subnet_id           = var.delegated_subnet_id
  private_dns_zone_id           = var.private_dns_zone_id
  public_network_access_enabled = false
  administrator_login           = local.use_password ? var.administrator_login : null
  administrator_password        = local.use_password ? random_password.admin[0].result : null
  tags                          = var.tags

  authentication {
    active_directory_auth_enabled = true
    password_auth_enabled         = local.use_password
    tenant_id                     = var.tenant_id
  }

  dynamic "high_availability" {
    for_each = var.ha_mode == "Disabled" ? [] : [var.ha_mode]
    content {
      mode = high_availability.value
    }
  }

  maintenance_window {
    day_of_week  = var.maintenance_window.day_of_week
    start_hour   = var.maintenance_window.start_hour
    start_minute = var.maintenance_window.start_minute
  }

  lifecycle {
    prevent_destroy = true
    ignore_changes  = [zone, high_availability[0].standby_availability_zone]
  }
}

resource "azurerm_postgresql_flexible_server" "unprotected" {
  count = var.protect ? 0 : 1

  name                          = var.name
  resource_group_name           = var.resource_group_name
  location                      = var.location
  version                       = var.postgres_version
  sku_name                      = var.sku_name
  storage_mb                    = var.storage_mb
  auto_grow_enabled             = true
  backup_retention_days         = var.backup_retention_days
  geo_redundant_backup_enabled  = var.geo_redundant_backup
  delegated_subnet_id           = var.delegated_subnet_id
  private_dns_zone_id           = var.private_dns_zone_id
  public_network_access_enabled = false
  administrator_login           = local.use_password ? var.administrator_login : null
  administrator_password        = local.use_password ? random_password.admin[0].result : null
  tags                          = var.tags

  authentication {
    active_directory_auth_enabled = true
    password_auth_enabled         = local.use_password
    tenant_id                     = var.tenant_id
  }

  dynamic "high_availability" {
    for_each = var.ha_mode == "Disabled" ? [] : [var.ha_mode]
    content {
      mode = high_availability.value
    }
  }

  maintenance_window {
    day_of_week  = var.maintenance_window.day_of_week
    start_hour   = var.maintenance_window.start_hour
    start_minute = var.maintenance_window.start_minute
  }

  lifecycle {
    ignore_changes = [zone, high_availability[0].standby_availability_zone]
  }
}

locals {
  server_id   = one(concat(azurerm_postgresql_flexible_server.protected[*].id, azurerm_postgresql_flexible_server.unprotected[*].id))
  server_name = one(concat(azurerm_postgresql_flexible_server.protected[*].name, azurerm_postgresql_flexible_server.unprotected[*].name))
  server_fqdn = one(concat(azurerm_postgresql_flexible_server.protected[*].fqdn, azurerm_postgresql_flexible_server.unprotected[*].fqdn))
}

resource "azurerm_postgresql_flexible_server_active_directory_administrator" "this" {
  for_each = var.entra_administrators

  server_name         = local.server_name
  resource_group_name = var.resource_group_name
  tenant_id           = var.tenant_id
  object_id           = each.value.object_id
  principal_name      = each.value.principal_name
  principal_type      = each.value.principal_type
}

resource "azurerm_postgresql_flexible_server_database" "app" {
  name      = var.database_name
  server_id = local.server_id
  charset   = "UTF8"
  collation = "en_US.utf8"
}

resource "azurerm_postgresql_flexible_server_configuration" "extensions" {
  name      = "azure.extensions"
  server_id = local.server_id
  value     = join(",", var.allowed_extensions)
}

resource "azurerm_postgresql_flexible_server_configuration" "pgbouncer" {
  count     = local.pgbouncer_enabled ? 1 : 0
  name      = "pgbouncer.enabled"
  server_id = local.server_id
  value     = "true"
}

# Read replicas (General Purpose / Memory Optimized only). Replicas cannot have HA.
resource "azurerm_postgresql_flexible_server" "replica" {
  count = var.read_replica_count

  name                          = "${var.name}-r${count.index + 1}"
  resource_group_name           = var.resource_group_name
  location                      = var.location
  create_mode                   = "Replica"
  source_server_id              = local.server_id
  sku_name                      = var.sku_name
  delegated_subnet_id           = var.delegated_subnet_id
  private_dns_zone_id           = var.private_dns_zone_id
  public_network_access_enabled = false
  tags                          = var.tags

  lifecycle {
    ignore_changes = [zone]
  }

  depends_on = [azurerm_postgresql_flexible_server_configuration.extensions]
}

resource "azurerm_monitor_diagnostic_setting" "postgres" {
  count = var.diagnostics_enabled ? 1 : 0

  name                       = "diag-postgres"
  target_resource_id         = local.server_id
  log_analytics_workspace_id = var.log_analytics_workspace_id

  enabled_log {
    category_group = "allLogs"
  }

  enabled_metric {
    category = "AllMetrics"
  }
}

output "database_name" {
  value = azurerm_postgresql_flexible_server_database.app.name
}

output "server_id" {
  value = local.server_id
}

output "server_name" {
  value = local.server_name
}

output "fqdn" {
  description = "Primary host name (private). Use for writes, migrations and admin."
  value       = local.server_fqdn
}

output "replica_fqdns" {
  description = "Read replica host names for the `replica` handle."
  value       = azurerm_postgresql_flexible_server.replica[*].fqdn
}

output "pgbouncer_enabled" {
  value = local.pgbouncer_enabled
}

output "port" {
  description = "Application port: 6432 (PgBouncer, transaction pooling) when available, else 5432."
  value       = local.pgbouncer_enabled ? 6432 : 5432
}

output "administrator_login" {
  value = local.use_password ? var.administrator_login : null
}

output "administrator_password" {
  description = "Only set when password auth is enabled. The composite stores it in Key Vault; it is never printed."
  value       = local.use_password ? random_password.admin[0].result : null
  sensitive   = true
}
